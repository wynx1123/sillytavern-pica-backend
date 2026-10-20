// Host-only native routing. This module is never used by the VPS or Worker.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {Readable} from 'node:stream';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';
import {randomBytes} from 'node:crypto';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';

const INIT_HOSTS=['68.183.234.72','206.189.95.169'];
const TARGETS=new Set(['picaapi.picacomic.com','storage-b.picacomic.com','storage1.picacomic.com','diwodiwo.xyz','img.picacomic.com']);
const ID=/^[a-f0-9]{32}$/;
export function publicIPv4(value){
  if(typeof value!=='string'||net.isIP(value)!==4)return false;
  const [a,b,c]=value.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||
    a===192&&(b===168||b===0||b===2)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
function proxyConfig(value){
  if(!value)return null;
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.pathname!=='/'||url.search||url.hash)throw Error('native_proxy_invalid');
  return url;
}
// CONNECT uses the saved IP; TLS and HTTP still identify the original hostname.
function connectTarget(ip,port,hostname,secure,proxy,signal){
  return new Promise((resolve,reject)=>{
    let socket,request,finished=false;
    const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    const fail=()=>{if(finished)return;finished=true;clean();socket?.destroy();request?.destroy();reject(Error(signal?.aborted?'native_cancelled':'native_connection_failed'));};
    const abort=()=>fail(),timer=setTimeout(fail,8000);timer.unref?.();
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)return fail();
    const ready=raw=>{
      socket=raw;raw.once('error',fail);
      const done=()=>{if(finished){socket.destroy();return;}finished=true;clean();socket.removeListener('error',fail);resolve(socket);};
      if(secure){socket=tls.connect({socket:raw,servername:hostname,rejectUnauthorized:true},done);socket.once('error',fail);}
      else done();
    };
    if(!proxy){socket=net.connect({host:ip,port});socket.once('error',fail);socket.once('connect',()=>ready(socket));return;}
    const authority=ip+':'+port,headers={Host:authority};
    if(proxy.username||proxy.password)headers['Proxy-Authorization']='Basic '+Buffer.from(decodeURIComponent(proxy.username)+':'+decodeURIComponent(proxy.password)).toString('base64');
    request=(proxy.protocol==='https:'?https:http).request({hostname:proxy.hostname,port:proxy.port||(proxy.protocol==='https:'?443:80),method:'CONNECT',path:authority,headers});
    request.once('error',fail);
    request.once('connect',(response,raw,head)=>{socket=raw;if(response.statusCode!==200)return fail();if(head.length)raw.unshift(head);ready(raw);});
    request.end();
  });
}
function transport({addresses,proxyUrl='',initialization=false}={}){
  const proxy=proxyConfig(proxyUrl),agents=new Set();let closed=false;
  return {
    fetch(target,options={}){
      const url=new URL(target);
      if(closed||url.username||url.password||url.port||url.hash||
        (initialization?url.protocol!=='http:'||!INIT_HOSTS.includes(url.hostname)||url.pathname!=='/init'||url.search:
          url.protocol!=='https:'||!TARGETS.has(url.hostname)))return Promise.reject(Error('native_target_rejected'));
      if(options.signal?.aborted)return Promise.reject(Error('native_cancelled'));
      const secure=url.protocol==='https:',agent=secure?new https.Agent():new http.Agent();agents.add(agent);
      agent.createConnection=(_options,callback)=>{
        const ips=initialization?[url.hostname]:addresses;
        (async()=>{for(let index=0;index<ips.length;index++){
          try{return await connectTarget(ips[index],secure?443:80,url.hostname,secure,proxy,options.signal);}
          catch(e){if(options.signal?.aborted||index===ips.length-1)throw e;}
        }})().then(socket=>callback(null,socket),callback);
      };
      return new Promise((resolve,reject)=>{
        const release=()=>{agents.delete(agent);agent.destroy();};
        const request=(secure?https:http).request(url,{method:options.method||'GET',headers:Object.fromEntries(new Headers(options.headers)),agent,signal:options.signal},response=>{
          const headers=new Headers();for(const [name,value] of Object.entries(response.headers)){if(Array.isArray(value))for(const v of value)headers.append(name,v);else if(value!==undefined)headers.set(name,value);}
          let stream=response;const encoding=headers.get('content-encoding');
          const unzip=encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():null;
          if(unzip){response.once('error',e=>unzip.destroy(e));response.pipe(unzip);stream=unzip;headers.delete('content-encoding');headers.delete('content-length');}
          stream.once('close',release);
          if(options.method==='HEAD'||[204,205,304].includes(response.statusCode)){response.resume();resolve(new Response(null,{status:response.statusCode,headers}));}
          else resolve(new Response(Readable.toWeb(stream),{status:response.statusCode,headers}));
        });
        request.once('error',()=>{release();reject(Error(options.signal?.aborted?'native_cancelled':'native_request_failed'));});request.end(options.body);
      });
    },
    close(){closed=true;for(const agent of agents)agent.destroy();agents.clear();},
  };
}
export const createNativeTransport=(addresses,options={})=>{
  if(!Array.isArray(addresses)||!addresses.length||addresses.length>16||!addresses.every(publicIPv4))throw Error('native_addresses_invalid');
  return transport({addresses:[...addresses],...options,initialization:false});
};
export async function obtainNativeAddresses({proxyUrl='',signal,fetchInit}={}){
  const client=transport({proxyUrl,initialization:true});
  try{
    for(const host of INIT_HOSTS){
      if(signal?.aborted)throw Error('native_cancelled');
      try{
        const response=await (fetchInit||client.fetch)('http://'+host+'/init',{method:'GET',headers:{Accept:'application/json','User-Agent':'okhttp/3.8.1'},signal,redirect:'manual'});
        if(response.status!==200){await response.body?.cancel();continue;}
        const reader=response.body.getReader(),parts=[];let size=0;
        for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw Error('native_init_too_large');}parts.push(value);}
        const data=JSON.parse(Buffer.concat(parts).toString('utf8'));
        if(String(data.status).toLowerCase()!=='ok'||!Array.isArray(data.addresses)||!data.addresses.length||data.addresses.length>16||!data.addresses.every(publicIPv4))throw Error('native_addresses_invalid');
        return [...new Set(data.addresses)];
      }catch{if(signal?.aborted)throw Error('native_cancelled');}
    }
    throw Error('native_init_unavailable');
  }finally{client.close();}
}
export async function createNativeProfiles({stateFile,proxyUrl='',obtain=obtainNativeAddresses,makeTransport=createNativeTransport,maxProfiles=64}={}){
  const rows=new Map();let serial=Promise.resolve(),closed=false;
  try{
    const state=JSON.parse(await readFile(stateFile,'utf8'));
    if(state.version!==1||!Array.isArray(state.profiles)||state.profiles.length>maxProfiles)throw Error('native_state_invalid');
    for(const row of state.profiles){if(!ID.test(row.id)||rows.has(row.id)||!Number.isFinite(row.createdAt))throw Error('native_state_invalid');rows.set(row.id,{...row,transport:makeTransport(row.addresses,{proxyUrl})});}
  }catch(e){if(e.code!=='ENOENT')throw Error('native_state_invalid');}
  const save=async()=>{await mkdir(path.dirname(stateFile),{recursive:true});const temp=stateFile+'.tmp';await writeFile(temp,JSON.stringify({version:1,profiles:[...rows.values()].map(({id,createdAt,addresses})=>({id,createdAt,addresses}))}),{mode:0o600});await rename(temp,stateFile);};
  const locked=action=>{const task=serial.then(action);serial=task.catch(()=>{});return task;};
  return {
    select({id,signal}={}){return locked(async()=>{
      if(closed||signal?.aborted)throw Error('native_cancelled');
      if(id){const row=rows.get(id);if(!row||!ID.test(id))throw Error('native_profile_missing');return {id:row.id,createdAt:row.createdAt};}
      if(rows.size>=maxProfiles)throw Error('native_profiles_full');
      const addresses=await obtain({proxyUrl,signal});if(closed||signal?.aborted)throw Error('native_cancelled');
      const row={id:randomBytes(16).toString('hex'),createdAt:Date.now(),addresses,transport:makeTransport(addresses,{proxyUrl})};rows.set(row.id,row);
      try{await save();}catch{rows.delete(row.id);row.transport.close();throw Error('native_state_write_failed');}
      if(closed||signal?.aborted){rows.delete(row.id);row.transport.close();await save();throw Error('native_cancelled');}
      return {id:row.id,createdAt:row.createdAt};
    });},
    get(id){return !closed&&ID.test(id||'')?rows.get(id)?.transport:null;},
    release(id){return locked(async()=>{const row=rows.get(id);if(!row)return;rows.delete(id);try{await save();}catch{rows.set(id,row);throw Error('native_state_write_failed');}row.transport.close();});},
    close(){closed=true;for(const row of rows.values())row.transport.close();},
  };
}
