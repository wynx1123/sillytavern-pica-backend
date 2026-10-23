import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDiskCache} from '../cache.mjs';
import {forwardPica} from '../core.mjs';
import {forwardImage} from '../images.mjs';

const CID = 'a'.repeat(24);
const BASE = 'http://relay.local/api/';

function jsonRequest(pathname, token = 'token-a') {
  return new Request(BASE + pathname, {headers: {'x-pica-authorization': token}});
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {status: 200, headers: {'Content-Type': 'application/json; charset=utf-8'}});
}

test('API GET responses are cached per account scope', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pica-api-'));
  const cache = createDiskCache({dir});
  let calls = 0;
  const fetchImpl = async () => { calls++; return jsonResponse({code: 200, data: {pages: {docs: [], total: 1, pages: 1, limit: 40, page: 1}}}); };

  const first = await forwardPica(jsonRequest(`comics/${CID}/order/1/pages?page=1`), {fetchImpl, cache, authorizationHeader: 'x-pica-authorization'});
  assert.equal(first.headers.get('x-pica-cache'), 'miss');
  const second = await forwardPica(jsonRequest(`comics/${CID}/order/1/pages?page=1`), {fetchImpl, cache, authorizationHeader: 'x-pica-authorization'});
  assert.equal(second.headers.get('x-pica-cache'), 'hit');
  assert.equal(calls, 1);

  // A different account must not see the first account's cached payload.
  const other = await forwardPica(jsonRequest(`comics/${CID}/order/1/pages?page=1`, 'token-b'), {fetchImpl, cache, authorizationHeader: 'x-pica-authorization'});
  assert.equal(other.headers.get('x-pica-cache'), 'miss');
  assert.equal(calls, 2);
  await cache.close();
  await rm(dir, {recursive: true, force: true});
});

test('caching is skipped for per-user and random endpoints', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pica-api-'));
  const cache = createDiskCache({dir});
  let calls = 0;
  const fetchImpl = async () => { calls++; return jsonResponse({code: 200, data: {user: {_id: 'b'.repeat(24)}}}); };
  await forwardPica(jsonRequest('users/profile'), {fetchImpl, cache, authorizationHeader: 'x-pica-authorization'});
  await forwardPica(jsonRequest('users/profile'), {fetchImpl, cache, authorizationHeader: 'x-pica-authorization'});
  assert.equal(calls, 2);
  assert.equal(cache.stats().entries, 0);
  await cache.close();
  await rm(dir, {recursive: true, force: true});
});

test('API POST is never cached', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pica-api-'));
  const cache = createDiskCache({dir});
  let calls = 0;
  const fetchImpl = async () => { calls++; return jsonResponse({code: 200, data: {}}); };
  for (let i = 0; i < 2; i++) {
    await forwardPica(new Request(BASE + 'auth/sign-in', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}), {fetchImpl, cache, authorizationHeader: 'x-pica-authorization'});
  }
  assert.equal(calls, 2);
  assert.equal(cache.stats().entries, 0);
  await cache.close();
  await rm(dir, {recursive: true, force: true});
});

test('image responses stream through and are cached on completion', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pica-img-'));
  const cache = createDiskCache({dir});
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 6)); controller.enqueue(bytes.subarray(6)); controller.close(); },
    });
    return new Response(stream, {status: 200, headers: {'Content-Type': 'image/png'}});
  };
  const url = 'http://relay.local/image/storage-b.picacomic.com/mock/p001.png';
  const first = await forwardImage(new Request(url), {fetchImpl, cache, cors: false});
  assert.equal(first.headers.get('x-pica-cache'), 'miss');
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), bytes);
  // Give the stream's close handler a tick to persist the copy.
  await new Promise(r => setTimeout(r, 20));
  const second = await forwardImage(new Request(url), {fetchImpl, cache, cors: false});
  assert.equal(second.headers.get('x-pica-cache'), 'hit');
  assert.deepEqual(new Uint8Array(await second.arrayBuffer()), bytes);
  assert.equal(calls, 1);
  await cache.close();
  await rm(dir, {recursive: true, force: true});
});

test('non-200 upstream responses are not cached', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pica-img-'));
  const cache = createDiskCache({dir});
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('nope', {status: 404, headers: {'Content-Type': 'text/plain'}}); };
  const url = 'http://relay.local/image/storage-b.picacomic.com/mock/p404.png';
  await forwardImage(new Request(url), {fetchImpl, cache, cors: false});
  await forwardImage(new Request(url), {fetchImpl, cache, cors: false});
  assert.equal(calls, 2);
  assert.equal(cache.stats().entries, 0);
  await cache.close();
  await rm(dir, {recursive: true, force: true});
});
