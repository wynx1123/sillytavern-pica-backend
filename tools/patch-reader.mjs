#!/usr/bin/env node
/**
 * Reproducible patch for the signed Pica reader bundle (app.mjs).
 *
 * Fixes
 *  1. image prefetch window was fixed at 600px -> only ~3 pages ever got fetched,
 *     the rest waited for the user to scroll into range (felt like "3 pages then stuck").
 *  2. image loading depended on IntersectionObserver alone; a missed callback left
 *     pages queued forever. Near-viewport pages are now eligible by geometry too.
 *  3. scroll driven progress() only ran inside requestAnimationFrame; throttled or
 *     occluded frames froze auto-continue. A setTimeout watchdog now guarantees a tick.
 *  4. the seek anchor kept snapping scrollTop back to the seek target until a
 *     pointer/wheel event; it now releases after the user scrolls away.
 *  5. reader pages use loading="eager" (the loader already controls when src is set).
 *  6. in-memory LRU of image blobs so re-reading a page never re-downloads it.
 *  7. per-page pinch zoom (up to 5x, drag to pan, double tap for 2.5x) - the
 *     reader pinned touch-action to pan-y so small text could not be magnified.
 *  8. a second source line ("再看漫画") served by this backend's Pica-compatible
 *     facade under /sources/zai/ - one extra preset, no other reader changes.
 *
 * Usage:
 *   node tools/patch-reader.mjs --input app.mjs --out dist/app.mjs --version 1.0.2
 *   node tools/patch-reader.mjs --input app.mjs --out /tmp/app-test.mjs --instrument
 */
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

const PATCHES = [];
function patch(name, from, to) {
  PATCHES.push({name, from, to});
}

/* ---------------------------------------------------------------- helpers -- */
patch('blob-cache',
  'const jobs=new Map();let active=0,disposed=false,scheduled=false,imageUntil=0,cooldownTimer=null;',
  `const jobs=new Map();let active=0,disposed=false,scheduled=false,imageUntil=0,cooldownTimer=null;
  // Reader-local LRU of decoded image blobs: scrolling back or reopening a chapter
  // never re-downloads a page that is already in this session.
  const blobCache=new Map();let blobBytes=0;const BLOB_MAX=32*1024*1024;
  function blobGet(url){const hit=blobCache.get(url);if(!hit)return null;blobCache.delete(url);blobCache.set(url,hit);return hit;}
  function blobPut(url,blob){if(!blob||!blob.size||blob.size>12*1024*1024)return;const old=blobCache.get(url);if(old){blobBytes-=old.size;blobCache.delete(url);}blobCache.set(url,blob);blobBytes+=blob.size;for(const [key,value] of blobCache){if(blobBytes<=BLOB_MAX)break;if(key===url)continue;blobCache.delete(key);blobBytes-=value.size;}}
  function blobClear(){blobCache.clear();blobBytes=0;}
  // Prefetch roughly two viewports ahead instead of a hard 600px. Long strip pages
  // are ~1.5 viewports tall, so 600px only ever covered the next page.
  const prefetchPx=Math.max(1200,Math.round((scrollRoot?.clientHeight||640)*2));`);

patch('observer-margin',
  "{root:scrollRoot,rootMargin:'600px 0px'}",
  "{root:scrollRoot,rootMargin:prefetchPx+'px 0px'}");

patch('retention-margin',
  "{root:scrollRoot,rootMargin:'3000px 0px'}",
  "{root:scrollRoot,rootMargin:(prefetchPx*3)+'px 0px'}");

patch('eligible',
  `  function eligible(job){
    if(collapsed())return false;
    if(job.image.isConnected===false)return false;
    if(job.image.closest?.('[hidden]'))return false;
    return !observer||job.visible;
  }`,
  `  // Geometry fallback: IntersectionObserver can miss callbacks (shadow DOM,
  // occluded frames, fast flings). Anything inside the prefetch window is
  // eligible even if the observer has not reported it yet.
  function near(job){
    const r=job.image.getBoundingClientRect?.(),view=scrollRoot?.getBoundingClientRect?.();
    if(!r||!view)return false;
    return r.bottom>=view.top-prefetchPx&&r.top<=view.bottom+prefetchPx;
  }
  function eligible(job){
    if(collapsed())return false;
    if(job.image.isConnected===false)return false;
    if(job.image.closest?.('[hidden]'))return false;
    return !observer||job.visible||near(job);
  }`);

