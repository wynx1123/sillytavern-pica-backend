// Zaimanhua (再看漫画) adapter.
// API endpoints verified against keiyoushi/extensions-source zh.zaimanhua
// (v4api.zaimanhua.com, anonymous browsing works; paid chapters need an account).
import {createHash,randomBytes} from 'node:crypto';

const API = 'https://v4api.zaimanhua.com/app/v1';
const ACCOUNT = 'https://account-api.zaimanhua.com/v1';
export const ZAI_IMAGE_HOSTS = ['images.zaimanhua.com'];

const md5hex = value => createHash('md5').update(value).digest('hex');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// Reader-facing categories. Keys are the exact strings the reader sends back in
// `comics?s=dd&c=<title>`; values are the v4 API parameters for /comic/filter/list.
const CATEGORIES = [
  {title: '再看·人气榜', rank: {by_time: '3'}},
  {title: '再看·日榜', rank: {by_time: '0'}},
  {title: '再看·周榜', rank: {by_time: '1'}},
  {title: '再看·月榜', rank: {by_time: '2'}},
  {title: '再看·最新更新', latest: true},
  {title: '再看·连载中', filter: {status: '2309'}},
  {title: '再看·已完结', filter: {status: '2310'}},
  {title: '再看·短篇', filter: {status: '29205'}},
  {title: '再看·少年漫画', filter: {cate: '3262'}},
  {title: '再看·少女漫画', filter: {cate: '3263'}},
  {title: '再看·青年漫画', filter: {cate: '3264'}},
  {title: '再看·日本', filter: {zone: '2304'}},
  {title: '再看·韩国', filter: {zone: '2305'}},
  {title: '再看·欧美', filter: {zone: '2306'}},
  {title: '再看·港台', filter: {zone: '2307'}},
  {title: '再看·内地', filter: {zone: '2308'}},
  {title: '再看·爱情', filter: {theme: '8'}},
  {title: '再看·校园', filter: {theme: '13'}},
  {title: '再看·搞笑', filter: {theme: '7568'}},
  {title: '再看·热血', filter: {theme: '3248'}},
  {title: '再看·悬疑', filter: {theme: '3245'}},
  {title: '再看·神鬼', filter: {theme: '12'}},
  {title: '再看·治愈', filter: {theme: '3254'}},
  {title: '再看·萌系', filter: {theme: '3252'}},
  {title: '再看·冒险', filter: {theme: '4'}},
  {title: '再看·科幻', filter: {theme: '7'}},
  {title: '再看·历史', filter: {theme: '3250'}},
  {title: '再看·美食', filter: {theme: '3327'}},
  {title: '再看·职场', filter: {theme: '3328'}},
  {title: '再看·武侠', filter: {theme: '3324'}},
  {title: '再看·仙侠', filter: {theme: '7900'}},
  {title: '再看·东方', filter: {theme: '5077'}},
  {title: '再看·舰娘', filter: {theme: '13627'}},
  {title: '再看·轻小说', filter: {theme: '6316'}},
  {title: '再看·纯爱', filter: {theme: '3246'}},
  {title: '再看·百合', filter: {theme: '3243'}},
  {title: '再看·四格', filter: {theme: '17'}},
  {title: '再看·高清单行', filter: {theme: '4459'}},
];
const categoryByTitle = new Map(CATEGORIES.map(row => [row.title, row]));

