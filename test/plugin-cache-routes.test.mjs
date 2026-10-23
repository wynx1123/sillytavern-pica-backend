import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG = path.join(ROOT, 'cache.local.json');

function fakeRes() {
  const res = {statusCode: 200, headers: {}, body: null, sent: null};
  res.set = () => res;
  res.status = code => { res.statusCode = code; return res; };
  res.json = value => { res.body = value; return res; };
  res.send = value => { res.sent = value; return res; };
  return res;
}

function fakeRouter() {
  const routes = [];
  const add = method => (pattern, handler) => routes.push({method, pattern, handler});
  return {routes, get: add('GET'), post: add('POST'), use: (...args) => routes.push({method: '*', pattern: args[0], handler: args[1]})};
}

test('plugin exposes cache status/config/clear for admins only', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pica-plugin-cache-'));
  let previous = null;
  try { previous = await readFile(CONFIG, 'utf8'); } catch {}
  process.env.PICA_CACHE_DIR = path.join(dir, 'cache');
  const {init, exit} = await import('../index.mjs?cache-routes');
  const router = fakeRouter();
  await init(router);
  const route = (method, pattern) => router.routes.find(r => r.method === method && r.pattern === pattern)?.handler;
  assert.ok(route('GET', '/cache/status'));
  assert.ok(route('POST', '/cache/config'));
  assert.ok(route('POST', '/cache/clear'));

  const user = {user: {profile: {admin: true}}};
  const denied = fakeRes();
  await route('GET', '/cache/status')({user: {profile: {}}}, denied);
  assert.equal(denied.statusCode, 403);

  const status = fakeRes();
  await route('GET', '/cache/status')(user, status);
  assert.equal(status.statusCode, 200);
  assert.equal(typeof status.body.bytes, 'number');
  assert.equal(status.body.config.enabled, true);

  const patched = fakeRes();
  await route('POST', '/cache/config')({...user, body: {enabled: false, maxBytes: 64 * 1024 * 1024}}, patched);
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.body.config.enabled, false);
  assert.equal(patched.body.config.maxBytes, 64 * 1024 * 1024);

  const invalid = fakeRes();
  await route('POST', '/cache/config')({...user, body: {maxBytes: 1}}, invalid);
  assert.equal(invalid.statusCode, 400);

  const cleared = fakeRes();
  await route('POST', '/cache/clear')({...user, body: {}}, cleared);
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.body.entries, 0);
  await exit();
  await rm(dir, {recursive: true, force: true});
  if (previous === null) await unlink(CONFIG).catch(() => {});
  else await writeFile(CONFIG, previous);
  delete process.env.PICA_CACHE_DIR;
});