patch('scroll-refresh',
  'mutation?.observe(root,{childList:true,subtree:true});',
  `mutation?.observe(root,{childList:true,subtree:true});
  const onScroll=()=>schedule();
  scrollRoot?.addEventListener?.('scroll',onScroll,{passive:true});`);

patch('destroy-cleanup',
  'function destroy(){disposed=true;clearTimeout(cooldownTimer);observer?.disconnect();retention?.disconnect();mutation?.disconnect();for(const job of jobs.values())cleanup(job);jobs.clear();}',
  `function destroy(){disposed=true;clearTimeout(cooldownTimer);observer?.disconnect();retention?.disconnect();mutation?.disconnect();scrollRoot?.removeEventListener?.('scroll',onScroll);blobClear();for(const job of jobs.values())cleanup(job);jobs.clear();}`);

/* Attach the decoded blob to the <img>. Extracted so a cache hit and a network
   hit share the exact same decode/visibility path. */
patch('attach-loaded',
  '  async function run(job){',
  `  function attachLoaded(job){
    job.onLoad=event=>{if(!current(job))return;if(job.objectUrl){host.URL.revokeObjectURL(job.objectUrl);job.objectUrl='';}job.image.removeEventListener('load',job.onLoad);job.image.removeEventListener('error',job.onLoad);if(event.type==='error'){job.state='failed';imageState(job,'failed');job.image.removeAttribute('src');return;}imageState(job,'loaded');if(job.recycle&&job.image.naturalWidth>0&&job.image.naturalHeight>0){job.image.style.aspectRatio=job.image.naturalWidth+' / '+job.image.naturalHeight;job.image.style.minHeight='0';if(!job.retained)park(job);}};
    job.image.addEventListener('load',job.onLoad);job.image.addEventListener('error',job.onLoad);
    job.image.src=job.objectUrl;
  }
  async function run(job){`);

patch('cache-hit',
  `    try{
      const response=await fetchImpl(job.requestTarget||job.target,{headers:job.requestTarget&&job.requestTarget!==job.target?{}:{'x-pica-image-task':job.taskId},credentials:'same-origin',referrerPolicy:'no-referrer',redirect:'error',cache:'default',signal:controller.signal});`,
  `    try{
      const cached=blobGet(job.target);
      if(cached){
        if(!current(job))return;
        job.objectUrl=host.URL.createObjectURL(cached);job.state='loaded';imageState(job,'decoding');
        attachLoaded(job);
        return;
      }
      const response=await fetchImpl(job.requestTarget||job.target,{headers:job.requestTarget&&job.requestTarget!==job.target?{}:{'x-pica-image-task':job.taskId},credentials:'same-origin',referrerPolicy:'no-referrer',redirect:'error',cache:'default',signal:controller.signal});`);

patch('cache-store',
  `      job.objectUrl=host.URL.createObjectURL(new host.Blob(chunks,{type}));job.state='loaded';imageState(job,'decoding');
      job.onLoad=event=>{if(!current(job))return;if(job.objectUrl){host.URL.revokeObjectURL(job.objectUrl);job.objectUrl='';}job.image.removeEventListener('load',job.onLoad);job.image.removeEventListener('error',job.onLoad);if(event.type==='error'){job.state='failed';imageState(job,'failed');job.image.removeAttribute('src');return;}imageState(job,'loaded');if(job.recycle&&job.image.naturalWidth>0&&job.image.naturalHeight>0){job.image.style.aspectRatio=job.image.naturalWidth+' / '+job.image.naturalHeight;job.image.style.minHeight='0';if(!job.retained)park(job);}};
      job.image.addEventListener('load',job.onLoad);job.image.addEventListener('error',job.onLoad);
      job.image.src=job.objectUrl;`,
  `      const blob=new host.Blob(chunks,{type});blobPut(job.target,blob);
      job.objectUrl=host.URL.createObjectURL(blob);job.state='loaded';imageState(job,'decoding');
      attachLoaded(job);`);

/* ------------------------------------------------------------- page zoom -- */
patch('zoom-var',
  'let episodeDocs=[],readingControls=null,pageStream=null,socialControls=null,generationControls=null,readingReady=false,panelScroll=0;',
  'let episodeDocs=[],readingControls=null,pageStream=null,socialControls=null,generationControls=null,readingReady=false,pageZoom=null,panelScroll=0;');

