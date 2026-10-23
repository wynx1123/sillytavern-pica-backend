import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDiskCache} from '../cache.mjs';

async function tempDir() { return mkdtemp(path.join(tmpdir(), 'pica-cache-')); }

test('disk cache: put/get, stats and clear', async () => {
  const dir = await tempDir();
  const cache = createDiskCache({dir, maxBytes: 1024 * 1024});
  await cache.put('k1', Buffer.from('hello'), {ttlMs: 60000, contentType: 'text/plain'});
  const hit = await cache.get('k1');
  assert.ok(hit);
  assert.equal(hit.data.toString(), 'hello');
  assert.equal(hit.meta.contentType, 'text/plain');
  const stats = cache.stats();
  assert.equal(stats.entries, 1);
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 0);
  await cache.clear();
  assert.equal(await cache.get('k1'), null);
  assert.equal(cache.stats().entries, 0);
  await cache.close();
  await rm(dir, {recursive: true, force: true});
});

test('disk cache: ttl expiry and persistence across instances', async () => {
  const dir = await tempDir();
  let clock = 1_000_000;
  const a = createDiskCache({dir, now: () => clock});
  await a.put('short', Buffer.from('x'), {ttlMs: 1000});
  await a.flush();
  assert.ok(await a.get('short'));
  clock += 2000;
  assert.equal(await a.get('short'), null);
  await a.put('long', Buffer.from('keep'), {ttlMs: 60_000});
  await a.flush();
  await a.close();

  const b = createDiskCache({dir, now: () => clock});
  const kept = await b.get('long');
  assert.ok(kept);
  assert.equal(kept.data.toString(), 'keep');
  await b.close();
  await rm(dir, {recursive: true, force: true});
});

test('disk cache: evicts least recently used entries', async () => {
  const dir = await tempDir();
  const cache = createDiskCache({dir, maxBytes: 250});
  await cache.put('a', Buffer.alloc(100, 1), {ttlMs: 60000});
  await cache.put('b', Buffer.alloc(100, 2), {ttlMs: 60000});
  await cache.get('a');
  await cache.put('c', Buffer.alloc(100, 3), {ttlMs: 60000});
  const stats = cache.stats();
  assert.ok(stats.bytes <= 250);
  assert.ok(stats.evictions >= 1);
  assert.ok(await cache.get('a'));
  // b was the least recently used, so it is the first to go when c needs room.
  assert.equal(await cache.get('b'), null);
  await cache.close();
  await rm(dir, {recursive: true, force: true});
});

test('disk cache: disabled cache is a no-op', async () => {
  const dir = await tempDir();
  const cache = createDiskCache({dir, enabled: false});
  await cache.put('k', Buffer.from('v'));
  assert.equal(await cache.get('k'), null);
  cache.setEnabled(true);
  await cache.put('k', Buffer.from('v'));
  assert.ok(await cache.get('k'));
  await cache.close();
  await rm(dir, {recursive: true, force: true});
});
