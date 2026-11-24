import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat, mkdtemp } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

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
async function git(cwd,args) {
  try { return (await exec('git',['-C',cwd,...args],{shell:false,windowsHide:true,timeout:30000,maxBuffer:1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})).stdout.trim(); }
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
  const parent=await mkdtemp(join(tmpdir(),'pacc-worktree-'));
  const cwd=join(parent,'workspace'),branch='pacc/'+id;
  // New branch and directory only; never force, clean, reset, merge or push.
  await git(root,['worktree','add','-b',branch,cwd,'HEAD']);
  return {cwd:await directory(cwd),branch};
}
