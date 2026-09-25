// Session, pairing codes, saving, and decrypted-image URLs.
import { idb, b64u, unb64u, randHex, wipeAll } from './util.js';
import { newMasterKey, importAes, wrapMaster, unwrapMaster, encrypt, decrypt, encryptJSON, decryptJSON } from './crypto.js';
import { Store, cachePolicy } from './store.js';
import { Archive, LIMIT } from './log.js';
import { processImage } from './images.js';

export const S = {
  raw: null,       // raw master key bytes (memory only, while unlocked)
  key: null,       // CryptoKey
  dev: null,
  archive: null,
  b2: null,        // decrypted B2 config
  hasPass: false,
};

export async function isSetUp() { return !!(await idb.get('kv', 'master')); }
export async function hasPasscode() { const w = await idb.get('kv', 'master'); return !!(w && !w.plain); }

// ---- codes ----
export function backupCode(raw = S.raw) { return 'ARCH1-' + b64u(raw); }
export function pairingCode() {
  return 'ARCHP1-' + b64u(new TextEncoder().encode(JSON.stringify({ k: b64u(S.raw), b2: S.b2 || null })));
}
export function parseCode(code) {
  const c = code.trim();
  if (c.startsWith('ARCH1-')) {
    const raw = unb64u(c.slice(6));
    if (raw.length !== 32) throw new Error('That code is the wrong length.');
    return { raw, b2: null };
  }
  if (c.startsWith('ARCHP1-')) {
    const o = JSON.parse(new TextDecoder().decode(unb64u(c.slice(7))));
    const raw = unb64u(o.k);
    if (raw.length !== 32) throw new Error('That code is the wrong length.');
    return { raw, b2: o.b2 || null };
  }
  throw new Error('That doesn’t look like a backup or pairing code.');
}

// ---- setup / lock ----
export async function createArchive({ raw = newMasterKey(), pass, b2 = null }) {
  await idb.put('kv', 'master', await wrapMaster(raw, pass));
  await idb.put('kv', 'dev', 'ph-' + randHex(4));
  await openSession(raw);
  if (b2) await saveB2(b2);
  try { await navigator.storage?.persist?.(); } catch {}
}

export async function unlock(pass) {
  const w = await idb.get('kv', 'master');
  const raw = await unwrapMaster(w, pass);
  await openSession(raw);
}

async function openSession(raw) {
  S.raw = raw;
  S.key = await importAes(raw);
  S.dev = await idb.get('kv', 'dev');
  S.hasPass = await hasPasscode();
  S.archive = new Archive(S.key, S.dev);
  const enc = await idb.get('kv', 'b2');
  S.b2 = enc ? await decryptJSON(S.key, enc) : null;
  Store.setRemote(S.b2);
  cachePolicy.limit = (await idb.get('kv', 'cacheLimit')) || 2 * 1024 ** 3;
  cachePolicy.isKept = k => isFavoriteKey(k);
  await S.archive.load();
}

export function lock() {
  S.raw = null; S.key = null; S.archive = null; S.b2 = null;
  Store.setRemote(null);
  urls.clear();
}

export async function changePasscode(pass) {
  await idb.put('kv', 'master', await wrapMaster(S.raw, pass));
  S.hasPass = !!pass;
}

export async function eraseDevice() {
  lock();
  await wipeAll();
}

// ---- B2 ----
export async function saveB2(cfg) {
  S.b2 = cfg;
  if (cfg) await idb.put('kv', 'b2', await encryptJSON(S.key, cfg));
  else await idb.del('kv', 'b2');
  Store.setRemote(cfg);
}

// Test a config: write, read back, delete a small encrypted probe in p/.
export async function testB2(cfg) {
  const prev = S.b2;
  Store.setRemote(cfg);
  try {
    const s3 = Store.client();
    const key = 'p/_probe-' + randHex(6);
    const payload = await encrypt(S.key, crypto.getRandomValues(new Uint8Array(32)));
    await s3.put(key, payload);
    const back = await s3.get(key);
    if (!back || back.length !== payload.length) throw new Error('Probe read-back didn’t match.');
    await s3.del(key);
    return await S.archive.probeRemote();
  } finally {
    Store.setRemote(prev);
  }
}

