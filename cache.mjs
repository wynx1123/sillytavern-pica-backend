// Disk-backed LRU cache for relay responses. No host storage, no credentials in
// file names, and every write is atomic so a crash never serves a torn file.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,unlink,readdir,stat} from 'node:fs/promises';
import path from 'node:path';

const INDEX_VERSION = 1;
const MAX_KEY = 2048;
const digest = value => createHash('sha256').update(value).digest('hex');

export function createDiskCache({
  dir,
  maxBytes = 512 * 1024 * 1024,
  imageTtlMs = 7 * 24 * 60 * 60 * 1000,
  apiTtlMs = 3 * 60 * 1000,
  maxEntries = 20000,
  now = Date.now,
  enabled = true,
} = {}) {
  if (!dir) throw new Error('cache_dir_required');
  let closed = false, ready = null, dirty = false, flushTimer = null, flushing = null;
  let entries = new Map();          // hash -> meta
  let bytes = 0;
  const inflight = new Map();
  const stats = {hits: 0, misses: 0, puts: 0, evictions: 0, errors: 0};

  const fileFor = hash => path.join(dir, hash + '.bin');
  const indexPath = path.join(dir, 'index.json');

  function scheduleFlush() {
    if (closed || flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, 600);
    flushTimer.unref?.();
  }

  async function flush() {
    if (!dirty) return;
    if (flushing) return flushing;
    dirty = false;
    flushing = (async () => {
      const payload = JSON.stringify({
        version: INDEX_VERSION, savedAt: now(),
        entries: Object.fromEntries(entries),
      });
      const temp = indexPath + '.tmp-' + randomUUID();
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(temp, payload, { mode: 0o600 });
        await rename(temp, indexPath);
      } catch {
        dirty = true;
        stats.errors++;
        await unlink(temp).catch(() => {});
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  async function load() {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await readFile(indexPath, 'utf8'));
      if (raw?.version !== INDEX_VERSION || !raw.entries || typeof raw.entries !== 'object') throw new Error('cache_index_invalid');
      const at = now();
      for (const [hash, meta] of Object.entries(raw.entries)) {
        if (!/^[a-f0-9]{64}$/.test(hash) || !meta || !Number.isFinite(meta.bytes) || !Number.isFinite(meta.expiresAt)) continue;
        if (meta.expiresAt <= at) continue;
        entries.set(hash, meta);
        bytes += meta.bytes;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') entries = new Map();
    }
    // Drop orphan files left by a crash between writeFile and index flush.
    try {
      const cutoff = now() - 60 * 60 * 1000;
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.bin')) continue;
        const hash = name.slice(0, -4);
        if (entries.has(hash)) continue;
        const file = path.join(dir, name);
        const info = await stat(file).catch(() => null);
        if (info && info.mtimeMs < cutoff) await unlink(file).catch(() => {});
      }
    } catch {}
  }

  async function evict(needBytes) {
    if (bytes + needBytes <= maxBytes && entries.size < maxEntries) return;
    const rows = [...entries.entries()].sort((a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0));
    const target = Math.max(0, Math.floor(maxBytes * 0.85) - needBytes);
    for (const [hash, meta] of rows) {
      if (bytes <= target && entries.size < maxEntries) break;
      if (!entries.delete(hash)) continue;
      bytes -= meta.bytes || 0;
      stats.evictions++;
      await unlink(fileFor(hash)).catch(() => {});
    }
    dirty = true;
  }

  const cache = {
    get enabled() { return enabled && !closed; },
    setEnabled(value) { enabled = !!value; return enabled; },
    get maxBytes() { return maxBytes; },
    setMaxBytes(value) { maxBytes = Math.max(1, Math.floor(Number(value) || 1)); },
    get imageTtlMs() { return imageTtlMs; },
    setImageTtlMs(value) { imageTtlMs = Math.max(1000, Math.floor(Number(value) || 1000)); },
    get apiTtlMs() { return apiTtlMs; },
    setApiTtlMs(value) { apiTtlMs = Math.max(1000, Math.floor(Number(value) || 1000)); },

    async init() { ready ||= load(); return ready; },

    async get(key, { touch = true } = {}) {
      if (!cache.enabled || typeof key !== 'string' || key.length > MAX_KEY) return null;
      await (ready ||= load());
      const hash = digest(key);
      const meta = entries.get(hash);
      if (!meta) { stats.misses++; return null; }
      if (meta.expiresAt <= now()) {
        entries.delete(hash); bytes -= meta.bytes || 0; dirty = true;
        await unlink(fileFor(hash)).catch(() => {});
        stats.misses++; return null;
      }
      let data;
      try { data = await readFile(fileFor(hash)); }
      catch {
        entries.delete(hash); bytes -= meta.bytes || 0; dirty = true; stats.misses++;
        return null;
      }
      if (data.length !== meta.bytes) {
        entries.delete(hash); bytes -= data.length; dirty = true; stats.misses++;
        await unlink(fileFor(hash)).catch(() => {});
        return null;
      }
      stats.hits++;
      if (touch) {
        const at = now();
        meta.lastAccess = at;   // keep in-memory LRU exact
        meta.hits = (meta.hits || 0) + 1;
        // Persist the touch at most once per 10 minutes: a reading session hits
        // hundreds of images and rewriting the whole index on every hit would
        // thrash the disk.
        if (at - (meta.persistedTouch || 0) > 10 * 60 * 1000) {
          meta.persistedTouch = at;
          dirty = true; scheduleFlush();
        }
      }
      return { data, meta };
    },

    async put(key, data, { ttlMs, contentType = '', kind = '' } = {}) {
      if (!cache.enabled || typeof key !== 'string' || key.length > MAX_KEY) return false;
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!buffer.length) return false;
      await (ready ||= load());
      const hash = digest(key), at = now();
      const ttl = Number.isFinite(ttlMs) ? ttlMs : imageTtlMs;
      const meta = {
        key: key.length > 512 ? key.slice(0, 512) : key,
        bytes: buffer.length, createdAt: at, lastAccess: at,
        expiresAt: at + Math.max(1000, ttl), contentType, kind, hits: 0, persistedTouch: at,
      };
      await evict(buffer.length);
      const file = fileFor(hash), temp = file + '.tmp-' + randomUUID();
      try {
        await writeFile(temp, buffer, { mode: 0o600 });
        await rename(temp, file);
      } catch {
        stats.errors++;
        await unlink(temp).catch(() => {});
        return false;
      }
      const old = entries.get(hash);
      if (old) bytes -= old.bytes || 0;
      entries.set(hash, meta);
      bytes += meta.bytes;
      stats.puts++;
      dirty = true; scheduleFlush();
      return true;
    },

    // Single-flight producer: concurrent misses for one key share one upstream call.
    async load(key, producer, options = {}) {
      const hit = await cache.get(key);
      if (hit) return { ...hit, cached: true };
      if (inflight.has(key)) return { ...(await inflight.get(key)), cached: true };
      const task = (async () => {
        const value = await producer();
        await cache.put(key, value.data, value);
        return value;
      })();
      inflight.set(key, task);
      try { return { ...(await task), cached: false }; }
      finally { inflight.delete(key); }
    },

    stats() {
      const rows = [...entries.values()];
      const oldest = rows.reduce((min, row) => Math.min(min, row.createdAt || Infinity), Infinity);
      return {
        enabled: cache.enabled, entries: entries.size, bytes,
        maxBytes, imageTtlMs, apiTtlMs,
        hits: stats.hits, misses: stats.misses,
        hitRate: stats.hits + stats.misses ? +(stats.hits / (stats.hits + stats.misses)).toFixed(4) : 0,
        puts: stats.puts, evictions: stats.evictions, errors: stats.errors,
        oldestAt: Number.isFinite(oldest) ? oldest : 0,
      };
    },

    async clear() {
      await (ready ||= load());
      for (const hash of [...entries.keys()]) await unlink(fileFor(hash)).catch(() => {});
      entries.clear(); bytes = 0; dirty = true;
      stats.hits = stats.misses = stats.puts = stats.evictions = stats.errors = 0;
      await flush();
      return true;
    },

    async flush() { return flush(); },
    async close() {
      closed = true;
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      await flush();
    },
  };
  return cache;
}
