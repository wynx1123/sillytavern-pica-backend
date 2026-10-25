import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDiskCache} from '../cache.mjs';
import {createZaimanhua, encodeId, decodeId, ZAI_IMAGE_HOSTS} from '../sources/zaimanhua.mjs';
import {createSourceFacade} from '../sources/facade.mjs';

const RANK = {errno: 0, errmsg: '', data: [
  {comic_id: 20844, title: '我家大师兄', authors: '剧象漫画', status: '连载中', cover: 'https://images.zaimanhua.com/img/webpic/7/a.jpg', types: '搞笑/仙侠', last_updatetime: 1536829243},
  {comic_id: 88255, title: '短篇测试', authors: '湖小', status: '短篇', cover: 'https://images.zaimanhua.com/webpic/6/b.jpg', types: '欢乐向', last_updatetime: 1700000000},
]};
const SEARCH = {errno: 0, errmsg: '', data: {list: [
  {id: 88255, comic_id: 0, title: '搜索命中', authors: '作者', status: '连载中', cover: 'https://images.zaimanhua.com/webpic/6/c.jpg', types: '爱情'},
], total: 1, page: 1, size: 20}};
const LATEST = {data: [{id: 0, comic_id: 777, title: '最新一本', authors: '某人', status: '已完结', cover: 'https://images.zaimanhua.com/webpic/6/d.jpg', types: '冒险', last_updatetime: 1790000000}]};
const FILTER = {errno: 0, errmsg: '', data: {comicList: [
  {id: 123, name: '分类命中', authors: '甲/乙', status: '连载中', cover: 'https://images.zaimanhua.com/webpic/6/e.jpg', types: '校园'},
], totalNum: 1}};
const PC2_DETAIL = {errno: 0, errmsg: '', data: {comicInfo: {
  id: 20844, title: '我家大师兄', description: '简介内容',
  cover: 'https://images.zaimanhua.com/img/webpic/7/a.jpg', last_updatetime: 1536829243,
  statusTagList: [{tagId: 2309, tagName: '连载中'}], cateTagList: [{tagId: 3262, tagName: '少年漫画'}],
  authorsTagList: [{tagId: 9904, tagName: '剧象漫画'}], zoneTagList: [{tagId: 2308, tagName: '内地'}],
  themeTagList: [{tagId: 7568, tagName: '搞笑'}, {tagId: 7900, tagName: '仙侠'}],
}}};
const PC_CHAPTERS = {errno: 0, errmsg: '', data: {data: {id: 20844, chapters: [
  {title: '连载', data: [
    {chapter_id: 77290, chapter_title: '307话', chapter_order: 349, updatetime: 1536829243},
    {chapter_id: 77291, chapter_title: '1话', chapter_order: 2, updatetime: 1500000000},
    {chapter_id: 77292, chapter_title: '2话', chapter_order: 3, updatetime: 1500000100},
  ]},
]}, readingRecord: null}};
const H5_PAGES = {errno: 0, errmsg: '', data: {data: {chapter_id: 77291, canRead: true,
  page_url_hd: ['https://images.zaimanhua.com/img/chapterpic%2F1%2F2%2Fa.jpg?sign=abc&t=1790000000', 'https://images.zaimanhua.com/img/chapterpic%2F1%2F2%2Fb.jpg?sign=def&t=1790000000'],
}}};
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3]);

function mockFetch(url) {
  const stock = [
    ['/comic/rank/list', RANK], ['/search/index', SEARCH], ['/comic/update/list', LATEST],
    ['/comic/filter/list', FILTER], ['comic2/comic/detail', PC2_DETAIL],
    ['/comic/detail/', PC_CHAPTERS], ['/comic/chapter/', H5_PAGES],
  ];
  if (String(url).includes('images.zaimanhua.com')) {
    return Promise.resolve(new Response(JPEG, {status: 200, headers: {'Content-Type': 'image/jpeg'}}));
  }
  if (String(url).includes('comic2/comic/detail')) {
    const id = Number(new URL(String(url)).searchParams.get('id'));
    return Promise.resolve(id === 20844 ? Response.json(PC2_DETAIL) : new Response('{}', {status: 404}));
  }
  for (const [needle, body] of stock) {
    if (String(url).includes(needle)) return Promise.resolve(Response.json(body));
  }
  return Promise.resolve(new Response('{}', {status: 404}));
}

const ID = encodeId(20844);
const call = (facade, pathname, init) => facade.handle(new Request('http://t.invalid' + pathname, init));

test('id encoding round trips and rejects foreign shapes', () => {
  assert.equal(ID.length, 24);
  assert.match(ID, /^[a-f0-9]{24}$/);
  assert.equal(decodeId(ID), 20844);
  assert.throws(() => decodeId('bbb' + '0'.repeat(21)));
  assert.throws(() => decodeId('aaa' + 'zz'.repeat(10) + '0'));
});