// ---- saving ----
function isFavoriteKey(k) {
  if (!S.archive) return false;
  for (const mid of S.archive.favorites) {
    const m = S.archive.media.get(mid);
    if (m && m.orig === k) return true;
  }
  return false;
}

// blobs: array of Blob/File. meta: {via, source, sourceURL, imageURL, gallery}
export async function saveImages(blobs, meta, onProgress) {
  const A = S.archive;
  const res = { saved: 0, dup: 0, full: 0, failed: 0, ids: [], errors: [] };
  let ops = [];
  const flushOps = async () => { if (ops.length) { await A.commit(ops); ops = []; } };
  // Every image in one batch shares a save time and keeps its place (bi), so a
  // folder import shows in folder order in both newest- and oldest-first views.
  const batchAt = Date.now();
  for (let i = 0; i < blobs.length; i++) {
    onProgress && onProgress(i, blobs.length);
    try {
      const img = await processImage(blobs[i]);
      const existing = A.byHash.get(img.hash);
      if (existing) {
        res.dup++;
        if (meta.gallery && !A.members.get(meta.gallery)?.has(existing)) {
          ops.push({ op: 'membership.add', gallery: meta.gallery, media: [existing] });
        }
        for (const tag of meta.tags || []) ops.push({ op: 'tag.add', tag, media: [existing] });
        continue;
      }
      const encOrig = await encrypt(S.key, img.bytes);
      const encThumb = await encrypt(S.key, img.thumb);
      if (A.usage() + encOrig.length + encThumb.length + 4096 > LIMIT) { res.full++; continue; }
      const mid = A.newId(), pid = A.newId();
      const orig = 'p/m/' + randHex(16), thumb = 'p/t/' + randHex(16);
      await Store.put(thumb, encThumb, { pin: true });
      await Store.put(orig, encOrig);
      ops.push({
        op: 'post.add', id: pid,
        source: meta.source || 'web', via: meta.via || null,
        sourceURL: meta.sourceURL || null, imageURL: meta.imageURL || null,
        pageTitle: null, author: null, caption: null, postedAt: null,
        savedAt: batchAt, bi: i, status: 'ready',
        media: [{ id: mid, orig, thumb, hash: img.hash, w: img.w, h: img.h,
          size: img.bytes.length, osize: encOrig.length, tsize: encThumb.length, type: img.type }],
      });
      if (meta.gallery) ops.push({ op: 'membership.add', gallery: meta.gallery, media: [mid] });
      for (const tag of meta.tags || []) ops.push({ op: 'tag.add', tag, media: [mid] });
      res.saved++;
      res.ids.push(mid);
      // Keep segments reasonably sized during bulk imports.
      if (ops.length >= 40) await flushOps();
    } catch (e) {
      console.error(e);
      res.failed++;
      res.errors.push(e.message || String(e));
    }
  }
  await flushOps();
  onProgress && onProgress(blobs.length, blobs.length);
  return res;
}

export function detectSource(url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\.|^m\.|^mobile\./, ''); } catch {}
  if (/(^|\.)(x|twitter)\.com$|(^|\.)twimg\.com$/.test(host)) return 'x';
  if (/(^|\.)instagram\.com$|(^|\.)cdninstagram\.com$/.test(host)) return 'instagram';
  if (/(^|\.)reddit\.com$|(^|\.)redd\.it$/.test(host)) return 'reddit';
  return 'web';
}

