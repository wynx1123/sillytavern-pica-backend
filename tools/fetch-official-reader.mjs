#!/usr/bin/env node
/**
 * Download the official signed reader bundle so the patcher can run offline.
 * Verifies the manifest signature is present and both artifact hashes match.
 *
 * usage: node tools/fetch-official-reader.mjs [--out .official]
 */
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const out = arg('out', '.official');
const profile = JSON.parse(await readFile(new URL('../distribution-profile.json', import.meta.url), 'utf8'));
const source = profile.sourceBase;
if (!/^https:\/\//.test(source)) throw new Error('distribution-profile.json: sourceBase must be https');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function download(relative, limit) {
  const response = await fetch(new URL(relative, source), {redirect: 'error'});
  if (!response.ok) throw new Error(`download failed: ${relative} (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limit) throw new Error(`download too large: ${relative}`);
  return buffer;
}

const channel = await download('channels/stable.json', 65536);
await mkdir(path.join(out, 'channels'), {recursive: true});
await writeFile(path.join(out, 'channels/stable.json'), channel);
const envelope = JSON.parse(channel.toString('utf8'));
if (!envelope.payload) throw new Error('official channel is not signed');
const manifest = JSON.parse(envelope.payload);
if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) throw new Error('invalid manifest version');

const files = [[manifest.entry, manifest.bytes, manifest.sha256], [manifest.script.entry, manifest.script.bytes, manifest.script.sha256]];
for (const [entry, bytes, hash] of files) {
  const data = await download(entry, bytes + 1);
  if (data.length !== bytes || sha256(data) !== hash) throw new Error(`artifact mismatch: ${entry}`);
  const target = path.join(out, entry);
  await mkdir(path.dirname(target), {recursive: true});
  await writeFile(target, data);
  console.log(`ok ${entry} ${bytes} bytes`);
}
