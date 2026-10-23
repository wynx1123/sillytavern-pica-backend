import {Readable} from 'node:stream';
import {capabilities, reply, forwardPica, VERSION, SERVICE} from './core.mjs';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createDistributor} from './distribution.mjs';
import {createProxyTransport} from './network.mjs';
import {IMAGE_HOSTS,forwardImage} from './images.mjs';
import {createNativeProfiles} from './native-route.mjs';
import {createBackendUpdater} from './updater.mjs';
import {installBundledManager} from './manager-install.mjs';
import {createDiskCache} from './cache.mjs';
export const info={id:'pica-relay',name:'Pica Tavern Relay',description:'Fixed-upstream Pica relay using the host authentication.'};
const active=new Set(),images=new Set();let closing=false,distribution=null,transport=null,native=null,updater=null,cache=null;
const PLUGIN_VERSION='1.1.0';
const CACHE_CONFIG=new URL('./cache.local.json',import.meta.url);
const DEFAULT_CACHE={enabled:true,maxBytes:512*1024*1024,imageTtlDays:7,apiTtlSeconds:180};
function readCacheConfig(){
  let saved={};try{saved=JSON.parse(readFileSync(CACHE_CONFIG,'utf8'));}catch(e){if(e.code!=='ENOENT')console.warn('[pica-relay:cache] 配置读取失败，使用默认值。');}
  const config={...DEFAULT_CACHE,...(saved&&typeof saved==='object'&&!Array.isArray(saved)?saved:{})};
  if(process.env.PICA_CACHE==='0')config.enabled=false;else if(process.env.PICA_CACHE==='1')config.enabled=true;
  const envMax=Number(process.env.PICA_CACHE_MAX_MB);if(Number.isFinite(envMax)&&envMax>0)config.maxBytes=envMax*1024*1024;
  config.maxBytes=Math.max(8*1024*1024,Math.min(8*1024*1024*1024,Number(config.maxBytes)||DEFAULT_CACHE.maxBytes));
  config.imageTtlDays=Math.max(1,Math.min(365,Number(config.imageTtlDays)||DEFAULT_CACHE.imageTtlDays));
  config.apiTtlSeconds=Math.max(0,Math.min(86400,Number(config.apiTtlSeconds)||DEFAULT_CACHE.apiTtlSeconds));
  config.enabled=config.enabled!==false;
  return config;
}
function publicCacheConfig(config){return {enabled:cache?.enabled??config.enabled,maxBytes:cache?.maxBytes??config.maxBytes,imageTtlDays:config.imageTtlDays,apiTtlSeconds:config.apiTtlSeconds,dir:'cache/relay/'};}
function saveCacheConfig(patch){
  const saved={};try{Object.assign(saved,JSON.parse(readFileSync(CACHE_CONFIG,'utf8')));}catch{}
  const next={...saved,...patch};
  writeFileSync(CACHE_CONFIG,JSON.stringify(next,null,2)+'\n',{mode:0o600});
  return next;
}
const adminOnly=(req,res)=>{if(req.user?.profile?.admin!==true){res.status(403).json({error:'backend_admin_required'});return false;}return true;};
// The host supplies its authenticated router. Never mount a second public server.
export async function init(router,{nativeOptions={},updateOptions={}}={}){
  closing=false;
  try{const manager=await installBundledManager();if(manager.changed)console.log('[pica-relay] 管理栏已安装或更新，请刷新酒馆页面。');}catch{console.warn('[pica-relay] 管理栏自动安装未完成，原文件已保留；请运行插件目录中的 install.mjs。');}
  const profile=JSON.parse(readFileSync(new URL('./distribution-profile.json',import.meta.url),'utf8'));
  const cacheConfig=readCacheConfig();
  try{cache=createDiskCache({dir:process.env.PICA_CACHE_DIR||fileURLToPath(new URL('./cache/relay/',import.meta.url)),maxBytes:cacheConfig.maxBytes,imageTtlMs:cacheConfig.imageTtlDays*86400000,apiTtlMs:cacheConfig.apiTtlSeconds*1000,enabled:cacheConfig.enabled});await cache.init();}
  catch(error){cache=null;console.warn('[pica-relay:cache] 缓存不可用，继续直连：'+(error?.message||error));}
  let network={};try{network=JSON.parse(readFileSync(new URL('./network.local.json',import.meta.url),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  transport=network.httpsProxy?createProxyTransport(network.httpsProxy):null;
  try{native=await createNativeProfiles({stateFile:fileURLToPath(new URL('./native-routes.local.json',import.meta.url)),proxyUrl:network.httpsProxy||'',...nativeOptions});}catch{native=null;}
  distribution=createDistributor({profile,cacheDir:fileURLToPath(new URL('./cache/',import.meta.url)),fetchImpl:transport?transport.fetch:globalThis.fetch});
  updater=createBackendUpdater({...updateOptions,version:PLUGIN_VERSION});
  router.get('/maintenance/status',async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(req.user?.profile?.admin!==true)return res.status(403).json({error:'backend_admin_required'});
    res.json(await updater.status());
  });
  router.post('/maintenance/update',async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(req.user?.profile?.admin!==true)return res.status(403).json({error:'backend_admin_required'});
    if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length)return res.status(400).json({error:'backend_update_body_invalid'});
    if(closing)return res.status(503).json({error:'backend_update_closed'});
    try{res.json(await updater.update());}
    catch(error){res.status(error.code==='backend_update_busy'?409:503).json({error:error.code?.startsWith('backend_')?error.code:'backend_git_failed'});}
  });
  router.get('/capabilities',async(_req,res)=>res.set('Cache-Control','no-store').json({...capabilities(['host'],!closing),version:PLUGIN_VERSION,networkMode:transport?'configured-proxy':'direct',cache:{version:1,enabled:cache?.enabled===true},nativeRouting:{version:1,available:!!native,selectPath:'/native-route/select',releasePath:'/native-route/release',prefix:'/native/'},imageProxy:{version:1,path:'/image/',hosts:IMAGE_HOSTS},distribution:{protocolVersion:1,...await distribution.status()}}));
  router.get('/health',(_req,res)=>res.set('Cache-Control','no-store').json({service:SERVICE,version:PLUGIN_VERSION,ready:!closing,networkMode:transport?'configured-proxy':'direct'}));
  router.get('/cache/status',async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(!adminOnly(req,res))return;
    if(!cache)return res.status(503).json({error:'cache_unavailable',config:publicCacheConfig(readCacheConfig())});
    res.json({...cache.stats(),config:publicCacheConfig(readCacheConfig())});
  });
  router.post('/cache/config',async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(!adminOnly(req,res))return;
    const body=req.body;
    if(!body||typeof body!=='object'||Array.isArray(body))return res.status(400).json({error:'cache_config_invalid'});
    const allowed=new Set(['enabled','maxBytes','imageTtlDays','apiTtlSeconds']);
    if(Object.keys(body).some(key=>!allowed.has(key)))return res.status(400).json({error:'cache_config_invalid'});
    const patch={};
    if('enabled' in body){if(typeof body.enabled!=='boolean')return res.status(400).json({error:'cache_config_invalid'});patch.enabled=body.enabled;}
    if('maxBytes' in body){const value=Number(body.maxBytes);if(!Number.isFinite(value)||value<8*1024*1024||value>8*1024*1024*1024)return res.status(400).json({error:'cache_config_invalid'});patch.maxBytes=Math.floor(value);}
    if('imageTtlDays' in body){const value=Number(body.imageTtlDays);if(!Number.isFinite(value)||value<1||value>365)return res.status(400).json({error:'cache_config_invalid'});patch.imageTtlDays=Math.floor(value);}
    if('apiTtlSeconds' in body){const value=Number(body.apiTtlSeconds);if(!Number.isFinite(value)||value<0||value>86400)return res.status(400).json({error:'cache_config_invalid'});patch.apiTtlSeconds=Math.floor(value);}
    if(!Object.keys(patch).length)return res.status(400).json({error:'cache_config_invalid'});
    try{saveCacheConfig(patch);}catch{return res.status(503).json({error:'cache_config_write_failed'});}
    if(cache){
      if('enabled' in patch)cache.setEnabled(patch.enabled);
      if('maxBytes' in patch)cache.setMaxBytes(patch.maxBytes);
      if('imageTtlDays' in patch)cache.setImageTtlMs(patch.imageTtlDays*86400000);
      if('apiTtlSeconds' in patch)cache.setApiTtlMs(patch.apiTtlSeconds*1000);
    }
    res.json({ok:true,...(cache?cache.stats():{}),config:publicCacheConfig(readCacheConfig())});
  });
  router.post('/cache/clear',async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(!adminOnly(req,res))return;
    if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length)return res.status(400).json({error:'cache_clear_body_invalid'});
    if(!cache)return res.status(503).json({error:'cache_unavailable'});
    try{await cache.clear();res.json({ok:true,...cache.stats()});}
    catch{res.status(503).json({error:'cache_clear_failed'});}
  });
  router.get('/reader/releases/:version/:file',async(req,res)=>{try{const data=await distribution.artifact(req.params.version,req.params.file);res.set({'Content-Type':req.params.file==='app.mjs'?'text/javascript; charset=utf-8':'application/json; charset=utf-8','Cache-Control':'private, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'}).send(data);}catch{res.status(404).json({error:'reader_artifact_unavailable'});}});
  router.post('/native-route/select',async(req,res)=>{
    const abort=new AbortController(),cancel=()=>{if(!res.writableEnded)abort.abort();};res.once('close',cancel);active.add(abort);
    try{
      if(closing||!native)return res.status(503).json({error:closing?'relay_busy':'native_state_invalid'});
      const body=req.body||{};
      if(Object.keys(body).some(k=>k!=='id')||body.id!==undefined&&!/^[a-f0-9]{32}$/.test(body.id))return res.status(400).json({error:'native_selection_invalid'});
      const result=await native.select({id:body.id,signal:abort.signal});res.set('Cache-Control','no-store').json(result);
    }catch(e){if(!res.destroyed)res.status(e.message==='native_profile_missing'?410:503).set('Cache-Control','no-store').json({error:e.message.startsWith('native_')?e.message:'native_init_unavailable'});}
    finally{active.delete(abort);res.removeListener('close',cancel);}
  });
  router.post('/native-route/release',async(req,res)=>{
    if(!/^[a-f0-9]{32}$/.test(req.body?.id||''))return res.status(400).json({error:'native_selection_invalid'});
    try{if(!native)throw Error();await native.release(req.body.id);res.set('Cache-Control','no-store').json({ok:true});}catch{res.status(503).json({error:'native_state_write_failed'});}
  });
  router.use(async(req,res)=>{
    const abort=new AbortController(),cancel=()=>{if(!res.writableEnded)abort.abort();};
    let targetPath=req.url,fetchImpl=transport?transport.fetch:globalThis.fetch;
    const nativeMatch=/^\/native\/([a-f0-9]{32})(\/(?:api|image)\/.*)$/.exec(targetPath);
    if(targetPath.startsWith('/native/')){
      const selected=nativeMatch&&native?.get(nativeMatch[1]);
      if(!selected)return res.status(410).set('Cache-Control','no-store').json({error:'native_profile_missing'});
      targetPath=nativeMatch[2];fetchImpl=selected.fetch;
    }
    const isImage=targetPath.startsWith('/image/'),pending=isImage?images:active;
    const started=Date.now();let headerMs=0,imageBytes=0;
    req.once('aborted',cancel);res.once('close',cancel);pending.add(abort);
    try{
      let result;
      if(closing||pending.size>8)result=reply(503,{error:'relay_busy'});
      else{
        const headers=new Headers();
        for(const[name,value]of Object.entries(req.headers))if(typeof value==='string')headers.set(name,value);
        if(nativeMatch&&!isImage)headers.set('app-channel','2');
        let body;
        if(req.method==='POST'&&req.body!==undefined)body=Buffer.isBuffer(req.body)?req.body:Buffer.from(JSON.stringify(req.body));
        if(Number(headers.get('content-length'))>16384||(body?.byteLength||0)>16384)result=reply(413,{error:'body_too_large'});
        else{
          headers.delete('content-length');
          const input=new Request(new URL(targetPath,'http://pica-plugin.invalid'),{method:req.method,headers,body,signal:abort.signal});
          result=isImage?await forwardImage(input,{cors:false,fetchImpl,cache}):
            await forwardPica(input,{authorizationHeader:'x-pica-authorization',fetchImpl,cache});
        }
      }
      headerMs=Date.now()-started;res.status(result.status);for(const[name,value]of result.headers)res.set(name,value);
      if(!result.body)res.end();
      else await new Promise(resolve=>{
        const stream=Readable.fromWeb(result.body);
        if(isImage)stream.on('data',chunk=>{imageBytes+=chunk.length;});
        const failed=()=>{res.destroy();resolve();};
        const done=()=>{res.removeListener('finish',done);res.removeListener('close',done);if(!stream.destroyed)stream.destroy();resolve();};
        stream.once('error',failed);res.once('finish',done);res.once('close',done);stream.pipe(res);
      });
    }catch{
      if(!res.headersSent&&!res.destroyed)res.status(502).set('X-Pica-Error-Origin','relay').json({error:'relay_request_failed'});
      else if(!res.destroyed)res.destroy();
    }finally{
      pending.delete(abort);req.removeListener('aborted',cancel);res.removeListener('close',cancel);
      const totalMs=Date.now()-started;
      if(isImage&&(totalMs>=2000||res.statusCode>=400||abort.signal.aborted))console.warn('[pica-relay:image] '+JSON.stringify({
        status:res.statusCode,headerMs,totalMs,bytes:imageBytes,aborted:abort.signal.aborted,activeImages:images.size,
      }));
    }
  });
}
export async function exit(){closing=true;updater?.close();distribution?.close();transport?.close();native?.close();await cache?.close();for(const controller of [...active,...images])controller.abort();active.clear();images.clear();}
