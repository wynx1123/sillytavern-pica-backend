import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile);
const fail=code=>Object.assign(new Error(code),{code});

// Only the plugin's own Git checkout is eligible. No client-supplied paths or URLs.
export function createBackendUpdater({directory=fileURLToPath(new URL('.',import.meta.url)),version}={}){
  let busy=false,restartRequired=false,closed=false;
  const abort=new AbortController();
  async function git(args,cwd=directory){
    try{return (await execute('git',['-c','core.hooksPath=','-c','core.fsmonitor=false',...args],{cwd,windowsHide:true,timeout:60000,maxBuffer:1024*1024,signal:abort.signal,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();}
    catch{throw fail('backend_git_failed');}
  }
  const startupHead=git(['rev-parse','HEAD']).catch(()=>null);
  async function inspect(){
    if(closed)throw fail('backend_update_closed');
    let root;
    try{root=await realpath(await git(['rev-parse','--show-toplevel']));}catch{throw fail('backend_not_git');}
    const own=await realpath(directory),parent=await realpath(path.dirname(own));
    // Supports either server-plugin as a standalone repo, or the documented root wrapper.
    if(root!==own){
      if(root!==parent||path.basename(own)!=='server-plugin')throw fail('backend_wrong_repository');
      let entry='';try{entry=await readFile(path.join(root,'index.mjs'),'utf8');}catch{}
      if(!/from\s+['"]\.\/server-plugin\/index\.mjs['"]/.test(entry))throw fail('backend_wrong_repository');
    }
    const origin=await git(['config','--get','remote.origin.url'],root);
    let remote;try{remote=new URL(origin);}catch{throw fail('backend_origin_unsupported');}
    if(remote.protocol!=='https:'||remote.hostname!=='github.com'||remote.port||remote.username||remote.password||remote.search||remote.hash||!/^\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(remote.pathname))throw fail('backend_origin_unsupported');
    const head=await git(['rev-parse','HEAD'],root);
    const initial=await startupHead;if(initial&&head!==initial)restartRequired=true;
    if(await git(['status','--porcelain','--untracked-files=all'],root))throw fail('backend_worktree_dirty');
    let upstream;try{upstream=await git(['rev-parse','--symbolic-full-name','@{upstream}'],root);}catch{throw fail('backend_tracking_missing');}
    if(!upstream.startsWith('refs/remotes/origin/'))throw fail('backend_tracking_missing');
    return {root,head,upstream};
  }
  async function status(){
    try{await inspect();return {version,available:true,busy,restartRequired};}
    catch(error){return {version,available:false,busy,restartRequired,reason:error.code||'backend_git_failed'};}
  }
  async function update(){
    if(busy)throw fail('backend_update_busy');
    busy=true;
    try{
      const before=await inspect();
      await git(['fetch','--no-tags','--no-recurse-submodules','origin'],before.root);
      const current=await inspect();
      if(current.head!==before.head||current.upstream!==before.upstream)throw fail('backend_repository_changed');
      const target=await git(['rev-parse','--verify',current.upstream+'^{commit}'],current.root);
      if(target===current.head)return {version,updated:false,restartRequired};
      try{await git(['merge-base','--is-ancestor',current.head,target],current.root);}catch{throw fail('backend_history_diverged');}
      // Fast-forward only; refuse collisions with ignored local settings/cache too.
      await git(['merge','--ff-only','--no-edit','--no-overwrite-ignore',target],current.root);
      restartRequired=true;
      return {version,updated:true,restartRequired:true,previousCommit:current.head.slice(0,12),commit:target.slice(0,12)};
    }finally{busy=false;}
  }
  return {status,update,close(){closed=true;abort.abort();}};
}