test('adapter maps lists, chapters and pages into Pica shapes', async () => {
  const adapter = createZaimanhua({fetchImpl: mockFetch});
  const rank = await adapter.list({category: '再看·人气榜', page: 1});
  assert.equal(rank.docs.length, 2);
  assert.equal(rank.docs[0]._id, ID);
  assert.equal(rank.docs[0].author, '剧象漫画');

  const search = await adapter.search({keyword: 'x', page: 1});
  assert.equal(search.docs[0]._id, encodeId(88255));

  const latest = await adapter.list({category: '再看·最新更新', page: 1});
  assert.equal(latest.docs[0]._id, encodeId(777));

  const byGenre = await adapter.list({category: '再看·校园', page: 1});
  assert.equal(byGenre.docs[0].title, '分类命中');

  const detail = await adapter.detail(ID);
  assert.equal(detail.title, '我家大师兄');
  assert.equal(detail.author, '剧象漫画');
  assert.equal(detail.finished, false);
  assert.deepEqual(detail.categories, ['少年漫画', '内地']);
  assert.deepEqual(detail.tags, ['搞笑', '仙侠']);

  const chapters = await adapter.chapters(ID);
  assert.equal(chapters.length, 3);
  assert.deepEqual(chapters.map(c => c.title), ['1话', '2话', '307话']);
  assert.deepEqual(chapters.map(c => c.order), [1, 2, 3]);

  const pages = await adapter.pages(ID, 1);
  assert.equal(pages.docs.length, 2);
  for (const row of pages.docs) {
    assert.match(row.media.path, /^[A-Za-z0-9_./~:+@=-]+$/);
    assert.ok(row.media.path.endsWith('.jpg'));
    assert.ok(ZAI_IMAGE_HOSTS.includes(new URL(row.media.fileServer).hostname));
    const target = adapter.imageUrl(new URL(row.media.fileServer).hostname, row.media.path);
    assert.ok(target && target.includes('sign='));
  }
  assert.equal(adapter.imageUrl('images.zaimanhua.com', 'zai/not-a-token.jpg'), null);
});

test('facade speaks the Pica protocol end to end', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pica-zai-'));
  const cache = createDiskCache({dir, maxBytes: 8 * 1024 * 1024});
  await cache.init();
  const facade = createSourceFacade({adapter: createZaimanhua({fetchImpl: mockFetch, cache}), fetchImpl: mockFetch, cache});
  try {
    const caps = await (await call(facade, '/capabilities')).json();
    assert.equal(caps.service, 'pica-tavern-relay');
    assert.equal(caps.protocolVersion, 1);
    assert.equal(caps.ready, true);
    assert.ok(caps.authModes.includes('public'));
    assert.equal(caps.imageProxy.path, '/image/');

    const profile = await (await call(facade, '/api/users/profile')).json();
    assert.match(profile.user._id, /^[a-f0-9]{24}$/);
    const signIn = await (await call(facade, '/api/auth/sign-in', {method: 'POST', body: JSON.stringify({email: 'a', password: 'b'})})).json();
    assert.ok(signIn.token);

    const categories = await (await call(facade, '/api/categories')).json();
    assert.ok(categories.categories.length > 30);
    assert.ok(categories.categories.every(c => c.active === true && !c.isWeb));

    const list = await (await call(facade, '/api/comics?s=dd&c=' + encodeURIComponent('再看·人气榜') + '&page=1')).json();
    assert.equal(list.comics.docs[0]._id, ID);
    assert.ok(Number.isInteger(list.comics.pages));

    const search = await (await call(facade, '/api/comics/advanced-search?page=1', {method: 'POST', body: JSON.stringify({keyword: 'x', sort: 'dd'})})).json();
    assert.equal(search.comics.docs[0].title, '搜索命中');

    const detail = await (await call(facade, '/api/comics/' + ID)).json();
    assert.equal(detail.comic.author, '剧象漫画');

    const eps = await (await call(facade, '/api/comics/' + ID + '/eps?page=1')).json();
    assert.deepEqual(eps.eps.docs.map(e => e.title), ['1话', '2话', '307话']);
    assert.ok(eps.eps.docs.every(e => Number.isInteger(e.order)));

    const pages = await (await call(facade, '/api/comics/' + ID + '/order/1/pages?page=1')).json();
    assert.equal(pages.pages.docs.length, 2);
    assert.equal(pages.pages.total, 2);
    assert.ok(pages.pages.docs.every(row => row.media && row.media.fileServer && row.media.path));

    const image = await call(facade, '/image/images.zaimanhua.com/' + pages.pages.docs[0].media.path);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('x-pica-source-cache'), 'miss');
    const again = await call(facade, '/image/images.zaimanhua.com/' + pages.pages.docs[0].media.path);
    assert.equal(again.headers.get('x-pica-source-cache'), 'hit');
    assert.deepEqual(Buffer.from(await again.arrayBuffer()), JPEG);

    // A Pica-shaped id from another id space is rejected, not crashed on.
    const foreign = await call(facade, '/api/comics/' + 'f'.repeat(24));
    assert.equal(foreign.status, 400);
    // Our own encoding but an unknown upstream id surfaces as 404.
    const unknown = await call(facade, '/api/comics/' + encodeId(999999));
    assert.equal(unknown.status, 404);
    const badRoute = await call(facade, '/api/users/favourite');
    assert.equal(badRoute.status, 404);
  } finally {
    await cache.close();
    await rm(dir, {recursive: true, force: true});
  }
});