patch('zoom-factory',
  '  function renderPageRow(row){',
  `  /* Long-strip pages are often typeset small and #scroll pins touch-action to
     pan-y, so the browser pinch is unavailable inside the reader. This adds a
     per-page gesture: pinch to zoom up to 5x, drag to pan while zoomed, double
     tap to jump to 2.5x at the tapped point, pinch-in or double tap to reset. */
  function createPicaPageZoom({host,root,maxScale=5,doubleTap=2.5}={}){
    const style=host.document.createElement('style');
    style.textContent='#reader .page-slot[data-pica-zoom="true"]{overflow:hidden;z-index:4}#reader .page-slot[data-pica-zoom="true"] img.reader-image{will-change:transform}';
    root.prepend(style);
    const clock=()=>(host.performance?.now?.()||Date.now());
    let hinted=false;
    return {
      attach(slot,image){
        if(slot.dataset.picaZoomBound)return;slot.dataset.picaZoomBound='true';
        let scale=1,x=0,y=0,origin={x:0,y:0},pointers=new Map(),downs=new Map(),start=null,downAt=0,moved=0,lastTap=0;
        const size=()=>{const r=slot.getBoundingClientRect();return {w:r.width||1,h:r.height||1};};
        function clamp(){
          if(scale<=1){scale=1;x=0;y=0;return;}
          const {w,h}=size(),grow=scale-1;
          x=Math.max(-grow*(w-origin.x),Math.min(grow*origin.x,x));
          y=Math.max(-grow*(h-origin.y),Math.min(grow*origin.y,y));
        }
        function apply(){
          image.style.transform=scale>1?('translate('+Math.round(x)+'px,'+Math.round(y)+'px) scale('+scale.toFixed(3)+')'):'';
          image.style.touchAction=scale>1?'none':'';
          const flag=String(scale>1);
          if(slot.dataset.picaZoom!==flag)slot.dataset.picaZoom=flag;
        }
        function set(next,at){
          const r=slot.getBoundingClientRect(),{w,h}=size();
          origin={x:Math.max(0,Math.min(w,at?at.x-r.left:w/2)),y:Math.max(0,Math.min(h,at?at.y-r.top:h/2))};
          scale=Math.max(1,Math.min(maxScale,next));x=0;y=0;clamp();apply();
        }
        const point=e=>({x:e.clientX,y:e.clientY});
        const rebase=()=>{
          const first=[...pointers.values()][0];
          if(first)start={scale,x,y,p:first};
        };
        slot.addEventListener('pointerdown',e=>{
          if(e.target.closest?.('button'))return;
          if(image.dataset.picaImageState!=='loaded')return;
          pointers.set(e.pointerId,point(e));downs.set(e.pointerId,point(e));
          moved=0;downAt=clock();
          try{slot.setPointerCapture(e.pointerId);}catch{}
          if(pointers.size===1){start={scale,x,y,p:point(e)};}
          else if(pointers.size===2){
            const [p1,p2]=[...pointers.values()],r=slot.getBoundingClientRect();
            origin={x:Math.max(0,Math.min(r.width,(p1.x+p2.x)/2-r.left)),y:Math.max(0,Math.min(r.height,(p1.y+p2.y)/2-r.top))};
            start={scale,x,y,d:Math.max(1,Math.hypot(p1.x-p2.x,p1.y-p2.y)),mid:{x:(p1.x+p2.x)/2,y:(p1.y+p2.y)/2}};
          }else{start=null;scale=1;x=0;y=0;apply();}
        });
        slot.addEventListener('pointermove',e=>{
          if(!pointers.has(e.pointerId))return;
          const down=downs.get(e.pointerId)||point(e),now=point(e);
          pointers.set(e.pointerId,now);
          moved=Math.max(moved,Math.hypot(now.x-down.x,now.y-down.y));
          if(pointers.size===2&&start?.d){
            const [p1,p2]=[...pointers.values()];
            const d=Math.max(1,Math.hypot(p1.x-p2.x,p1.y-p2.y));
            scale=Math.max(1,Math.min(maxScale,start.scale*d/start.d));
            const mid={x:(p1.x+p2.x)/2,y:(p1.y+p2.y)/2};
            x=start.x+(mid.x-start.mid.x);y=start.y+(mid.y-start.mid.y);
            clamp();apply();
          }else if(pointers.size===1&&scale>1&&start?.p){
            x=start.x+(now.x-start.p.x);y=start.y+(now.y-start.p.y);
            clamp();apply();
          }
        });
        const finish=e=>{
          pointers.delete(e.pointerId);downs.delete(e.pointerId);
          if(pointers.size===1)rebase();
          if(pointers.size===0&&moved<10&&clock()-downAt<350){
            const now=clock();
            if(now-lastTap<320){
              if(scale>1){scale=1;x=0;y=0;apply();}
              else set(doubleTap,point(e));
              lastTap=0;
            }else lastTap=now;
          }
          if(pointers.size===0)start=null;
          if(scale>1&&!hinted){hinted=true;notice('已放大：单指拖动移动，双指捏合或双击还原。');}
        };
        slot.addEventListener('pointerup',finish);
        slot.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);downs.delete(e.pointerId);if(pointers.size===1)rebase();if(!pointers.size)start=null;});
        slot.addEventListener('lostpointercapture',e=>{pointers.delete(e.pointerId);downs.delete(e.pointerId);if(pointers.size===1)rebase();if(!pointers.size)start=null;});
      },
    };
  }
  function renderPageRow(row){`);

