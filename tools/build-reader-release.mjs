#!/usr/bin/env node
/**
 * Build the fixed Pica reader from a patched app.mjs and the official
 * TavernHelper script.json.
 *
 * Outputs (in --out):
 *   app.mjs                              ES module (for a custom update source)
 *   pica-reader-fixed-<version>.json     TavernHelper script, drop-in import
 *   release/channels/stable.json         unsigned manifest for a custom source
 *   release/releases/<version>/app.mjs   module served by that source
 *
 * The inline script keeps the whole app in its fallback slot and disables the
 * official update source, so an official release can never silently overwrite
 * the fix. Users can still point "更新源" at the generated release/ folder.
 */
import {readFileSync, writeFileSync, mkdirSync, copyFileSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';

const APP_MARKER = '/* APK-based comic frontend.';
const BOOT_MARKER = '/* This boot path remains installed; remote code runs in this helper iframe. */';
const OFFICIAL_ID = '08aecdc6-6fc0-4f47-80a4-ddbb5fa9bf29';

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const out = arg('out', 'dist');
const version = arg('version', '1.0.2');
const appPath = arg('app', path.join(out, 'app.mjs'));
const scriptPath = arg('script');
if (!scriptPath) {
  console.error('usage: node tools/build-reader-release.mjs --script official-script.json --app dist/app.mjs --out dist --version 1.0.2');
  process.exit(2);
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const appModule = readFileSync(appPath);
const appText = appModule.toString('utf8');
const appAt = appText.indexOf(APP_MARKER);
if (appAt < 0) throw new Error('app.mjs: frontend marker not found');
const appRegion = appText.slice(appAt).replace(/export const release = \{[\s\S]*?\};\s*export \{[^}]*\};\s*$/, '');
if (/^export /m.test(appRegion)) throw new Error('app.mjs: unexpected top-level export in app region');
if (!appRegion.includes('root.dataset.version = "' + version + '"')) throw new Error('app.mjs: version was not patched');

const official = JSON.parse(readFileSync(scriptPath, 'utf8'));
const content = official.content;
const bootAt = content.indexOf(BOOT_MARKER);
const headAt = content.indexOf(APP_MARKER);
if (bootAt < 0 || headAt < 0 || headAt > bootAt) throw new Error('official script: markers not found');

let head = content.slice(0, headAt);
let boot = content.slice(bootAt);

// 1. The fork must not auto-install official releases over the fix.
boot = boot.replace(/const distributionProfile=\{[^\n]*?\};/, m => {
  if (!m.includes('"sourceBase"')) return m;
  return m.replace(/"sourceBase":\s*"[^"]*"/, '"sourceBase": ""');
});
if (!/const distributionProfile=\{[^\n]*"sourceBase": ""/.test(boot)) throw new Error('official script: distribution profile not found');
boot = boot.replace("initialSource:installData.tw_pica_update_source==='tavern'?'tavern':'',", "initialSource:'',");

// 3. Use a separate update store. The official boot keeps its active 1.0.1 record
// in IndexedDB under this name; sharing it would silently mount the old bundle
// instead of the fixed fallback.
if (!head.includes("'tw.pica.reader.updates.v1'")) throw new Error('official script: update store name not found');
head = head.replaceAll("'tw.pica.reader.updates.v1'", "'tw.pica.reader.updates.v1.fix'");

// 2. The embedded fallback is this build, not the official 1.0.1.
const fallbackMatch = boot.match(/fallback:\{release:(\{.*?\}),mount:mountPicaReader\}/s);
if (!fallbackMatch) throw new Error('official script: fallback release not found');
const fallback = JSON.parse(fallbackMatch[1]);
const built = Buffer.from(head + appRegion + boot);
Object.assign(fallback, {
  version,
  entry: `releases/${version}/app.mjs`,
  bytes: appModule.length,
  sha256: sha256(appModule),
  publishedAt: new Date().toISOString(),
  notes: '修复读三页后停住需要收起再打开：图片预取窗口扩大到约两屏、滚动几何兜底、自动续载加超时看门狗、跳页锚点不再回拉；新增阅读器内存图片缓存。',
});
const rebuilt = built.toString('utf8').replace(fallbackMatch[0], `fallback:{release:${JSON.stringify(fallback)},mount:mountPicaReader}`);
if (rebuilt === built.toString('utf8')) throw new Error('official script: fallback patch did not apply');

mkdirSync(path.join(out, 'release', 'channels'), {recursive: true});
mkdirSync(path.join(out, 'release', 'releases', version), {recursive: true});
writeFileSync(arg('script-out', path.join(out, `pica-reader-fixed-${version}.json`)), JSON.stringify({
  type: 'script',
  enabled: true,
  name: '哔咔悬浮阅读器（修复版）',
  id: OFFICIAL_ID,
  content: rebuilt,
  info: `v${version} 修复版：解决读到三页后必须收起再打开才能继续的问题，并加入阅读器图片内存缓存。导入前请先停用或删除原版脚本，避免两份哔咔脚本同时存在。`,
  button: {enabled: false, buttons: []},
  data: {tw_pica_package: 'pica-reader'},
  export_with: {data: false, button: false},
}));
copyFileSync(appPath, path.join(out, 'release', 'releases', version, 'app.mjs'));
writeFileSync(path.join(out, 'release', 'channels', 'stable.json'), JSON.stringify({
  schemaVersion: 1,
  version,
  loaderApi: 1,
  dataSchema: 1,
  notes: fallback.notes,
  entry: `releases/${version}/app.mjs`,
  bytes: appModule.length,
  sha256: sha256(appModule),
  publishedAt: fallback.publishedAt,
}, null, 2) + '\n');

console.log(`built ${path.join(out, `pica-reader-fixed-${version}.json`)} (${rebuilt.length} chars)`);
console.log(`built ${path.join(out, 'release', 'channels', 'stable.json')}`);
console.log(`app ${appModule.length} bytes sha256 ${sha256(appModule)}`);
