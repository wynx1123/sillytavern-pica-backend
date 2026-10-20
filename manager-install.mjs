import {readFile,writeFile,mkdir,lstat,realpath,rename,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const MANAGER_FILES=['manifest.json','index.js','style.css','security.js','installer.mjs'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
async function optional(file){try{return await readFile(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function safeDirectory(base,relative){
  let current=base;
  for(const part of relative.split('/')){current=path.join(current,part);try{if(!(await lstat(current)).isDirectory()||(await lstat(current)).isSymbolicLink())throw fail('manager_path_unsafe');}catch(e){if(e.code!=='ENOENT')throw e;await mkdir(current);}}
  return current;
}
async function safeRead(file){try{const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink())throw fail('manager_path_unsafe');return readFile(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function atomic(file,bytes){const tmp=file+'.tmp-'+randomUUID();try{await writeFile(tmp,bytes,{flag:'wx'});await rename(tmp,file);}finally{await unlink(tmp).catch(()=>{});}}
export async function installBundledManager({pluginDir=fileURLToPath(new URL('.',import.meta.url))}={}){
  const bundled=await optional(path.join(pluginDir,'manager-files.json'));
  if(!bundled)return {bundled:false,changed:false};
  const own=await realpath(pluginDir),plugins=path.dirname(own),host=path.dirname(plugins);
  if(path.basename(plugins)!=='plugins')throw fail('manager_host_invalid');
  const pkg=JSON.parse(await readFile(path.join(host,'package.json'),'utf8'));
  if(pkg.name!=='sillytavern'||!(await lstat(path.join(host,'src/plugin-loader.js'))).isFile())throw fail('manager_host_invalid');
  const catalog=JSON.parse(bundled),source=new Map();
  if(catalog.id!=='pica-relay-manager'||Object.keys(catalog.files).sort().join()!==[...MANAGER_FILES].sort().join())throw fail('manager_bundle_invalid');
  for(const name of MANAGER_FILES){const bytes=await safeRead(path.join(own,'manager-extension',name));if(!bytes||hash(bytes)!==catalog.files[name])throw fail('manager_bundle_invalid');source.set(name,bytes);}
  const cache=await safeDirectory(own,'cache'),lock=path.join(cache,'manager-install.lock');
  try{await writeFile(lock,'installing',{flag:'wx'});}catch(e){if(e.code==='EEXIST')throw fail('manager_install_busy');throw e;}
  try{
    const target=await safeDirectory(host,'public/scripts/extensions/third-party/pica-relay-manager');
    const stateFile=path.join(cache,'manager-install.json'),stateBytes=await safeRead(stateFile),state=stateBytes?JSON.parse(stateBytes):{files:{}};
    const original=new Map(),changed=[];
    for(const name of MANAGER_FILES){
      const bytes=await safeRead(path.join(target,name));original.set(name,bytes);
      if(bytes?.equals(source.get(name)))continue;
      if(bytes&&hash(bytes)!==state.files?.[name]&&!(catalog.previous?.[name]||[]).includes(hash(bytes)))throw fail('manager_local_changes');
      changed.push(name);
    }
    if(changed.length){
      if(changed.some(name=>original.get(name))){const backup=await safeDirectory(cache,'manager-backups/'+randomUUID());for(const name of changed)if(original.get(name))await writeFile(path.join(backup,name),original.get(name),{flag:'wx'});}
      const written=[];
      try{
        for(const name of changed){const file=path.join(target,name),observed=await safeRead(file),before=original.get(name);if(before?!observed?.equals(before):observed!==null)throw fail('manager_local_changes');await atomic(file,source.get(name));written.push(name);}
      }catch(error){for(const name of written.reverse()){if(original.get(name))await atomic(path.join(target,name),original.get(name));else await unlink(path.join(target,name));}throw error;}
    }
    await atomic(stateFile,JSON.stringify({version:catalog.version,files:catalog.files},null,2)+'\n');
    return {bundled:true,changed:changed.length>0,version:catalog.version};
  }finally{await unlink(lock).catch(()=>{});}
}