patch('zoom-attach',
  'slot.append(image,placeholder,retry);return slot;',
  'slot.append(image,placeholder,retry);pageZoom?.attach(slot,image);return slot;');

patch('zoom-create',
  '  readingControls=createPicaReadingControls();',
  `  readingControls=createPicaReadingControls();
  pageZoom=createPicaPageZoom({host,root:view});`);

/* A pinch used to fire the tap-to-toggle-chrome handler, because it only ever
   tracked the newest pointer. Count active pointers instead: the first finger
   still arms the tap, any second finger cancels it. */
patch('zoom-tap-guard',
  `  listen($('pages'),'pointerdown',event=>{press={id:event.pointerId,x:event.clientX,y:event.clientY};});
  listen($('pages'),'pointerup',event=>{
    if(press&&event.pointerId===press.id&&Math.hypot(event.clientX-press.x,event.clientY-press.y)<8&&!event.target.closest('button'))setChrome(!shown);
    press=null;
  });
  listen($('pages'),'pointercancel',()=>{press=null;});`,
  `  let pagePointers=0;
  listen($('pages'),'pointerdown',event=>{pagePointers++;if(pagePointers>1)press=null;else press={id:event.pointerId,x:event.clientX,y:event.clientY};});
  listen($('pages'),'pointerup',event=>{
    pagePointers=Math.max(0,pagePointers-1);
    if(press&&event.pointerId===press.id&&Math.hypot(event.clientX-press.x,event.clientY-press.y)<8&&!event.target.closest('button'))setChrome(!shown);
    press=null;
  });
  listen($('pages'),'pointercancel',()=>{press=null;pagePointers=Math.max(0,pagePointers-1);});`);

/* ------------------------------------------------------- reading controls -- */
patch('progress-watchdog',
  'function schedule(){if(!panel.hidden&&!panel.inert&&!frame)frame=host.requestAnimationFrame(progress);}',
  `function schedule(){
    if(panel.hidden||panel.inert||frame)return;
    frame=host.requestAnimationFrame(progress);
    // requestAnimationFrame pauses in background/occluded tabs and can be starved
    // by long frames. A bounded fallback keeps auto-continue alive regardless.
    host.setTimeout(()=>{if(frame){host.cancelAnimationFrame(frame);frame=0;progress();}},300);
  }`);

patch('seek-base-var',
  'let shown=true, frame=0, pageOffset=0, totalPages=1, press=null, seekIndex=null, pausedAnchor=null, resumeAnchor=null,lastCurrent=0,pendingAbsolute=null;',
  'let shown=true, frame=0, pageOffset=0, totalPages=1, press=null, seekIndex=null, seekBase=null, pausedAnchor=null, resumeAnchor=null,lastCurrent=0,pendingAbsolute=null;');

patch('seek-release',
  `    if(seekIndex!==null&&images[seekIndex]){
      if(seekIndex===images.length-1)scroll.scrollTop=scroll.scrollHeight;
      else scroll.scrollTop=Math.round(scroll.scrollTop+images[seekIndex].getBoundingClientRect().top-top);
    }`,
  `    if(seekIndex!==null&&images[seekIndex]){
      // Re-align only while layout changes from lazy loads are settling. A real
      // user scroll (>80px) releases the seek so the reader stops snapping back.
      if(seekBase!==null&&Math.abs(scroll.scrollTop-seekBase)>80){seekIndex=null;seekBase=null;}
      else{
        if(seekIndex===images.length-1)scroll.scrollTop=scroll.scrollHeight;
        else scroll.scrollTop=Math.round(scroll.scrollTop+images[seekIndex].getBoundingClientRect().top-top);
        seekBase=scroll.scrollTop;
      }
    }`);

