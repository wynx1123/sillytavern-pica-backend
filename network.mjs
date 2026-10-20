import https from 'node:https';
import {Readable} from 'node:stream';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';

// Optional, plugin-scoped proxy support. No global dispatcher or host settings change.
export function createProxyTransport(proxyUrl){
  const url=new URL(proxyUrl);
  if(!['http:','https:'].includes(url.protocol)||url.pathname!=='/'||url.search||url.hash)throw Error('Invalid plugin HTTPS proxy.');
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<24||major===24&&minor<5)throw Error('Optional proxy mode requires Node 24.5 or newer.');
  const agent=new https.Agent({proxyEnv:{HTTPS_PROXY:url.href},keepAlive:true});
  return {
    fetch(target,options={}){return new Promise((resolve,reject)=>{
      const request=https.request(target,{method:options.method||'GET',headers:Object.fromEntries(new Headers(options.headers)),agent,signal:options.signal},response=>{
        const headers=new Headers();for(const [name,value] of Object.entries(response.headers)){if(Array.isArray(value))for(const v of value)headers.append(name,v);else if(value!==undefined)headers.set(name,value);}
        let stream=response;const encoding=headers.get('content-encoding');
        const decompress=encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():null;
        if(decompress){response.once('error',e=>decompress.destroy(e));response.pipe(decompress);stream=decompress;headers.delete('content-encoding');headers.delete('content-length');}
        if([204,205,304].includes(response.statusCode)){response.resume();resolve(new Response(null,{status:response.statusCode,headers}));}
        else resolve(new Response(Readable.toWeb(stream),{status:response.statusCode,headers}));
      });
      request.once('error',reject);request.end(options.body);
    });},
    close(){agent.destroy();}
  };
}
