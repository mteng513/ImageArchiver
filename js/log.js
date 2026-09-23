// The archive's change log (plan: "The change log"). Each device appends
// encrypted segments to its own area (p/e/ for the phone, c/e/ for the Mac).
// Segments are numbered per area so a reader can fetch "the next one" without
// listing the bucket. State is rebuilt by replaying every op in (ts, dev, seq)
// order.
import { idb, pad, randHex } from './util.js';
import { encryptJSON, decryptJSON } from './crypto.js';
import { Store } from './store.js';

export const LIMIT = 9 * 1000 ** 3; // our own 9 GB cap, under B2's free 10 GB
const AREAS = ['p', 'c'];

export class Archive {
  constructor(key, dev) {
    this.key = key;
    this.dev = dev;
    this.listeners = new Set();
    this.reset();
  }

  reset() {
    this.posts = new Map();
    this.media = new Map();
    this.byHash = new Map();
    this.galleries = new Map();
    this.members = new Map();
    this.arrangement = new Map(); // galleryId -> [mediaId, ...] custom order
    this.favorites = new Set();
    this.tags = new Map();      // mediaId -> Set(tag key)
    this.tagNames = new Map();  // tag key -> display name
    this.segBytes = 0;
    this.lastTs = 0;
    this._sorted = null;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this._sorted = null; for (const fn of this.listeners) try { fn(); } catch (e) { console.error(e); } }

  async load() {
    this.wseq = (await idb.get('kv', 'wseq')) || 0;
    this.opSeq = (await idb.get('kv', 'opseq')) || 0;
    const segs = await idb.all('segs');
    const ops = [];
    let bytes = 0;
    for (const [, data] of segs) {
      bytes += data.length;
      const seg = await decryptJSON(this.key, data);
      for (const op of seg.ops) ops.push(op);
    }
    this.reset();
    this.segBytes = bytes;
    ops.sort(cmpOp);
    for (const op of ops) this.apply(op);
    this.emit();
  }

  apply(op) {
    if (op.dev === this.dev && op.ts > this.lastTs) this.lastTs = op.ts;
    switch (op.op) {
      case 'post.add': {
        if (this.posts.has(op.id)) break;
        const { media = [], op: _o, ts, dev, seq, ...rest } = op;
        const post = { ...rest, media: media.map(m => m.id), deleted: false };
        this.posts.set(op.id, post);
        for (const m of media) {
          const mm = { ...m, postId: op.id, deleted: false };
          this.media.set(m.id, mm);
          if (m.hash && post.status !== 'link-only') this.byHash.set(m.hash, m.id);
        }
        break;
      }
      case 'post.update': {
        const p = this.posts.get(op.id);
        if (p && op.fields) { const { id, media, ...f } = op.fields; Object.assign(p, f); }
        break;
      }
      case 'post.delete': {
        const p = this.posts.get(op.id);
        if (!p || p.deleted) break;
        p.deleted = true;
        for (const mid of p.media) {
          const m = this.media.get(mid);
          if (!m) continue;
          m.deleted = true;
          if (this.byHash.get(m.hash) === mid) this.byHash.delete(m.hash);
          this.favorites.delete(mid);
          this.tags.delete(mid);
          for (const set of this.members.values()) set.delete(mid);
        }
        break;
      }
      case 'gallery.create':
        if (!this.galleries.has(op.id)) this.galleries.set(op.id, { id: op.id, name: op.name, order: op.ts, deleted: false });
        break;
      case 'gallery.rename': {
        const g = this.galleries.get(op.id);
        if (g) g.name = op.name;
        break;
      }
      case 'gallery.delete': {
        const g = this.galleries.get(op.id);
        if (g) { g.deleted = true; this.members.delete(op.id); this.arrangement.delete(op.id); }
        break;
      }
      case 'gallery.reorder':
        (op.ids || []).forEach((id, i) => { const g = this.galleries.get(id); if (g) g.order = i; });
        break;
      case 'gallery.arrange':
        // Full custom order for a gallery; an empty list clears it.
        if (this.galleries.has(op.id)) {
          if (op.media && op.media.length) this.arrangement.set(op.id, op.media.slice());
          else this.arrangement.delete(op.id);
        }
        break;
      case 'membership.add':
      case 'membership.remove': {
        const g = this.galleries.get(op.gallery);
        if (!g || g.deleted) break;
        let set = this.members.get(op.gallery);
        if (!set) this.members.set(op.gallery, set = new Set());
        for (const mid of [].concat(op.media)) {
          const m = this.media.get(mid);
          if (op.op === 'membership.add') { if (m && !m.deleted) set.add(mid); } else set.delete(mid);
        }
        break;
      }
      case 'favorite.set':
        for (const mid of [].concat(op.media)) {
          const m = this.media.get(mid);
          if (op.value && m && !m.deleted) this.favorites.add(mid); else this.favorites.delete(mid);
        }
        break;
      case 'tag.add':
      case 'tag.remove': {
        const key = tagKey(op.tag);
        if (!key) break;
        if (op.op === 'tag.add' && !this.tagNames.has(key)) this.tagNames.set(key, cleanTag(op.tag));
        for (const mid of [].concat(op.media)) {
          const m = this.media.get(mid);
          if (op.op === 'tag.add') {
            if (!m || m.deleted) continue;
            let set = this.tags.get(mid);
            if (!set) this.tags.set(mid, set = new Set());
            set.add(key);
          } else this.tags.get(mid)?.delete(key);
        }
        break;
      }
      case 'tag.rename': {
        const from = tagKey(op.from), to = tagKey(op.to);
        if (!from || !to) break;
        for (const set of this.tags.values()) if (set.delete(from)) set.add(to);
        this.tagNames.delete(from);
        this.tagNames.set(to, cleanTag(op.to));
        break;
      }
      case 'tag.delete': {
        const key = tagKey(op.tag);
        for (const set of this.tags.values()) set.delete(key);
        this.tagNames.delete(key);
        break;
      }
      default:
        // queue.done, review.* etc. belong to later phases; ignored here.
        break;
    }
  }

