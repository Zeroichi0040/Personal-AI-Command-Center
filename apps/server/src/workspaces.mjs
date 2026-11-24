import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat, mkdtemp, mkdir } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';

const exec = promisify(execFile);
export async function directory(path) {
  if(typeof path!=='string'||!path.trim()||path.length>4096||!isAbsolute(path)) throw Error('Enter an absolute local directory path');
  const cwd=await realpath(path);
  if(!(await stat(cwd)).isDirectory())throw Error('Workspace must be a directory');
  return cwd;
}
const comparable = value => process.platform==='win32'?value.toLowerCase():value;
export function overlaps(a,b) {
  const inside=(x,y)=>{const r=relative(comparable(x),comparable(y));return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));};
  return inside(a,b)||inside(b,a);
}
export function assertCurrent(cwd){
  if(!statSync(cwd).isDirectory()||comparable(realpathSync(cwd))!==comparable(cwd))throw Error('Workspace changed or is unavailable; reconnect or register it again');
}
async function git(cwd,args) {
  const env={...process.env,GIT_TERMINAL_PROMPT:'0'};
  for(const key of Object.keys(env))if(/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG(?:_.*)?|CEILING_DIRECTORIES|NAMESPACE)$/i.test(key))delete env[key];
  try { return (await exec('git',['-C',cwd,...args],{shell:false,windowsHide:true,timeout:30000,maxBuffer:1024*1024,env})).stdout.trim(); }
  catch(error){throw Error('Git operation failed: '+String(error.stderr||error.message).slice(0,1500));}
}
export async function repoRoot(path) {
  const cwd=await directory(path);
  return directory(await git(cwd,['rev-parse','--show-toplevel']));
}
export async function inspect(cwd) {
  const branch=await git(cwd,['rev-parse','--abbrev-ref','HEAD']);
  const status=await git(cwd,['status','--short','--branch','--untracked-files=normal']);
  const diff=await git(cwd,['diff','--no-ext-diff','--no-textconv','--stat','HEAD','--']);
  return {branch,status,diff};
}
export async function createWorktree(root,id) {
  assertCurrent(root);
  const base=process.env.PACC_WORKTREE_DIR||join(homedir(),'.pacc','worktrees');
  if(!isAbsolute(base))throw Error('PACC_WORKTREE_DIR must be absolute');
  await mkdir(base,{recursive:true,mode:0o700});
  const parent=await mkdtemp(join(await directory(base),'pacc-worktree-'));
  const cwd=join(parent,'workspace'),branch='pacc/'+id;
  // New branch and directory only; never force, clean, reset, merge or push.
  await git(root,['-c','core.hooksPath='+join(parent,'disabled-hooks'),'worktree','add','-b',branch,cwd,'HEAD']);
  return {cwd:await directory(cwd),branch};
}