patch('seek-clear',
  'const clearSeek=()=>{seekIndex=null;resumeAnchor=null;pendingAbsolute=null;};',
  'const clearSeek=()=>{seekIndex=null;seekBase=null;resumeAnchor=null;pendingAbsolute=null;};');

patch('seek-loaded',
  "seekIndex=Math.max(0,Math.min($('pages').children.length-1,(Number(index)||1)-1));pageOffset=offset;totalPages=total;",
  "seekIndex=Math.max(0,Math.min($('pages').children.length-1,(Number(index)||1)-1));seekBase=scroll.scrollTop;pageOffset=offset;totalPages=total;");

patch('seek-input',
  'seekIndex=index;resumeAnchor=null;',
  'seekIndex=index;seekBase=scroll.scrollTop;resumeAnchor=null;');

patch('reader-eager',
  "image.alt='第 '+row.number+' 张';image.loading='lazy';image.decoding='async';image.referrerPolicy='no-referrer';",
  "image.alt='第 '+row.number+' 张';image.loading='eager';image.decoding='async';image.referrerPolicy='no-referrer';");

/* ------------------------------------------------------- extra source line -- */
patch('source-preset',
  '  const routeProfile={"schemaVersion": 2, "trustedOverflowOrigins": ["https://pica.ssrfhlydxl.ccwu.cc"], "presets": [{"id": "line-a", "label": "线路A", "baseUrl": "https://chatgptdxl.ccwu.cc/pica-relay", "enabled": true, "authMode": "public"}]};',
  `  const routeProfile={"schemaVersion": 2, "trustedOverflowOrigins": ["https://pica.ssrfhlydxl.ccwu.cc"], "presets": [{"id": "line-a", "label": "线路A", "baseUrl": "https://chatgptdxl.ccwu.cc/pica-relay", "enabled": true, "authMode": "public"}, {"id": "line-zai", "label": "再看漫画", "baseUrl": (()=>{const ok=v=>{const t=String(v||'').trim();if(!t||t==='null')return '';try{const u=new URL(t);if(u.protocol==='file:'||u.protocol==='about:')return '';return (u.origin&&u.origin!=='null'?u.origin:(u.protocol+'//'+u.host));}catch{return '';}};try{const a=ok(self.location.origin);if(a)return a+'/api/plugins/pica-relay/sources/zai';}catch{}try{const b=ok(self.location.href);if(b)return b+'/api/plugins/pica-relay/sources/zai';}catch{}try{const c=ok(self.document.URL);if(c)return c+'/api/plugins/pica-relay/sources/zai';}catch{}try{const d=ok(self.document.referrer);if(d)return d+'/api/plugins/pica-relay/sources/zai';}catch{}return '';})(), "enabled": true, "authMode": "public"}]};`);

patch('source-builtin',
  `  const builtin=presets.filter(r=>r.id==='line-a').slice(0,1).map(r=>{
    let base='';try{base=baseUrl(r.baseUrl);}catch{}
    return {id:'line-a',label:'线路A',baseUrl:base,kind:'public',enabled:r.enabled===true&&!!base};
  });`,
  `  const builtin=presets.filter(r=>r.id==='line-a'||r.id==='line-zai').map(r=>{
    let base='';try{base=baseUrl(r.baseUrl);}catch{}
    return {id:r.id,label:r.label||r.id,baseUrl:base,kind:'public',enabled:r.enabled===true&&!!base};
  });`);

patch('source-config-mode',
  "const result={version:2,mode:value.mode==='host'?'host':'line-a',hostUpstream:value.hostUpstream==='native2'?'native2':'system'};",
  "const result={version:2,mode:value.mode==='host'?'host':value.mode==='line-zai'?'line-zai':'line-a',hostUpstream:value.hostUpstream==='native2'?'native2':'system'};");

patch('source-configure',
  "if(!['line-a','host'].includes(mode))throw error('仅支持线路A或酒馆后端。','config');",
  "if(!['line-a','line-zai','host'].includes(mode))throw error('仅支持线路A、再看漫画或酒馆后端。','config');");

