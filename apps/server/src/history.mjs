import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class HistoryStore {
  constructor(path) {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(session_id UNINDEXED, message_id UNINDEXED, body, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.cached=new Map(this.db.prepare('SELECT id,data FROM sessions').all().map(r=>[r.id,r.data]));
  }
  load(){
    return {initialized:!!this.db.prepare("SELECT value FROM metadata WHERE key='initialized'").get(),
      projects:this.db.prepare('SELECT data FROM projects ORDER BY rowid').all().map(r=>JSON.parse(r.data)),
      tasks:this.db.prepare('SELECT data FROM tasks ORDER BY rowid').all().map(r=>JSON.parse(r.data)),
      sessions:this.db.prepare('SELECT data FROM sessions ORDER BY rowid').all().map(r=>JSON.parse(r.data))};
  }
  save(projects,sessions,tasks){
    const next=new Map(sessions.map(s=>[s.id,JSON.stringify(s)]));
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare("INSERT OR IGNORE INTO metadata VALUES('initialized','1')").run();
      this.db.exec('DELETE FROM projects');
      const project=this.db.prepare('INSERT INTO projects VALUES(?,?)');
      for(const p of projects)project.run(p.id,JSON.stringify(p));
      const remove=this.db.prepare('DELETE FROM sessions WHERE id=?');
      const removeIndex=this.db.prepare('DELETE FROM history_fts WHERE session_id=?');
      const upsert=this.db.prepare('INSERT INTO sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
      const insert=this.db.prepare('INSERT INTO history_fts(session_id,message_id,body) VALUES(?,?,?)');
      for(const id of this.cached.keys())if(!next.has(id)){remove.run(id);removeIndex.run(id);}
      for(const s of sessions){
        const data=next.get(s.id);
        if(data===this.cached.get(s.id))continue;
        upsert.run(s.id,data);removeIndex.run(s.id);
        for(const message of s.saved.messages||[])if(typeof message.text==='string')insert.run(s.id,message.id,message.text);
      }
      if(tasks!==undefined){
        this.db.exec('DELETE FROM tasks');
        const insertTask=this.db.prepare('INSERT INTO tasks VALUES(?,?)');
        for(const t of tasks)insertTask.run(t.id,JSON.stringify(t));
      }
      this.db.exec('COMMIT');this.cached=next;
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