export function createZaimanhua({fetchImpl = globalThis.fetch, cache = null, credentials = {}, log = () => {}} = {}) {
  let token = '';
  let tokenExpire = 0;

  async function apiGet(url, {platform, useCache = true} = {}) {
    const headers = {'User-Agent': UA, Accept: 'application/json'};
    if (platform) headers.Platform = platform;
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(url, {headers, redirect: 'error'});
    if (response.status === 401 && credentials.username && credentials.password) {
      await login(true);
      return fetchImpl(url, {headers: {...headers, authorization: `Bearer ${token}`}, redirect: 'error'});
    }
    if (!response.ok) throw Object.assign(new Error('zai_http_' + response.status), {status: response.status});
    return response.json();
  }

  async function login(force = false) {
    if (!credentials.username || !credentials.password) return '';
    if (!force && token && Date.now() < tokenExpire) return token;
    const body = new URLSearchParams({username: credentials.username, passwd: md5hex(credentials.password)});
    const response = await fetchImpl(`${ACCOUNT}/login/passwd`, {
      method: 'POST', headers: {'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded'},
      body: body.toString(), redirect: 'error',
    });
    const data = await response.json().catch(() => null);
    const next = data?.data?.user?.token || data?.data?.userInfo?.token || '';
    if (typeof next === 'string' && next) {
      token = next;
      // JWT payloads carry exp in seconds; refresh an hour early, renew daily otherwise.
      try {
        const payload = JSON.parse(Buffer.from(next.split('.')[1] || '', 'base64url').toString('utf8'));
        const exp = Number(payload.expirationTime || payload.exp || 0);
        tokenExpire = exp > 0 ? exp * 1000 - 3600000 : Date.now() + 12 * 3600000;
      } catch { tokenExpire = Date.now() + 12 * 3600000; }
    }
    return token;
  }

  const unwrap = data => {
    // /comic/update/list omits `errno` entirely; only a non-zero value is an error.
    if (data?.errno !== undefined && data.errno !== null && data.errno !== 0) {
      throw Object.assign(new Error(data?.errmsg || 'zai_api_error'), {status: 502});
    }
    return data?.data;
  };

  const cached = async (key, ttlMs, producer) => {
    if (!cache?.enabled) return producer();
    const hit = await cache.get(key).catch(() => null);
    if (hit) return JSON.parse(hit.data.toString('utf8'));
    const value = await producer();
    await cache.put(key, Buffer.from(JSON.stringify(value)), {ttlMs, contentType: 'application/json', kind: 'zai'}).catch(() => {});
    return value;
  };

  const toComic = row => ({
    _id: encodeId(Number(row.comic_id && row.comic_id !== 0 ? row.comic_id : row.id)),
    title: String(row.title || row.name || '未命名作品'),
    author: String(row.authors || '作者未标注'),
    categories: String(row.types || '').split(/[,/]/).map(s => s.trim()).filter(Boolean),
    finished: row.status === '已完结' ? true : row.status === '连载中' ? false : null,
    thumb: mediaFor(row.cover),
    epsCount: undefined,
    pagesCount: undefined,
    totalViews: Number(row.num) || undefined,
    totalLikes: undefined,
    updated_at: row.last_updatetime ? new Date(Number(row.last_updatetime) * 1000).toISOString() : undefined,
  });

  const pageOf = (list, page, perPage) => ({docs: list, total: list.length, page, limit: perPage, pages: 1});

  // image token registry: the reader can only express [A-Za-z0-9_./~:+@=-] paths,
  // but zaimanhua serves percent-encoded paths plus a signed query string.
  const imageTokens = new Map();
  function mediaFor(url) {
    if (!url || !/^https:\/\//.test(String(url))) return null;
    const u = new URL(String(url));
    if (!ZAI_IMAGE_HOSTS.includes(u.hostname)) return null;
    const token = randomBytes(12).toString('base64url');
    imageTokens.set(token, String(url));
    if (imageTokens.size > 20000) {
      const oldest = imageTokens.keys().next().value;
      imageTokens.delete(oldest);
    }
    return {fileServer: `https://${u.hostname}`, path: `zai/${token}.jpg`};
  }

  const adapter = {
    id: 'zai',
    label: '再看漫画',
    hosts: ZAI_IMAGE_HOSTS,
    authModes: ['public'],
    login,
    categories() {
      return CATEGORIES.map(row => ({title: row.title, active: true, isWeb: false}));
    },
    async collections() {
      const [rank, latest] = await Promise.all([
        adapter.list({category: '再看·人气榜', page: 1}),
        adapter.list({category: '再看·最新更新', page: 1}),
      ]);
      return [
        {title: '人气榜', comics: rank.docs.slice(0, 12)},
        {title: '最新更新', comics: latest.docs.slice(0, 12)},
      ];
    },
    async list({category, sort, page = 1}) {
      const def = categoryByTitle.get(String(category || '')) || categoryByTitle.get('再看·最新更新');
      const perPage = 20;
      if (def.rank) {
        const data = unwrap(await apiGet(`${API}/comic/rank/list?tag_id=0&by_time=${def.rank.by_time}&page=${page}`));
        const rows = Array.isArray(data) ? data : [];
        return {docs: rows.map(toComic), total: page * perPage, pages: 0, limit: perPage, page, hasNext: rows.length >= perPage};
      }
      if (def.latest) {
        const data = unwrap(await apiGet(`${API}/comic/update/list/0/${page}`));
        const rows = Array.isArray(data) ? data : [];
        return {docs: rows.map(toComic), total: page * perPage, pages: 0, limit: perPage, page, hasNext: rows.length >= perPage};
      }
      const params = new URLSearchParams({size: String(perPage), page: String(page), sortType: sort === 'va' ? '2' : '1', ...def.filter});
      const data = unwrap(await apiGet(`${API}/comic/filter/list?${params}`));
      const rows = data?.comicList || data?.list || [];
      const total = Number(data?.totalNum ?? data?.total ?? rows.length) || rows.length;
      return {docs: rows.map(toComic), total, pages: Math.ceil(total / perPage) || 1, limit: perPage, page, hasNext: page * perPage < total};
    },
    async search({keyword, page = 1}) {
      const perPage = 20;
      const params = new URLSearchParams({source: '0', size: String(perPage), keyword: String(keyword || ''), page: String(page)});
      const data = unwrap(await apiGet(`${API}/search/index?${params}`));
      const rows = data?.list || [];
      const total = Number(data?.total ?? rows.length) || rows.length;
      return {docs: rows.map(toComic), total, pages: Math.ceil(total / perPage) || 1, limit: perPage, page, hasNext: page * perPage < total};
    },
    async detail(hexId) {
      const id = decodeId(hexId);
      // The pc2 endpoint is the only one carrying authors/cate/zone/theme tags.
      const env = unwrap(await apiGet(`https://manhua.zaimanhua.com/api/v1/comic2/comic/detail?id=${id}`, {platform: 'pc'}));
      const info = env?.comicInfo || {};
      const tags = list => (Array.isArray(list) ? list.map(t => t.tagName).filter(Boolean) : []);
      const status = tags(info.statusTagList)[0];
      const comic = {
        _id: encodeId(id),
        title: String(info.title || '未命名作品'),
        author: tags(info.authorsTagList).join(' / ') || '作者未标注',
        categories: [...tags(info.cateTagList), ...tags(info.zoneTagList)],
        tags: tags(info.themeTagList),
        finished: status === '已完结',
        description: String(info.description || '暂无简介。'),
        thumb: mediaFor(info.cover),
        updated_at: info.last_updatetime ? new Date(Number(info.last_updatetime) * 1000).toISOString() : undefined,
      };
      return comic;
    },
    async chapters(hexId) {
      const id = decodeId(hexId);
      const env = unwrap(await apiGet(`${API}/comic/detail/${id}?_v=2.2.5`, {platform: 'pc'}));
      const inner = env?.data || env?.comicInfo || {};
      const groups = inner?.chapters || inner?.chapterList || [];
      const rows = groups.flatMap(group => (group?.data || []).map(item => ({...item, group: group?.title || ''})));
      rows.sort((a, b) => (a.chapter_order || 0) - (b.chapter_order || 0) || (a.chapter_id || 0) - (b.chapter_id || 0));
      if (!rows.length) throw Object.assign(new Error('zai_no_chapters'), {status: 404});
      return rows.map((row, index) => ({order: index + 1, title: String(row.chapter_title || row.chapter_name || `第 ${index + 1} 话`), chapterId: String(row.chapter_id), group: row.group}));
    },
    async pages(hexId, order) {
      const id = decodeId(hexId);
      const chapters = await adapter.chapters(hexId);
      const chapter = chapters[Number(order) - 1];
      if (!chapter) throw Object.assign(new Error('zai_chapter_missing'), {status: 404});
      const env = unwrap(await apiGet(`${API}/comic/chapter/${id}/${chapter.chapterId}?_v=2.2.5`, {platform: 'h5'}));
      const inner = env?.data || env?.comicInfo || {};
      if (inner?.canRead === false) throw Object.assign(new Error('zai_chapter_locked'), {status: 403});
      const urls = inner?.page_url_hd || inner?.page_url || [];
      if (!urls.length) throw Object.assign(new Error('zai_chapter_empty'), {status: 404});
      return {docs: urls.map(url => ({media: mediaFor(url)})).filter(row => row.media), total: urls.length, limit: urls.length, page: 1, pages: 1};
    },
    imageUrl(host, path) {
      const match = /^zai\/([A-Za-z0-9_-]+)\.jpg$/.exec(path || '');
      if (!match) return null;
      return imageTokens.get(match[1]) || null;
    },
    status() {
      return {id: 'zai', label: '再看漫画', hasAccount: !!(token || (credentials.username && credentials.password)), tokenValid: !!token && Date.now() < tokenExpire, categories: CATEGORIES.length};
    },
  };
  return adapter;
}

export function encodeId(numeric) {
  return 'aaa' + Number(numeric).toString(16).padStart(21, '0');
}
export function decodeId(hex) {
  if (typeof hex !== 'string' || !/^aaa[0-9a-f]{21}$/.test(hex)) throw Object.assign(new Error('zai_id_invalid'), {status: 400});
  return parseInt(hex.slice(3), 16);
}
