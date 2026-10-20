export const PRODUCT='pica-reader';
export function isReader(script){return script?.type==='script'&&(script.data?.tw_pica_package===PRODUCT||typeof script.content==='string'&&script.content.includes("Symbol.for('tw.pica.reader.v1')")&&script.content.includes('mountPicaReader'));}
export function findReaders(trees){return trees.flatMap(t=>t.type==='folder'?t.scripts:[t]).filter(isReader);}
export function applyReader(trees,script,{newId,restore=false,revision=''}={}){
  if(!isReader(script)||typeof script.content!=='string'||!script.content||typeof script.info!=='string')throw Error('下载文件不是哔咔前端脚本。');
  const existing=findReaders(trees);if(existing.length>1)throw Error('找到多份哔咔脚本，请先在助手里确认保留哪份。');
  const policy={tw_pica_package:PRODUCT,tw_pica_update_source:'tavern',tw_pica_install_revision:revision};
  if(!existing.length)return [...trees,{...script,id:newId,enabled:true,data:{...script.data,...policy}}];
  const old=existing[0];const updated=restore?script:{...old,content:script.content,info:script.info,data:{...old.data,...policy}};
  return trees.map(tree=>tree.type==='folder'?{...tree,scripts:tree.scripts.map(item=>item.id===old.id?updated:item)}:tree.id===old.id?updated:tree);
}
