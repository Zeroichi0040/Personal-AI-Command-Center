import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export const SCHEMA_VERSION=1;
const rows=(db,table)=>new Map(db.prepare('SELECT id,data FROM '+table).all().map(r=>[r.id,r.data]));
const encode=records=>new Map(records.map(r=>[r.id,JSON.stringify(r)]));
function syncRows(db,table,old,next){const remove=db.prepare('DELETE FROM '+table+' WHERE id=?'),upsert=db.prepare('INSERT INTO '+table+' VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');for(const id of old.keys())if(!next.has(id))remove.run(id);for(const [id,data] of next)if(old.get(id)!==data)upsert.run(id,data);}

export class HistoryStore {
  constructor(path) {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.path=path;this.db=new DatabaseSync(path);
    try{
    if(path!==':memory:'&&process.platform!=='win32')chmodSync(path,0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version=this.db.prepare('PRAGMA user_version').get().user_version;
    if(version>SCHEMA_VERSION)throw Error('History database requires a newer PACC version');
    if(version<SCHEMA_VERSION){
      if(path!==':memory:'&&this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get())this.migrationBackup=this.backup('migration');
      this.db.exec('BEGIN IMMEDIATE');
      try{this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(session_id UNINDEXED, message_id UNINDEXED, body, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;
    `);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    }
    this.cached=rows(this.db,'sessions');this.projects=rows(this.db,'projects');this.tasks=rows(this.db,'tasks');
    }catch(e){this.db.close();throw e;}
  }
  backup(kind='manual'){
    if(this.path===':memory:')throw Error('Cannot back up in-memory history');
    const destination=this.path+'.'+kind+'-'+randomUUID()+'.sqlite';
    this.db.prepare('VACUUM INTO ?').run(destination);
    if(process.platform!=='win32')chmodSync(destination,0o600);
    return destination;
  }
  load(){
    return {initialized:!!this.db.prepare("SELECT value FROM metadata WHERE key='initialized'").get(),
      projects:this.db.prepare('SELECT data FROM projects ORDER BY rowid').all().map(r=>JSON.parse(r.data)),
      tasks:this.db.prepare('SELECT data FROM tasks ORDER BY rowid').all().map(r=>JSON.parse(r.data)),
      sessions:this.db.prepare('SELECT data FROM sessions ORDER BY rowid').all().map(r=>JSON.parse(r.data))};
  }
  save(projects,sessions,tasks){
    const next=encode(sessions),nextProjects=encode(projects),nextTasks=tasks===undefined?this.tasks:encode(tasks);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare("INSERT OR IGNORE INTO metadata VALUES('initialized','1')").run();
      syncRows(this.db,'projects',this.projects,nextProjects);
      syncRows(this.db,'sessions',this.cached,next);
      syncRows(this.db,'tasks',this.tasks,nextTasks);
      const removeIndex=this.db.prepare('DELETE FROM history_fts WHERE session_id=?');
      const removeMessage=this.db.prepare('DELETE FROM history_fts WHERE session_id=? AND message_id=?');
      const insert=this.db.prepare('INSERT INTO history_fts(session_id,message_id,body) VALUES(?,?,?)');
      for(const id of this.cached.keys())if(!next.has(id))removeIndex.run(id);
      for(const s of sessions){
        if(next.get(s.id)===this.cached.get(s.id))continue;
        const old=this.cached.has(s.id)?JSON.parse(this.cached.get(s.id)).saved.messages||[]:[];
        const previous=new Map(old.map(x=>[x.id,x.text]));
        const current=new Map((s.saved.messages||[]).filter(x=>typeof x.text==='string').map(x=>[x.id,x.text]));
        for(const id of previous.keys())if(!current.has(id))removeMessage.run(s.id,id);
        for(const [id,body] of current)if(previous.get(id)!==body){removeMessage.run(s.id,id);insert.run(s.id,id,body);}
      }
      this.db.exec('COMMIT');this.cached=next;this.projects=nextProjects;this.tasks=nextTasks;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  search(query){
    if(typeof query!=='string'||query.length>300)throw Error('Search must be at most 300 characters');
    const terms=query.trim().split(/\s+/u).filter(term=>/[\p{L}\p{N}]/u.test(term)).slice(0,12);
    if(!terms.length)return [];
    const expression=terms.map(term=>'"'+term.replaceAll('"','""')+'"').join(' AND ');
    return this.db.prepare("SELECT session_id AS sessionId,message_id AS messageId,snippet(history_fts,2,'','', ' … ',24) AS snippet FROM history_fts WHERE history_fts MATCH ? ORDER BY rank LIMIT 50").all(expression);
  }
  close(){this.db.close();}
}
