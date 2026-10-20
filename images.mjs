// Only observed image origins and static bitmap paths are eligible.
import {CORS,reply} from './core.mjs';
export const IMAGE_HOSTS = ['storage-b.picacomic.com','storage1.picacomic.com','diwodiwo.xyz'];
const CATEGORY_ASSETS = new Set(['every-see.jpg','old.jpg','promo.jpg']);
const REDIRECT_HOSTS = new Set([...IMAGE_HOSTS,'img.picacomic.com']);
const TYPES = new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif']);
const MAX_BYTES = 12 * 1024 * 1024;

function validImagePath(value){
  if(value.length>4096||/%(?:2f|5c)/i.test(value))return false;
  let path;try{path=decodeURIComponent(value);}catch{return false;}
  return path.length<=3072&&/^[a-zA-Z0-9_./~:+@=-]+$/.test(path)&&!path.split('/').some(p=>!p||p==='.'||p==='..')&&/\.(?:jpe?g|png|webp|gif|avif)$/i.test(path);
}
function allowedImagePath(host,path){
  return validImagePath(path)&&(host!=='diwodiwo.xyz'||CATEGORY_ASSETS.has(path));
}
function redirectTarget(value,base){
  try{
    // Inspect the raw path before URL parsing can normalize away dot segments.
    if(/[\\\s]/.test(value)||/%(?:2e|2f|5c)/i.test(value)||/(?:^|\/)\.{1,2}(?:\/|$)/.test(value))return null;
    const u=new URL(value,base);
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||!REDIRECT_HOSTS.has(u.hostname))return null;
    if(IMAGE_HOSTS.includes(u.hostname)&&(!u.pathname.startsWith('/static/')||!allowedImagePath(u.hostname,u.pathname.slice(8))))return null;
    return validImagePath(u.pathname.slice(1))?u.href:null;
  }catch{return null;}
}

export function imageTarget(request) {
  const url=new URL(request.url);
  if(!['GET','HEAD'].includes(request.method)||url.search||url.pathname.length>4096)return null;
  const match=/^\/image\/([^/]+)\/(.+)$/.exec(url.pathname);
  if(!match||!IMAGE_HOSTS.includes(match[1])||!allowedImagePath(match[1],match[2]))return null;
  return 'https://'+match[1]+'/static/'+match[2];
}

export async function forwardImage(request,{fetchImpl=globalThis.fetch,timeoutMs=30000,cors=true}={}) {
  const target=imageTarget(request),fail=(status,error)=>reply(status,{error},{cors});
  if(!target)return fail(404,'image_not_allowed');
  const abort=new AbortController(),cancelled=()=>abort.abort();
  if(request.signal.aborted)abort.abort();request.signal.addEventListener('abort',cancelled,{once:true});
  const timer=setTimeout(()=>abort.abort(),timeoutMs);timer.unref?.();
  const clean=()=>{clearTimeout(timer);request.signal.removeEventListener('abort',cancelled);};
  try{
    let response,current=target;const visited=new Set([target]);
    for(let hop=0;hop<=2;hop++){
      response=await fetchImpl(current,{method:request.method,redirect:'manual',signal:abort.signal,
        headers:{'Accept':'image/avif,image/webp,image/*;q=0.8','User-Agent':'okhttp/3.8.1'},
        cf:{cacheEverything:true,cacheTtlByStatus:{'200-299':86400,'300-599':-1}}});
      if(response.status<300||response.status>=400)break;
      const location=response.headers.get('location'),next=location?redirectTarget(location,current):null;
      await response.body?.cancel();
      if(hop===2||!next||visited.has(next)){clean();return fail(502,'image_redirect_rejected');}
      visited.add(next);current=next;
    }
    const reject=async(status,error)=>{await response.body?.cancel();clean();return fail(status,error);};
    if(response.status!==200)return reject(response.status===404?404:502,'image_upstream_failed');
    const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(!TYPES.has(type))return reject(502,'image_type_rejected');
    const length=response.headers.get('content-length');
    if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES))return reject(502,'image_too_large');
    const headers=new Headers({...(cors?CORS:{}),'Content-Type':type,'Cache-Control':(cors?'public':'private')+', max-age=86400',
      'X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':cors?'cross-origin':'same-origin'});
    if(request.method==='HEAD'){await response.body?.cancel();clean();if(length!==null)headers.set('Content-Length',length);return new Response(null,{headers});}
    if(!response.body){clean();return fail(502,'image_empty');}
    const reader=response.body.getReader();let size=0;
    const stream=new ReadableStream({
      async pull(controller){try{
        const {done,value}=await reader.read();
        if(done){clean();controller.close();return;}
        size+=value.byteLength;if(size>MAX_BYTES){abort.abort();clean();await reader.cancel();controller.error(new Error('image_too_large'));return;}
        controller.enqueue(value);
      }catch{clean();controller.error(new Error('image_stream_failed'));}},
      async cancel(reason){abort.abort();clean();await reader.cancel(reason);},
    });
    return new Response(stream,{headers});
  }catch{clean();return fail(502,abort.signal.aborted?'image_timeout':'image_unreachable');}
}