  // Append ops as a new encrypted segment in p/e/.
  async commit(ops) {
    if (!ops.length) return;
    const now = Date.now();
    for (const op of ops) {
      op.ts = Math.max(now, this.lastTs + 1);
      this.lastTs = op.ts;
      op.dev = this.dev;
      op.seq = ++this.opSeq;
    }
    const key = `p/e/${pad(this.wseq)}`;
    const data = await encryptJSON(this.key, { v: 1, ops });
    await Store.put(key, data, { pin: true });
    await idb.put('segs', key, data);
    this.wseq += 1;
    await idb.put('kv', 'wseq', this.wseq);
    await idb.put('kv', 'next:p', this.wseq);
    await idb.put('kv', 'opseq', this.opSeq);
    this.segBytes += data.length;
    for (const op of ops) this.apply(op);
    this.emit();
  }

  // Fetch any segments we haven't seen yet from both areas.
  async pull() {
    if (!Store.remote) return false;
    let changed = false;
    for (const area of AREAS) {
      let n = (await idb.get('kv', 'next:' + area)) || 0;
      for (;;) {
        const key = `${area}/e/${pad(n)}`;
        const data = await Store.fetchRemote(key);
        if (!data) break;
        await decryptJSON(this.key, data); // verify before storing
        await idb.put('segs', key, data);
        n++;
        changed = true;
        await idb.put('kv', 'next:' + area, n);
      }
      if (area === 'p' && n > (this.wseq || 0)) {
        this.wseq = n;
        await idb.put('kv', 'wseq', n);
      }
    }
    if (changed) await this.load();
    return changed;
  }

  // Connecting a bucket that already holds this archive's p/ segments while
  // this phone has unsent segments of its own (e.g. restored from a backup
  // code, then saved offline): renumber ours after the remote ones so nothing
  // is overwritten, then let pull() fetch the remote history.
  async reconcileRemote() {
    let r = 0;
    while (await Store.fetchRemote(`p/e/${pad(r)}`)) r++;
    const pending = (await idb.all('outbox'))
      .filter(([k, v]) => k.startsWith('p/e/') && v.op === 'put')
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const collide = pending.some(([k]) => parseInt(k.slice(4), 10) < r);
    if (collide) {
      let n = r;
      for (const [k, v] of pending) {
        const nk = `p/e/${pad(n++)}`;
        const data = await idb.get('blobs', k);
        await idb.put('blobs', nk, data);
        await idb.put('bmeta', nk, { n: data.length, pin: true, at: Date.now() });
        await idb.put('outbox', nk, v);
        await idb.put('segs', nk, data);
        for (const s of ['blobs', 'bmeta', 'outbox', 'segs']) await idb.del(s, k);
      }
      this.wseq = n;
      await idb.put('kv', 'wseq', n);
      await idb.put('kv', 'next:p', 0);
    } else if (r > (this.wseq || 0)) {
      await idb.put('kv', 'next:p', 0);
    }
  }

