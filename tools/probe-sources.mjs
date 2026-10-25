#!/usr/bin/env node
/**
 * Live probe for the extra source facade. Hits the real upstream, so it is a
 * diagnostic tool, not a unit test: `node tools/probe-sources.mjs [zai]`
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDiskCache} from '../cache.mjs';
import {createZaimanhua} from '../sources/zaimanhua.mjs';
import {createSourceFacade} from '../sources/facade.mjs';

const only = process.argv[2] || 'zai';
const dir = await mkdtemp(path.join(tmpdir(), 'pica-probe-'));
const cache = createDiskCache({dir, maxBytes: 64 * 1024 * 1024});
await cache.init();
const adapter = createZaimanhua({fetchImpl: globalThis.fetch, cache, log: console.warn});
const facade = createSourceFacade({adapter, fetchImpl: globalThis.fetch, cache, log: console.warn});

const call = async (pathname, init) => {
  const response = await facade.handle(new Request('http://probe.invalid' + pathname, init));
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!response.ok) throw new Error(`${pathname} -> ${response.status} ${text.slice(0, 200)}`);
  return data;
};

try {
  console.log('capabilities', JSON.stringify((await call('/capabilities')).imageProxy));
  const categories = (await call('/api/categories')).categories.map(c => c.title);
  console.log('categories', categories.length, categories.slice(0, 5));
  const home = await call('/api/collections');
  console.log('collections', home.collections.map(c => c.title + ':' + c.comics.length).join(' | '));
  const list = await call('/api/comics?s=dd&c=' + encodeURIComponent('再看·人气榜') + '&page=1');
  console.log('rank docs', list.comics.docs.length, list.comics.docs[0]?.title, list.comics.docs[0]?._id);
  const search = await call('/api/comics/advanced-search?page=1', {method: 'POST', body: JSON.stringify({keyword: '妖精', sort: 'dd'})});
  console.log('search docs', search.comics.docs.length, search.comics.docs[0]?.title);
  const id = list.comics.docs[0]._id;
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('comic id is not 24-hex: ' + id);
  const detail = await call('/api/comics/' + id);
  console.log('detail', detail.comic.title, '| author:', detail.comic.author, '| finished:', detail.comic.finished);
  const eps = await call('/api/comics/' + id + '/eps?page=1');
  console.log('eps', eps.eps.docs.length, eps.eps.docs[0]?.title, '→', eps.eps.docs.at(-1)?.title);
  const pages = await call('/api/comics/' + id + '/order/1/pages?page=1');
  const first = pages.pages.docs[0];
  console.log('pages', pages.pages.docs.length, 'media path:', first?.media?.path);
  const u = new URL(first.media.fileServer + '/static/' + first.media.path);
  const imageResponse = await facade.handle(new Request(`http://probe.invalid/image/${u.hostname}/${u.pathname.slice(8)}`));
  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  console.log('image', imageResponse.status, bytes.length, 'bytes, type', imageResponse.headers.get('content-type'), 'cache', imageResponse.headers.get('x-pica-source-cache'));
  const again = await facade.handle(new Request(`http://probe.invalid/image/${u.hostname}/${u.pathname.slice(8)}`));
  console.log('image again cache header', again.headers.get('x-pica-source-cache'));
  if (only === 'zai') console.log('OK zai end to end');
} finally {
  await cache.close();
  await rm(dir, {recursive: true, force: true});
}
