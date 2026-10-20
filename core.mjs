// Shared Web API relay core. No host credentials, storage, or diagnostic logging.
export const VERSION = '0.4.0';
export const PROTOCOL = 1;
export const SERVICE = 'pica-tavern-relay';
export const UPSTREAM = 'https://picaapi.picacomic.com/';
export const FORWARDED_HEADERS = ['api-key', 'accept', 'app-channel', 'app-platform', 'app-version',
  'app-build-version', 'app-uuid', 'image-quality', 'time', 'nonce', 'signature', 'content-type'];
export const CORS = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': ['x-relay-key', 'authorization', ...FORWARDED_HEADERS].join(', '),
  'Access-Control-Expose-Headers': 'X-Pica-Error-Origin, Retry-After', 'Access-Control-Max-Age': '600',
};
export function reply(status, body, {cors = false, origin = 'relay', headers = {}} = {}) {
  return new Response(JSON.stringify(body), {status, headers: {
    ...(cors ? CORS : {}), 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Pica-Error-Origin': origin, ...headers,
  }});
}
export function capabilities(authModes, ready, upstreamMode = 'direct') {
  return {service:SERVICE, version:VERSION, protocolVersion:PROTOCOL, ready, authModes,
    upstreamMode, capabilities:['read','search','login','comments','likes','favourites']};
}
export function allowed(method, path) {
  if (method === 'POST') return path === 'auth/sign-in' || path === 'comics/advanced-search' ||
    /^(?:comics\/[a-f0-9]{24}\/(?:like|favourite|comments)|comments\/[a-f0-9]{24}(?:\/like)?)$/.test(path);
  return method === 'GET' && /^(?:users\/(?:profile|favourite)|categories|collections|keywords|comics|comics\/(?:random|leaderboard|knight-leaderboard)|comics\/[a-f0-9]{24}(?:\/eps|\/comments|\/recommendation|\/order\/[0-9]+\/pages)?|comments\/[a-f0-9]{24}\/childrens)$/.test(path);
}
async function limitedBody(request) {
  if (!request.body) return undefined;
  const reader = request.body.getReader(), parts = [];let size=0;
  for (;;) {
    const {done,value}=await reader.read();if(done)break;
    size+=value.byteLength;
    if(size>16384){await reader.cancel();throw new RangeError('body_too_large');}
    parts.push(value);
  }
  const body=new Uint8Array(size);let offset=0;
  for(const part of parts){body.set(part,offset);offset+=part.length;}return body;
}
export async function forwardPica(request, {cors=false, authorizationHeader='authorization', fetchImpl=globalThis.fetch, timeoutMs=20000}={}) {
  const url=new URL(request.url), fail=(status,error)=>reply(status,{error},{cors});
  if(!url.pathname.startsWith('/api/'))return fail(404,'route_not_found');
  const path=url.pathname.slice(5);
  if(!allowed(request.method,path))return fail(404,'route_not_allowed');
  const headers=new Headers();
  for(const name of FORWARDED_HEADERS){const value=request.headers.get(name);if(value)headers.set(name,value);}
  const token=request.headers.get(authorizationHeader);if(token)headers.set('authorization',token);
  headers.set('User-Agent','okhttp/3.8.1');let body;
  try{body=request.method==='POST'?await limitedBody(request):undefined;}catch{return fail(413,'body_too_large');}
  const abort=new AbortController(),cancelled=()=>abort.abort();
  if(request.signal.aborted)abort.abort();request.signal.addEventListener('abort',cancelled,{once:true});
  const timer=setTimeout(()=>abort.abort(),timeoutMs);
  timer.unref?.();
  const clean=()=>{clearTimeout(timer);request.signal.removeEventListener('abort',cancelled);};
  try {
    const response=await fetchImpl(UPSTREAM+path+url.search,{method:request.method,headers,body,redirect:'manual',signal:abort.signal});
    if(response.status>=300&&response.status<400){await response.body?.cancel();clean();return fail(502,'upstream_redirect_rejected');}
    const outgoing=new Headers({...(cors?CORS:{}),'Content-Type':response.headers.get('content-type')||'application/json',
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Pica-Error-Origin':'upstream'});
    const retryAfter=response.headers.get('retry-after');if(retryAfter)outgoing.set('Retry-After',retryAfter);
    let stream=null;
    if(response.body){const reader=response.body.getReader();stream=new ReadableStream({
      async pull(controller){try{const {done,value}=await reader.read();if(done){clean();controller.close();}else controller.enqueue(value);}catch(error){clean();controller.error(error);}},
      async cancel(reason){abort.abort();clean();await reader.cancel(reason);},
    });}else clean();
    return new Response(stream,{status:response.status,headers:outgoing});
  }catch{clean();return fail(502,abort.signal.aborted?'upstream_timeout':'upstream_unreachable');}
}