const IMG_EXT = /\.(jpe?g|png|webp|gif|heic|avif)(\?|#|$)/i;
const IMG_HOSTS = /^(pbs\.twimg\.com|i\.redd\.it|preview\.redd\.it|i\.imgur\.com)$/i;

// Try to download a link as an image (works only when the host allows it);
// otherwise keep it as a saved link, waiting for a later step to fetch its images.
export async function saveLinkOrImage(url, { gallery = null, sourceURL = null, tags = [] } = {}) {
  const A = S.archive;
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  const looksImage = IMG_EXT.test(url) || IMG_HOSTS.test(host);
  let why = '';
  if (looksImage) {
    try {
      const r = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      const type = r.headers.get('content-type') || '';
      if (r.ok && type.startsWith('image/')) {
        const blob = await r.blob();
        const res = await saveImages([blob], { via: 'link', source: detectSource(url), sourceURL, imageURL: url, gallery, tags });
        return { res, detail: `downloaded image (${type}, ${blob.size} B)` };
      }
      why = `HTTP ${r.status} ${type}`;
    } catch (e) {
      why = `blocked by the site (${e.name})`;
    }
  }
  for (const p of A.posts.values()) {
    if (!p.deleted && p.via === 'link' && p.status === 'pending' && p.sourceURL === url) {
      return { dup: true, message: 'That link is already saved.', detail: 'duplicate link' };
    }
  }
  await A.commit([{
    op: 'post.add', id: A.newId(), source: detectSource(url), via: 'link',
    sourceURL: url, imageURL: null, pageTitle: null, author: null, caption: null, postedAt: null,
    savedAt: Date.now(), status: 'pending', reason: looksImage ? 'The site doesn’t let apps download this image directly.' : null,
    gallery, tags, media: [],
  }]);
  return {
    message: looksImage ? 'Saved as a link: the site doesn’t allow direct downloads. Copy Image works instead.' : 'Link saved. Its images get fetched in a later step; for now, Copy Image saves the picture itself.',
    detail: looksImage ? `image download failed: ${why}; saved as link` : 'saved as link',
  };
}

export async function deletePosts(pids) {
  const A = S.archive;
  await A.commit(pids.map(id => ({ op: 'post.delete', id })));
  for (const pid of pids) {
    for (const mid of A.posts.get(pid)?.media || []) {
      const m = A.media.get(mid);
      for (const k of [m?.orig, m?.thumb]) if (k && k.startsWith('p/')) await Store.del(k);
      urls.drop(mid);
    }
  }
}

export async function deleteMedia(mids) {
  const A = S.archive;
  const postIds = new Set(mids.map(id => A.media.get(id)?.postId).filter(Boolean));
  const ops = [...postIds].map(id => ({ op: 'post.delete', id }));
  await A.commit(ops);
  // The phone removes its own files right away; files in c/ are the Mac's job.
  for (const pid of postIds) {
    for (const mid of A.posts.get(pid).media) {
      const m = A.media.get(mid);
      for (const k of [m.orig, m.thumb]) if (k && k.startsWith('p/')) await Store.del(k);
      urls.drop(mid);
    }
  }
}

// ---- decrypted object URLs (LRU) ----
class UrlCache {
  constructor(max) { this.max = max; this.map = new Map(); this.inflight = new Map(); }
  async get(id, key) {
    if (this.map.has(id)) { const u = this.map.get(id); this.map.delete(id); this.map.set(id, u); return u; }
    if (this.inflight.has(id)) return this.inflight.get(id);
    const p = (async () => {
      const data = await Store.get(key, { pin: key.includes('/t/') });
      if (!data) throw new Error('missing');
      const pt = await decrypt(S.key, data);
      const u = URL.createObjectURL(new Blob([pt]));
      this.map.set(id, u);
      while (this.map.size > this.max) {
        const [k, v] = this.map.entries().next().value;
        this.map.delete(k); URL.revokeObjectURL(v);
      }
      return u;
    })();
    this.inflight.set(id, p);
    try { return await p; } finally { this.inflight.delete(id); }
  }
  drop(id) { const u = this.map.get(id); if (u) { URL.revokeObjectURL(u); this.map.delete(id); } }
  clear() { for (const u of this.map.values()) URL.revokeObjectURL(u); this.map.clear(); }
}
const thumbs = new UrlCache(800);
const origs = new UrlCache(8);
export const urls = {
  thumb: m => thumbs.get(m.id, m.thumb),
  orig: m => origs.get(m.id, m.orig),
  drop: id => { thumbs.drop(id); origs.drop(id); },
  clear: () => { thumbs.clear(); origs.clear(); },
};

export { LIMIT };
