import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {installBundledManager} from './manager-install.mjs';
try{
  const pluginDir=fileURLToPath(new URL('.',import.meta.url));
  const result=await installBundledManager({pluginDir});
  if(!result.bundled)throw Error('manager_bundle_missing');
  const config=await readFile(path.join(pluginDir,'../../config.yaml'),'utf8');
  console.log('哔咔后端管理栏安装完成。请手动重启酒馆，仍使用原来的启动方式。');
  if(!/^enableServerPlugins:\s*true\s*(?:#.*)?$/m.test(config))console.log('请先在酒馆 config.yaml 中设置 enableServerPlugins: true，再手动重启。');
  console.log('重启后刷新酒馆，在“扩展程序 → 哔咔后端”检查或安装前端。前端未发布时请稍后再试。');
}catch(error){
  const messages={manager_local_changes:'管理栏有本地修改，已保留原文件，请先备份并处理后再安装。',manager_path_unsafe:'安装目录含不安全的链接，已停止安装。',manager_host_invalid:'请将仓库放到酒馆 plugins 目录后再执行安装命令。',manager_bundle_invalid:'管理栏文件校验未通过，请重新下载完整后端。',manager_install_busy:'另一次安装尚未结束，请稍后再试。',manager_bundle_missing:'缺少配套管理栏，请使用完整的后端发布仓库。'};
  console.error(messages[error.code||error.message]||'管理栏安装未完成；请检查目录权限和完整的酒馆安装。');process.exitCode=1;
}