patch('source-select-option',
  '<option value=\\"line-a\\">线路A</option><option value=\\"host\\">酒馆后端</option>',
  '<option value=\\"line-a\\">线路A</option><option value=\\"line-zai\\">再看漫画</option><option value=\\"host\\">酒馆后端</option>');

/* Switching between sources must drop the previous source's profile, otherwise
   a guest token from one facade is silently trusted by the next one and every
   request fails with an opaque upstream error. */
patch('route-switch-reset',
  `  $('route-selection').onchange=()=>{
    const mode=$('route-selection').value;
    run(async()=>{const saved=routeManager.configure({mode});updateCacheStatus(saved?undefined:'线路偏好未能保存。');await connectSelected();});
  };`,
  `  $('route-selection').onchange=()=>{
    const mode=$('route-selection').value;
    profile=null; // force the new source to re-verify the session
    run(async()=>{const saved=routeManager.configure({mode});updateCacheStatus(saved?undefined:'线路偏好未能保存。');await connectSelected();});
  };`);

/* ------------------------------------------------- IPA / custom scheme -- */
/* TT酒馆 IPA 跑在 capacitor:// 之类的自定义协议下，location.origin 可能是
   "null"，new URL() 也拿不到 http(s) origin，于是「酒馆后端」「再看漫画」
   都被判成不可用。这里补三层兜底，并放开同源自定义协议。 */
patch('origin-resolve',
  `  let storage=null;try{storage=host.localStorage;}catch{}
  let origin='';try{origin=host.location.origin;}catch{}`,
  `  let storage=null;try{storage=host.localStorage;}catch{}
  // Resolve the tavern origin. IPA shells (capacitor://, app://, file://) often
  // report "null" or a non-http scheme, so fall back through several sources.
  function picaOrigin(){
    const clean=value=>{const text=String(value||'').trim();if(!text||text==='null')return '';try{const u=new URL(text);if(u.protocol==='file:'||u.protocol==='about:')return '';if(u.origin&&u.origin!=='null')return u.origin;if(u.protocol&&u.host)return u.protocol+'//'+u.host;}catch{}return '';};
    const direct=clean((()=>{try{return host.location.origin;}catch{return '';}})());
    if(direct)return direct;
    const loc=clean((()=>{try{return host.location.href;}catch{return '';}})());
    if(loc)return loc;
    const docUrl=clean((()=>{try{return host.document.URL;}catch{return '';}})());
    if(docUrl)return docUrl;
    const selfUrl=clean((()=>{try{return self.document.URL;}catch{return '';}})());
    if(selfUrl)return selfUrl;
    const ref=clean((()=>{try{return self.document.referrer;}catch{return '';}})());
    if(ref)return ref;
    return '';
  }
  let origin=picaOrigin();`);

patch('host-route-scheme',
  `  let hostRoute=null;
  try{const origin=new URL(hostOrigin);if(/^https?:$/.test(origin.protocol)&&origin.origin===hostOrigin)hostRoute={id:'host',label:'酒馆后端',baseUrl:origin.origin+'/api/plugins/pica-relay',kind:'host',enabled:true};}catch{}`,
  `  let hostRoute=null;
  // Accept https, http and same-origin custom schemes (capacitor://, app://).
  try{const u=new URL(hostOrigin);const scheme=u.protocol;const hostPart=u.host;const okScheme=scheme==='https:'||scheme==='http:'||(hostPart&&hostOrigin.indexOf(scheme+'//'+hostPart)===0);if(okScheme&&hostPart)hostRoute={id:'host',label:'酒馆后端',baseUrl:hostOrigin+'/api/plugins/pica-relay',kind:'host',enabled:true};}catch{}`);

