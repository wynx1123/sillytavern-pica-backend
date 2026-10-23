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
