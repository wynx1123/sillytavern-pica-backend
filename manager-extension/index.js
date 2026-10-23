import {parseRelease,hashBytes} from './security.js';
import {applyReader,findReaders} from './installer.mjs';
const BASE='/api/plugins/pica-relay/reader/';
let panel=null,alive=false,busy=false,latest=null,backup=null,installedHash='',controllers=new Set();
function helper(){const h=window.TavernHelper;if(typeof h?.getScriptTrees!=='function'||typeof h?.updateScriptTreesWith!=='function')throw Error('酒馆助手尚未就绪，请先启用助手后再操作。');return h;}
function context(){return window.SillyTavern?.getContext?.();}
function status(text){if(panel)panel.querySelector('[data-status]').textContent=text;}
const backendMessages={backend_admin_required:'只有酒馆管理员可以更新后端。',backend_not_git:'当前后端为手动安装；通过 GitHub 安装后可在这里更新。',backend_wrong_repository:'后端不在独立的插件仓库中，无法单独更新。',backend_origin_unsupported:'请使用 GitHub HTTPS 仓库安装后端。',backend_worktree_dirty:'后端目录有本地改动，请先保存或处理后再更新。',backend_tracking_missing:'后端分支未关联 origin，请由管理员检查 Git 配置。',backend_history_diverged:'本地与远端版本有分叉，请由管理员处理后再更新。',backend_repository_changed:'更新期间仓库发生变化，请检查后重试。',backend_update_busy:'后端正在更新，请稍后查看。',backend_update_closed:'后端正在关闭，请重启后再试。',backend_git_failed:'Git 更新未完成，请检查服务器网络与 Git。',backend_update_body_invalid:'更新请求格式不正确。'};
function backendStatus(text){if(panel)panel.querySelector('[data-backend-status]').textContent=text;}
async function backendRequest(update=false){
  const c=new AbortController();controllers.add(c);const timer=setTimeout(()=>c.abort(),180000);
  try{
    const r=await fetch('/api/plugins/pica-relay/maintenance/'+(update?'update':'status'),{method:update?'POST':'GET',credentials:'same-origin',redirect:'error',cache:'no-store',headers:{...context()?.getRequestHeaders?.(),'Content-Type':'application/json'},body:update?'{}':undefined,signal:c.signal});
    if(r.status===404)throw Error('当前后端尚不支持更新，请先安装带更新功能的后端版本。');
    let data;try{data=await r.json();}catch{throw Error('后端未返回有效结果，请检查插件是否已启用。');}
    if(!r.ok)throw Error(backendMessages[data.error]||'后端更新未完成，请查看服务器状态。');
    return data;
  }catch(error){if(error.name==='AbortError')throw Error('等待更新结果超时；后端操作可能仍在进行，请先查看状态。');throw error;}
  finally{clearTimeout(timer);controllers.delete(c);}
}
async function checkBackend(){
  backendStatus('正在读取后端状态……');
  try{const data=await backendRequest();backendStatus(data.restartRequired?'后端文件已更新，请手动重启酒馆后使用。':data.available?`后端 ${data.version} · 可从 GitHub 更新`:backendMessages[data.reason]||'后端暂不能更新。');}
  catch(error){backendStatus(error.message);}
}
async function updateBackend(){
  backendStatus('正在更新后端……');
  try{const data=await backendRequest(true);backendStatus(data.restartRequired?'后端文件已更新，请手动重启酒馆后使用。':`后端 ${data.version} 已是最新版本。`);}
  catch(error){backendStatus(error.message);}
}
const cacheMessages={backend_admin_required:'只有酒馆管理员可以管理缓存。',cache_unavailable:'缓存当前不可用，请查看酒馆日志。',cache_config_write_failed:'缓存设置未能保存，请检查插件目录权限。',cache_config_invalid:'缓存设置有误，请重试。',cache_clear_failed:'缓存清空失败，请稍后再试。'};
function cacheStatus(text){if(panel)panel.querySelector('[data-cache-status]').textContent=text;}
function formatBytes(value){const n=Number(value)||0;if(n<1024)return n+' B';const units=['KB','MB','GB'];let v=n/1024,i=0;while(v>=1024&&i<units.length-1){v/=1024;i++;}return v.toFixed(v>=10?0:1)+' '+units[i];}
async function cacheRequest(action,body){
  const c=new AbortController();controllers.add(c);const timer=setTimeout(()=>c.abort(),20000);
  try{
    const r=await fetch('/api/plugins/pica-relay/cache/'+action,{method:body?'POST':'GET',credentials:'same-origin',redirect:'error',cache:'no-store',headers:{...context()?.getRequestHeaders?.(),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:c.signal});
    let data={};try{data=await r.json();}catch{}
    if(!r.ok)throw Error(cacheMessages[data.error]||'缓存操作未完成，请稍后再试。');
    return data;
  }catch(error){if(error.name==='AbortError')throw Error('缓存操作超时，请稍后再试。');throw error;}
  finally{clearTimeout(timer);controllers.delete(c);}
}
function renderCache(data){
  if(!data)return;
  const config=data.config||{};
  const toggle=panel?.querySelector('[data-cache-enabled]');
  if(toggle)toggle.checked=config.enabled!==false;
  cacheStatus(`已缓存 ${formatBytes(data.bytes)} / ${formatBytes(data.maxBytes)} · ${data.entries||0} 条 · 命中 ${((Number(data.hitRate)||0)*100).toFixed(1)}%${(data.evictions||0)?` · 已淘汰 ${data.evictions} 条`:''}`);
}
async function checkCache(){cacheStatus('正在读取缓存……');try{renderCache(await cacheRequest('status'));}catch(error){cacheStatus(error.message);}}
async function clearCache(){cacheStatus('正在清空缓存……');try{const data=await cacheRequest('clear',{});renderCache(data);cacheStatus('缓存已清空。'+`当前 ${data.entries||0} 条。`);}catch(error){cacheStatus(error.message);}}
async function toggleCache(enabled){cacheStatus(enabled?'正在启用缓存……':'正在停用缓存……');try{const data=await cacheRequest('config',{enabled});renderCache(data);cacheStatus(enabled?'缓存已启用。':'缓存已停用，之后直接访问上游。');}catch(error){renderCache(await cacheRequest('status').catch(()=>null));cacheStatus(error.message);}}
async function bytes(relative,limit){
  const c=new AbortController();controllers.add(c);const timer=setTimeout(()=>c.abort(),20000);
  try{const r=await fetch(BASE+relative,{credentials:'same-origin',redirect:'error',headers:context()?.getRequestHeaders?.()||{},signal:c.signal,cache:'no-store'});if(!r.ok){if(r.status===503&&(await r.json().catch(()=>({}))).error==='reader_not_published')throw Error('前端尚未发布，待作者发布后再试。已有前端可继续使用。');throw Error('酒馆后端暂不可用，请确认插件已启用并重启酒馆。');}const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>limit)throw Error('下载文件超过大小限制。');chunks.push(chunk);}const out=new Uint8Array(size);let n=0;for(const chunk of chunks){out.set(chunk,n);n+=chunk.length;}return out;}finally{clearTimeout(timer);controllers.delete(c);}
}
function current(){return findReaders(helper().getScriptTrees({type:'global'}));}
async function act(fn){if(busy)return;busy=true;panel.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){status(e?.message||'操作未完成，原脚本保留。');}finally{busy=false;if(panel){panel.querySelectorAll('button').forEach(b=>b.disabled=false);panel.querySelector('[data-install]').disabled=!latest;panel.querySelector('[data-undo]').disabled=!backup;}}}
async function check(){
  status('正在检查前端版本……');latest=null;
  const text=new TextDecoder('utf-8',{fatal:true}).decode(await bytes('channels/stable.json',65536));
  const m=parseRelease(text);
  if(m.loaderApi!==1||m.dataSchema!==1||!m.script||m.script.entry!==`releases/${m.version}/script.json`||!Number.isInteger(m.script.bytes)||m.script.bytes<1||m.script.bytes>3*1024*1024||!/^[a-f0-9]{64}$/.test(m.script.sha256))throw Error('前端版本合同不兼容。');
  const installed=current();if(installed.length>1)throw Error('助手里有多份哔咔脚本，请先确认保留哪份。');
  latest=m;panel.querySelector('[data-install]').textContent=installed.length?'更新前端入口':'安装并启用前端';
  status(`可用前端 ${m.version}。${installed.length?'已有安装，更新将保留 ID、开关和数据。':'尚未安装，点击按钮将装入当前用户的全局脚本库。'}`);
}
async function install(){
  if(!latest)return;const target=latest;
  const data=await bytes(target.script.entry,3*1024*1024);
  if(data.length!==target.script.bytes||hashBytes(data)!==target.script.sha256)throw Error('安装包校验未通过，原脚本保持不变。');
  const script=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
  const h=helper(),old=current();backup=old[0]?structuredClone(old[0]):null;
  const id=old[0]?.id||'pica-'+Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');
  // Download first; the synchronous updater reads the latest tree at commit time.
  if(!alive)throw Error('安装入口已关闭。');
  h.updateScriptTreesWith(trees=>applyReader(trees,script,{newId:id,revision:target.version+':'+target.script.sha256}),{type:'global'});
  const observed=current();if(observed.length!==1||observed[0].id!==id||observed[0].content!==script.content)throw Error('助手保存结果与预期不符，请检查脚本库。');
  installedHash=hashBytes(new TextEncoder().encode(script.content));
  status(`已安装前端入口 ${target.version}。日常新版会自动检查并下载，阅读中延后生效；也可在阅读器“程序更新”中手动管理。`);
}
async function undo(){
  if(!backup)return;const h=helper(),now=current();
  if(now.length!==1||hashBytes(new TextEncoder().encode(now[0].content))!==installedHash)throw Error('脚本已被其他操作修改，不能直接撤销。');
  h.updateScriptTreesWith(trees=>applyReader(trees,backup,{restore:true}),{type:'global'});backup=null;status('已恢复本页更新前的入口。');
}
export function cleanup(){alive=false;for(const c of controllers)c.abort();controllers.clear();panel?.remove();panel=null;latest=null;backup=null;}
export function init(){
  if(alive)return;alive=true;
  const mount=()=>{
    if(!alive||panel)return;const parent=document.getElementById('extensions_settings2')||document.getElementById('extensions_settings');if(!parent)return;
    panel=document.createElement('div');panel.id='pica-distribution-settings';
    panel.innerHTML='<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header" role="button" tabindex="0" aria-expanded="false" aria-controls="pica-distribution-content"><b>哔咔后端</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down" aria-hidden="true"></div></div><div id="pica-distribution-content" class="inline-drawer-content"><div class="pica-distribution-section"><b>后端更新</b><p data-backend-status role="status" aria-live="polite">从 GitHub 更新，完成后需手动重启酒馆。</p><div class="pica-distribution-actions"><button class="menu_button" type="button" data-backend-check>查看状态</button><button class="menu_button" type="button" data-backend-update><i class="fa-solid fa-cloud-arrow-down" aria-hidden="true"></i>更新后端</button></div></div><div class="pica-distribution-section"><b>前端入口</b><p data-status role="status" aria-live="polite">需要已启用的酒馆助手。</p><div class="pica-distribution-actions"><button class="menu_button" type="button" data-check>检查前端版本</button><button class="menu_button" type="button" data-install disabled>安装并启用前端</button><button class="menu_button" type="button" data-undo disabled>撤销本页入口更新</button></div></div><div class="pica-distribution-section"><b>缓存</b><p data-cache-status role="status" aria-live="polite">图片与接口响应缓存在酒馆本地，重启后仍有效。</p><label class="pica-cache-toggle"><input type="checkbox" role="switch" data-cache-enabled> <span>启用缓存</span></label><div class="pica-distribution-actions"><button class="menu_button" type="button" data-cache-check>查看缓存</button><button class="menu_button" type="button" data-cache-clear>清空缓存</button></div></div></div></div>';
    const header=panel.querySelector('.inline-drawer-header');
    header.onclick=()=>header.setAttribute('aria-expanded',String(header.getAttribute('aria-expanded')!=='true'));
    header.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();header.click();}};
    parent.append(panel);panel.querySelector('[data-check]').onclick=()=>act(check);panel.querySelector('[data-install]').onclick=()=>act(install);panel.querySelector('[data-undo]').onclick=()=>act(undo);
    panel.querySelector('[data-backend-check]').onclick=()=>act(checkBackend);panel.querySelector('[data-backend-update]').onclick=()=>act(updateBackend);
    panel.querySelector('[data-cache-check]').onclick=()=>act(checkCache);panel.querySelector('[data-cache-clear]').onclick=()=>act(clearCache);
    panel.querySelector('[data-cache-enabled]').onchange=event=>act(()=>toggleCache(event.target.checked));
    act(async()=>{try{renderCache(await cacheRequest('status'));}catch(error){cacheStatus(error.message);}});
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
}
