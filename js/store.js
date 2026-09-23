// Object storage for encrypted files. Everything this device writes lands in
// IndexedDB first and is queued in the outbox. In local mode the outbox just
// waits; once B2 is connected it drains in order (media before log segments).
import { idb } from './util.js';
import { S3 } from './s3.js';

const listeners = new Set();
export function onStoreEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(ev) { for (const fn of listeners) try { fn(ev); } catch {} }

let s3 = null;
let flushing = null;
let lastError = null;
let outboxCounter = Date.now() * 1000;

export const Store = {
  get remote() { return !!s3; },
  get lastError() { return lastError; },

  setRemote(cfg) { s3 = cfg ? new S3(cfg) : null; },
  client() { return s3; },

  // Save an encrypted object. pin = never evicted from the local cache.
  async put(key, data, { pin = false } = {}) {
    await idb.put('blobs', key, data);
    await idb.put('bmeta', key, { n: data.length, pin, at: Date.now() });
    await idb.put('outbox', key, { t: outboxCounter++, op: 'put' });
    emit({ type: 'outbox' });
    if (s3) this.flushSoon();
  },

  async del(key) {
    await idb.del('blobs', key);
    await idb.del('bmeta', key);
    const pending = await idb.get('outbox', key);
    if (!s3 && pending && pending.op === 'put') {
      // Never uploaded: nothing to delete remotely.
      await idb.del('outbox', key);
    } else {
      await idb.put('outbox', key, { t: outboxCounter++, op: 'del' });
    }
    emit({ type: 'outbox' });
    if (s3) this.flushSoon();
  },

  // Returns encrypted bytes (local copy, else download), or null.
  async get(key, { pin = false } = {}) {
    const local = await idb.get('blobs', key);
    if (local) {
      const m = await idb.get('bmeta', key);
      if (m && Date.now() - m.at > 60000) idb.put('bmeta', key, { ...m, at: Date.now() });
      return local;
    }
    if (!s3) return null;
    const data = await s3.get(key);
    if (!data) return null;
    await addDownload(data.length);
    await idb.put('blobs', key, data);
    await idb.put('bmeta', key, { n: data.length, pin, at: Date.now() });
    if (!pin) scheduleEvict();
    return data;
  },

  // Download without caching (used for probes and log reads).
  async fetchRemote(key) {
    if (!s3) return null;
    const d = await s3.get(key);
    if (d) await addDownload(d.length);
    return d;
  },

  async pendingCount() { return (await idb.keys('outbox')).length; },

  flushSoon() {
    clearTimeout(this._ft);
    this._ft = setTimeout(() => this.flush().catch(() => {}), 300);
  },

  // Drain the outbox in order. Stops at the first failure so later items
  // (like a log segment) never land before the media they reference.
  flush(onProgress) {
    if (!s3) return Promise.resolve(0);
    if (flushing) return flushing;
    flushing = (async () => {
      let done = 0;
      try {
        const items = (await idb.all('outbox')).sort((a, b) => a[1].t - b[1].t);
        for (const [key, it] of items) {
          if (it.op === 'put') {
            const data = await idb.get('blobs', key);
            if (data) await s3.put(key, data);
          } else if (it.op === 'del') {
            await s3.del(key);
          }
          const cur = await idb.get('outbox', key);
          if (cur && cur.t === it.t) await idb.del('outbox', key);
          done++;
          onProgress && onProgress(done, items.length);
          emit({ type: 'outbox' });
        }
        lastError = null;
      } catch (e) {
        lastError = e;
        emit({ type: 'error', error: e });
        throw e;
      } finally {
        flushing = null;
        scheduleEvict();
      }
      return done;
    })();
    return flushing;
  },

  async localBytes() {
    let n = 0;
    for (const [, m] of await idb.all('bmeta')) n += m.n;
    return n;
  },
};

// ---- download accounting (guarantee 7 in the plan) ----
function monthKey() { const d = new Date(); return `dl:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
async function addDownload(n) {
  const k = monthKey();
  await idb.put('kv', k, ((await idb.get('kv', k)) || 0) + n);
}
export async function monthDownloads() { return (await idb.get('kv', monthKey())) || 0; }

// ---- cache eviction (remote mode only) ----
let evictTimer = null;
export const cachePolicy = { limit: 2 * 1024 ** 3, isKept: () => false };
function scheduleEvict() {
  if (!s3 || evictTimer) return;
  evictTimer = setTimeout(async () => {
    evictTimer = null;
    try { await evict(); } catch {}
  }, 5000);
}
async function evict() {
  const pending = new Set(await idb.keys('outbox'));
  const metas = await idb.all('bmeta');
  let total = 0;
  const evictable = [];
  for (const [k, m] of metas) {
    total += m.n;
    if (!m.pin && !pending.has(k) && !cachePolicy.isKept(k)) evictable.push([k, m]);
  }
  if (total <= cachePolicy.limit) return;
  evictable.sort((a, b) => a[1].at - b[1].at);
  for (const [k, m] of evictable) {
    if (total <= cachePolicy.limit * 0.9) break;
    await idb.del('blobs', k);
    await idb.del('bmeta', k);
    total -= m.n;
  }
}