  // Before connecting a bucket: is it empty, ours, or someone else's?
  async probeRemote() {
    const first = await Store.fetchRemote(`p/e/${pad(0)}`) || await Store.fetchRemote(`c/e/${pad(0)}`);
    if (!first) return 'empty';
    try { await decryptJSON(this.key, first); return 'ours'; } catch { return 'foreign'; }
  }

  // ---- queries ----
  usage() {
    let n = this.segBytes;
    for (const m of this.media.values()) if (!m.deleted) n += (m.osize || 0) + (m.tsize || 0);
    return n;
  }

  sortedMedia() {
    if (this._sorted) return this._sorted;
    const out = [];
    for (const m of this.media.values()) {
      if (m.deleted) continue;
      const p = this.posts.get(m.postId);
      if (!p || p.deleted) continue;
      out.push(m);
    }
    const idx = new Map();
    for (const p of this.posts.values()) p.media.forEach((id, i) => idx.set(id, i));
    out.sort((a, b) => {
      const pa = this.posts.get(a.postId), pb = this.posts.get(b.postId);
      return (pb.savedAt - pa.savedAt) || (idx.get(a.id) - idx.get(b.id));
    });
    return (this._sorted = out);
  }

  inAnyGallery(mid) {
    for (const [gid, set] of this.members) if (set.has(mid) && !this.galleries.get(gid)?.deleted) return true;
    return false;
  }

  list(filter) {
    const all = this.sortedMedia();
    switch (filter.type) {
      case 'all': return all;
      case 'unsorted': return all.filter(m => !this.inAnyGallery(m.id));
      case 'fav': return all.filter(m => this.favorites.has(m.id));
      case 'gallery': { const s = this.members.get(filter.id) || new Set(); return all.filter(m => s.has(m.id)); }
      case 'tags': return all.filter(m => { const t = this.tags.get(m.id); return !!t && filter.tags.every(k => t.has(k)); });
      case 'untagged': return all.filter(m => !this.tags.get(m.id)?.size);
      case 'via': return all.filter(m => this.posts.get(m.postId).via === filter.via);
      case 'source': return all.filter(m => this.posts.get(m.postId).source === filter.source);
      default: return all;
    }
  }

  // [{key, name, count}] for tags on live images, most used first.
  tagList(within = null) {
    const counts = new Map();
    const ids = within ? within.map(m => m.id) : null;
    const iter = ids ? ids.map(id => [id, this.tags.get(id)]) : [...this.tags.entries()];
    for (const [mid, set] of iter) {
      if (!set) continue;
      const m = this.media.get(mid);
      if (!m || m.deleted) continue;
      for (const k of set) counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts].map(([key, count]) => ({ key, name: this.tagNames.get(key) || key, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  mediaTags(mid) {
    return [...(this.tags.get(mid) || [])].map(k => this.tagNames.get(k) || k).sort((a, b) => a.localeCompare(b));
  }

  links() {
    return [...this.posts.values()].filter(p => !p.deleted && p.via === 'link' && !p.media.length)
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  hasArrangement(gid) { return !!this.arrangement.get(gid)?.length; }

  // A gallery's images in its custom order. Images added after the last
  // arrangement come first (newest first), then the arranged ones.
  arranged(gid, list = this.list({ type: 'gallery', id: gid })) {
    const order = this.arrangement.get(gid);
    if (!order || !order.length) return list;
    const pos = new Map(order.map((id, i) => [id, i]));
    const fresh = list.filter(m => !pos.has(m.id));
    const placed = list.filter(m => pos.has(m.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
    return fresh.concat(placed);
  }

  galleryList() {
    return [...this.galleries.values()].filter(g => !g.deleted).sort((a, b) => a.order - b.order);
  }

  mediaGalleries(mid) {
    return this.galleryList().filter(g => this.members.get(g.id)?.has(mid));
  }

  newId() { return randHex(12); }
}

export function cleanTag(t) {
  return String(t || '').replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}
export function tagKey(t) { return cleanTag(t).toLowerCase(); }

function cmpOp(a, b) {
  return (a.ts - b.ts) || (a.dev < b.dev ? -1 : a.dev > b.dev ? 1 : 0) || (a.seq - b.seq);
}
