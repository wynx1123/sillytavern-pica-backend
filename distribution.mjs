import {createHash, createPublicKey, verify, randomUUID} from 'node:crypto';
import {readFile, writeFile, mkdir, rename, stat} from 'node:fs/promises';
import path from 'node:path';

export const LIMITS={manifest:65536,module:2*1024*1024,script:3*1024*1024};
const version=/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function verifyRelease(text,profile){
  if(Buffer.byteLength(text)>LIMITS.manifest)throw Error('manifest_too_large');
  const e=JSON.parse(text),raw=Buffer.from(profile.publicKey,'base64');
  if(raw.length!==32||typeof e.payload!=='string'||typeof e.signature!=='string'||Buffer.byteLength(e.payload)>60000)throw Error('invalid_signature');
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]),format:'der',type:'spki'});
  if(!verify(null,Buffer.from(e.payload),key,Buffer.from(e.signature,'base64')))throw Error('invalid_signature');
  const m=JSON.parse(e.payload);
  if(m.project!==profile.project||m.schemaVersion!==1||!version.test(m.version)||m.loaderApi!==1||m.dataSchema!==1||typeof m.notes!=='string'||m.notes.length>4000||!Number.isFinite(Date.parse(m.publishedAt)))throw Error('invalid_release');
  for(const [kind,item,entry] of [['module',m,`releases/${m.version}/app.mjs`],['script',m.script,`releases/${m.version}/script.json`]]){
    if(!item||item.entry!==entry||!Number.isInteger(item.bytes)||item.bytes<1||item.bytes>LIMITS[kind]||!/^[a-f0-9]{64}$/.test(item.sha256))throw Error('invalid_artifact');
  }
  return m;
}
export function verifyArtifact(data,descriptor){if(data.length!==descriptor.bytes||digest(data)!==descriptor.sha256)throw Error('artifact_integrity_failed');return data;}

export function createDistributor({profile,cacheDir,fetchImpl=globalThis.fetch,now=Date.now}){
  let cached=null,lastCheck=0,refreshing=null,closed=false;const controllers=new Set();
  let source='';
  if(profile.sourceBase){const u=new URL(profile.sourceBase);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!u.pathname.endsWith('/'))throw Error('invalid_release_source');source=u.href;}
  const resolve=relative=>path.join(cacheDir,...relative.split('/'));
  async function read(relative,limit){const file=resolve(relative),s=await stat(file);if(!s.isFile()||s.size>limit)throw Error('invalid_cache');return readFile(file);}
  async function persist(relative,data,{immutable=false}={}){
    if(closed)throw Error('closed');const file=resolve(relative);await mkdir(path.dirname(file),{recursive:true});
    if(immutable){try{const old=await readFile(file);if(!old.equals(data))throw Error('immutable_release_conflict');return;}catch(e){if(e.code!=='ENOENT')throw e;}await writeFile(file,data,{flag:'wx'});return;}
    const temp=file+'.tmp-'+randomUUID();try{await writeFile(temp,data,{flag:'wx'});await rename(temp,file);}finally{const {unlink}=await import('node:fs/promises');await unlink(temp).catch(()=>{});}
  }
  async function fetchBytes(relative,limit){
    const c=new AbortController();controllers.add(c);const timer=setTimeout(()=>c.abort(),15000);timer.unref?.();
    try{
      const r=await fetchImpl(new URL(relative,source),{redirect:'error',credentials:'omit',signal:c.signal,headers:{Accept:'application/json, text/javascript'}});
      if(!r.ok||Number(r.headers.get('content-length'))>limit)throw Error('release_download_failed');
      const parts=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>limit)throw Error('release_too_large');parts.push(chunk);}return Buffer.concat(parts);
    }finally{clearTimeout(timer);c.abort();controllers.delete(c);}
  }
  async function loadCached(){const bytes=await read('channels/stable.json',LIMITS.manifest),m=verifyRelease(bytes.toString('utf8'),profile);cached={bytes,manifest:m};return cached;}
  async function refresh(){
    if(closed)throw Error('closed');
    if(!source)return loadCached();
    if(cached&&now()-lastCheck<60000)return cached;
    if(refreshing)return refreshing;
    refreshing=(async()=>{
      try{
        const bytes=await fetchBytes('channels/stable.json',LIMITS.manifest),channel=JSON.parse(bytes.toString('utf8'));
        // This marker is not a release: it can only report absence, never authorize code.
        if(channel.project===profile.project&&channel.schemaVersion===1&&channel.state==='unpublished'&&!channel.payload)throw Error('reader_not_published');
        const m=verifyRelease(bytes.toString('utf8'),profile);
        for(const [desc,limit] of [[m,LIMITS.module],[m.script,LIMITS.script]]){
          let data;try{data=verifyArtifact(await read(desc.entry,limit),desc);}catch{data=verifyArtifact(await fetchBytes(desc.entry,limit),desc);}
          await persist(desc.entry,data,{immutable:true});
        }
        await persist(`releases/${m.version}/release.json`,bytes,{immutable:true});
        await persist('channels/stable.json',bytes);cached={bytes,manifest:m};lastCheck=now();return cached;
      }catch(e){lastCheck=now();try{return await loadCached();}catch{throw e;}}
    })();try{return await refreshing;}finally{refreshing=null;}
  }
  return {
    async status(){try{const c=await loadCached();return {ready:true,version:c.manifest.version,sourceConfigured:!!source};}catch{return {ready:false,version:'',sourceConfigured:!!source};}},
    async channel(){return (await refresh()).bytes;},
    async artifact(v,file){
      if(!version.test(v)||!['app.mjs','script.json'].includes(file))throw Error('invalid_artifact_path');
      const m=verifyRelease((await read(`releases/${v}/release.json`,LIMITS.manifest)).toString('utf8'),profile);
      return verifyArtifact(await read(`releases/${v}/${file}`,file==='app.mjs'?LIMITS.module:LIMITS.script),file==='app.mjs'?m:m.script);
    },
    close(){closed=true;for(const c of controllers)c.abort();controllers.clear();}
  };
}
