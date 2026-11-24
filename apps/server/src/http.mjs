import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';

export async function buildServer(conversation, { port = 4317, staticRoot } = {}) {
  const app = Fastify({ logger:false, bodyLimit:256_000 });
  const host = '127.0.0.1:' + port;
  const origin = 'http://' + host;
  const token = randomBytes(32).toString('hex');
  const authorized = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && timingSafeEqual(Buffer.from(value,'utf8'),Buffer.from(token,'utf8'));
  await app.register(websocket, { options:{ maxPayload:1024 } });
  app.addHook('onRequest', async (req, reply) => {
    // Exact Host blocks DNS rebinding. Browser mutations and sockets additionally require exact origin.
    if (req.headers.host !== host || req.headers['sec-fetch-site']==='cross-site' || (req.headers.origin && req.headers.origin !== origin)) return reply.code(403).send({ error:'Local origin required' });
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer')
      .header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'self' ws://" + host + "; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.method !== 'GET' && (req.headers.origin !== origin || !authorized(req.headers['x-pacc-token']))) return reply.code(403).send({error:'Unauthorized'});
  });
  app.get('/api/bootstrap', async (_req,reply) => conversation.booting?reply.code(503).send({error:'Starting PACC'}):({ token, state:conversation.snapshot() }));
  app.post('/api/action', async (req, reply) => {
    if(conversation.booting)return reply.code(503).send({error:'Starting PACC'});
    const data = req.body;
    if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.action!=='string')return reply.code(400).send({error:'Expected an action object'});
    try {
      if (typeof conversation.dispatch === 'function') return {ok:true,...await conversation.dispatch(data)};
      switch (data?.action) {
        case 'send': await conversation.send(data); break;
        case 'stop': await conversation.stop(); break;
        case 'steer': await conversation.steer(data); break;
        case 'removeQueued': conversation.removeQueued(data.id); break;
        case 'approval': conversation.resolveApproval(data.id,data.decision); break;
        default: return reply.code(400).send({error:'Unknown action'});
      }
      return {ok:true};
    } catch (error) { return reply.code(400).send({error:String(error.message).slice(0,2000)}); }
  });
  let serialized=null;
  const invalidate=()=>{serialized=null;};
  conversation.on('state',invalidate);
  app.addHook('onClose',async()=>{conversation.off('state',invalidate);});
  const frame=()=>serialized??(serialized=JSON.stringify(conversation.snapshot()));
  app.get('/events', { websocket:true, preValidation:async(req,reply) => {
    if (req.headers.origin !== origin) return reply.code(403).send({error:'Invalid socket origin'});
  } }, socket => {
    let authenticated = false;
    let streamTimer = null;
    const send = () => {
      if (socket.readyState !== 1) return;
      if (socket.bufferedAmount > 2_000_000) { socket.close(1013,'Slow client'); return; }
      socket.send(frame(), err => { if (err) socket.terminate(); });
    };
    const timer = setTimeout(() => socket.close(1008,'Authentication required'),5000);
    const cancelStream = () => { if (streamTimer !== null) clearTimeout(streamTimer); streamTimer = null; };
    const publish = (_state, mode) => {
      if (mode !== 'stream') { cancelStream(); send(); return; }
      if (streamTimer === null) streamTimer = setTimeout(() => { streamTimer = null; send(); },50);
    };
    const cleanup = () => { clearTimeout(timer); cancelStream(); conversation.off('state',publish); };
    socket.on('error',cleanup); socket.on('close',cleanup);
    socket.on('message', raw => {
      if (authenticated || conversation.booting || !authorized(raw.toString())) { socket.close(1008,'Invalid authentication'); return; }
      authenticated = true; clearTimeout(timer); conversation.on('state',publish); send();
    });
  });
  if (staticRoot) await app.register(staticFiles,{root:resolve(staticRoot), index:['index.html']});
  return app;
}