patch('base-url-scheme',
  `  function baseUrl(value){
    const raw=String(value||'').trim();if(!raw||/[\\\\\\s]/.test(raw)||/%(?:2e|2f|5c)/i.test(raw)||/\\/\\.{1,2}(?:\\/|$)/.test(raw))throw error('请填写完整的 HTTPS 转发地址。','config');
    const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw error('请填写完整的 HTTPS 转发地址。','config');
    return url.origin+url.pathname.replace(/\\/+$/,'');
  }`,
  `  function baseUrl(value){
    const raw=String(value||'').trim();if(!raw||/[\\\\\\s]/.test(raw)||/%(?:2e|2f|5c)/i.test(raw)||/\\/\\.{1,2}(?:\\/|$)/.test(raw))throw error('请填写完整的转发地址。','config');
    const url=new URL(raw);
    if(url.username||url.password||url.search||url.hash)throw error('请填写完整的转发地址。','config');
    const same=!!hostOrigin&&((url.origin&&url.origin!=='null'&&url.origin===hostOrigin)||(url.protocol+'//'+url.host)===hostOrigin);
    const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    const special=url.protocol==='https:'||url.protocol==='http:';
    // https always, http only same-origin/local, custom schemes only same-origin.
    if(!(url.protocol==='https:'||(url.protocol==='http:'&&(same||local))||(same&&!special)))throw error('请填写完整的 HTTPS 转发地址。','config');
    return (url.origin&&url.origin!=='null'?url.origin:(url.protocol+'//'+url.host))+url.pathname.replace(/\\/+$/,'');
  }`);

patch('route-diag',
  `      for(const option of $('route-selection').options){const route=state.routes.find(r=>r.id===option.value);option.disabled=!route?.enabled;option.textContent=(route?.label||(option.value==='host'?'酒馆后端':'线路A'))+(route?.enabled?'':' · 不可用');}
    }`,
  `      for(const option of $('route-selection').options){const route=state.routes.find(r=>r.id===option.value);option.disabled=!route?.enabled;option.textContent=(route?.label||(option.value==='host'?'酒馆后端':'线路A'))+(route?.enabled?'':' · 不可用');}
      if(state&&!state.routes.some(r=>r.id==='host')){
        let diag=$('route-diag');
        if(!diag){diag=document.createElement('p');diag.id='route-diag';diag.className='hint';diag.style.cssText='font-size:11px;opacity:.65;word-break:break-all;margin:6px 0 0';const anchor=$('route-selection').closest('.setting-row')||$('route-selection').parentElement;if(anchor&&anchor.after)anchor.after(diag);}
        let loc='';try{loc=host.location.href;}catch{}
        let url='';try{url=host.document.URL;}catch{}
        diag.hidden=false;diag.textContent='诊断：地址='+String(loc||url).slice(0,120);
      }else{const diag=$('route-diag');if(diag)diag.hidden=true;}
    }`);

export function patchReader(source, {instrument = false, version = '1.0.2'} = {}) {
  let out = source;
  for (const {name, from, to} of PATCHES) {
    const count = out.split(from).length - 1;
    if (count !== 1) throw new Error(`patch "${name}": expected 1 match, found ${count}`);
    out = out.replace(from, to);
  }
  if (version) {
    if (!/root\.dataset\.version = "[^"]+"/.test(out)) throw new Error('version: bundle version marker not found');
    out = out.replace(/root\.dataset\.version = "[^"]+"/, `root.dataset.version = "${version}"`);
  }
  // Keep the embedded release descriptor in sync with the bundle version.
  out = out.replace(/export const release = \{[^\n]*\};/, m => {
    if (!m.includes('"version"')) return m;
    return m.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`);
  });
  if (instrument) {
    const needle = '  const instance={version:root.dataset.version,destroy,';
    if (!out.includes(needle)) throw new Error('instrument: mount hook not found');
    out = out.replace(needle, `  self.__picaTest={openComic,openEpisode,openList,showScreen,setOpen,
    get pageStream(){return pageStream},get readingControls(){return readingControls},
    get imageLoader(){return imageLoader},get screen(){return screen},get busy(){return busy},
    get readingReady(){return readingReady},
    get panel(){return $('panel')},get scroll(){return $('scroll')},get pages(){return $('pages')},
    state(){return pageStream?pageStream.state():null;}};
${needle}`);
  }
  return out;
}

/* -------------------------------------------------------------------- cli -- */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = args.indexOf('--' + name);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const input = opt('input');
  const output = opt('out');
  if (!input || !output) {
    console.error('usage: node tools/patch-reader.mjs --input app.mjs --out dist/app.mjs [--version 1.0.2] [--instrument]');
    process.exit(2);
  }
  const src = readFileSync(input, 'utf8');
  const out = patchReader(src, {
    version: opt('version', '1.0.2'),
    instrument: args.includes('--instrument'),
  });
  mkdirSync(dirname(output), {recursive: true});
  writeFileSync(output, out);
  console.log(`patched ${input} -> ${output} (${out.length} bytes, ${PATCHES.length} patches)`);
}
