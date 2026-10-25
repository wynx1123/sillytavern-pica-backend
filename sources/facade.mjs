// Pica-compatible facade over a source adapter. The reader keeps speaking the
// Pica protocol (routes, shapes, image proxying), the adapter speaks its own
// upstream. One facade per source, mounted under /sources/<id>/.
import {CORS, reply, VERSION, SERVICE, capabilities} from '../core.mjs';

const FAKE_USER = {name: '游客', level: 2, slogan: '本线路无需登录，随便填都能进。', _id: 'ca11ab1e5eed0000000000fa'};
const GUEST_TOKEN = 'pica-source-guest';
const JSON_MAX = 4 * 1024 * 1024;

function jsonHeaders(state) {
  return {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Pica-Error-Origin': 'upstream', 'X-Pica-Source-Cache': state,
  };
}

export function createSourceFacade({adapter, fetchImpl = globalThis.fetch, cache = null, upstreamMode = 'direct', log = () => {}} = {}) {
  const json = (data, state = 'miss') => new Response(JSON.stringify(data), {status: 200, headers: jsonHeaders(state)});
  const fail = (status, error) => reply(status, {error}, {cors: false});

  async function readBody(request) {
    if (!request.body) return undefined;
    const reader = request.body.getReader(); const parts = []; let size = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) { await reader.cancel(); throw Object.assign(new Error('body_too_large'), {status: 413}); }
      parts.push(value);
    }
    return Buffer.concat(parts).toString('utf8');
  }

  async function cached(key, ttlMs, producer) {
    if (!cache?.enabled) return producer();
    const hit = await cache.get(key).catch(() => null);
    if (hit) return JSON.parse(hit.data.toString('utf8'));
    const value = await producer();
    await cache.put(key, Buffer.from(JSON.stringify(value)), {ttlMs, contentType: 'application/json', kind: adapter.id}).catch(() => {});
    return value;
  }

  const listEnvelope = (result, page) => ({
    comics: {
      docs: result.docs, total: result.total ?? result.docs.length,
      limit: result.limit || 20, page: result.page || page,
      pages: result.pages ?? Math.max(1, Math.ceil((result.total ?? result.docs.length) / (result.limit || 20))),
    },
  });

  async function handleApi(path, search, method, bodyText, request) {
    const page = Math.max(1, Number(search.get('page')) || 1);
    const sort = search.get('s') || 'dd';
    if (method === 'POST' && path === 'auth/sign-in') {
      try { const body = JSON.parse(bodyText || '{}'); await adapter.login?.(); if (body) return json({token: GUEST_TOKEN}); } catch {}
      return json({token: GUEST_TOKEN});
    }
    if (path === 'users/profile') return json({user: FAKE_USER});
    if (path === 'categories') {
      const categories = await cached(`${adapter.id}:categories`, 24 * 3600 * 1000, () => adapter.categories());
      return json({categories});
    }
    if (path === 'keywords') return json({keywords: []});
    if (path === 'collections') {
      const collections = await cached(`${adapter.id}:collections`, 5 * 60 * 1000, () => adapter.collections());
      return json({collections});
    }
    if (path === 'comics') {
      const category = search.get('c') || '';
      const kind = search.get('t') || '';
      const query = {category, page};
      const result = kind ? await adapter.search({keyword: kind, page}) : await adapter.list({...query, sort});
      return json(listEnvelope(result, page));
    }
    if (method === 'POST' && path === 'comics/advanced-search') {
      let keyword = '';
      try { keyword = String(JSON.parse(bodyText || '{}').keyword || ''); } catch {}
      const result = await adapter.search({keyword, page});
      return json(listEnvelope(result, page));
    }
    const detail = /^comics\/([a-f0-9]{24})$/.exec(path);
    if (detail) return json({comic: await cached(`${adapter.id}:comic:${detail[1]}`, 10 * 60 * 1000, () => adapter.detail(detail[1]))});
    const eps = /^comics\/([a-f0-9]{24})\/eps$/.exec(path);
    if (eps) {
      const chapters = await cached(`${adapter.id}:chapters:${eps[1]}`, 10 * 60 * 1000, () => adapter.chapters(eps[1]));
      return json({eps: {docs: chapters.map(c => ({order: c.order, title: c.title})), total: chapters.length, pages: 1, limit: 1000, page}});
    }
    const pages = /^comics\/([a-f0-9]{24})\/order\/([0-9]+)\/pages$/.exec(path);
    if (pages) {
      const result = await cached(`${adapter.id}:pages:${pages[1]}:${pages[2]}`, 10 * 60 * 1000, () => adapter.pages(pages[1], Number(pages[2])));
      return json({pages: {docs: result.docs, total: result.total, limit: result.limit, pages: 1, page: 1}});
    }
    const recommendation = /^comics\/([a-f0-9]{24})\/recommendation$/.exec(path);
    if (recommendation) return json({comics: []});
    return fail(404, 'route_not_allowed');
  }

  async function forwardSourceImage(request, url) {
    const target = adapter.imageUrl(url.searchParams.get('host'), decodeURIComponent((url.pathname.match(/^\/image\/[^/]+\/(.+)$/) || [])[1] || ''));
    if (!target) return fail(404, 'image_not_allowed');
    const cacheKey = `${adapter.id}:img:${target}`;
    if (cache?.enabled) {
      const hit = await cache.get(cacheKey).catch(() => null);
      if (hit) return new Response(hit.data, {headers: {'Content-Type': hit.meta.contentType || 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'X-Pica-Source-Cache': 'hit'}});
    }
    const upstream = await fetchImpl(target, {headers: {'User-Agent': 'Mozilla/5.0', Accept: 'image/*;q=0.8,*/*;q=0.5', Referer: 'https://m.zaimanhua.com/'}, redirect: 'error', signal: request.signal});
    if (!upstream.ok) { await upstream.body?.cancel(); return fail(502, 'image_upstream_failed'); }
    const type = (upstream.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!/^image\//.test(type)) { await upstream.body?.cancel(); return fail(502, 'image_type_rejected'); }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > 12 * 1024 * 1024) return fail(502, 'image_too_large');
    if (cache?.enabled) await cache.put(cacheKey, buffer, {ttlMs: cache.imageTtlMs, contentType: type, kind: adapter.id}).catch(() => {});
    return new Response(buffer, {headers: {'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Pica-Source-Cache': 'miss'}});
  }

  return {
    id: adapter.id,
    adapter,
    capabilities() {
      return {
        ...capabilities([adapter.authModes?.[0] || 'public'], true, upstreamMode),
        version: VERSION, networkMode: upstreamMode,
        imageProxy: {version: 1, path: '/image/', hosts: adapter.hosts},
      };
    },
    status() { return adapter.status?.() || {id: adapter.id, label: adapter.label}; },
    async handle(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      try {
        if (path === '/capabilities') return json(this.capabilities(), 'off');
        if (path.startsWith('/image/')) return await forwardSourceImage(request, url);
        if (!path.startsWith('/api/')) return fail(404, 'route_not_found');
        const apiPath = path.slice(5);
        const bodyText = request.method === 'POST' ? await readBody(request) : undefined;
        return await handleApi(apiPath, url.searchParams, request.method, bodyText, request);
      } catch (error) {
        const status = Number(error.status) || 502;
        log(`[pica-relay:${adapter.id}] ${status} ${error.message}`);
        return fail(status >= 400 && status < 500 ? status : 502, error.message.startsWith(adapter.id + '_') ? error.message : 'source_upstream_failed');
      }
    },
  };
}
