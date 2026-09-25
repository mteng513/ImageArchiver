// Pulls the embedded images out of a PDF, entirely on the phone, with no
// third-party code. JPEGs (DCTDecode) come out byte for byte as they were
// stored, so quality and duplicate hashes match the original files. Other
// images (Flate-compressed pixels, the usual home of PNGs) are decoded here
// and re-encoded as PNG. Images come back in reading order: page by page, in
// the order each page draws them. Masks, icons and spacers are skipped.
import { sha256hex } from './crypto.js';

const MIN_SIDE = 16;              // anything smaller is a spacer or bullet
const CANVAS_MAX = 16777216;      // iOS canvas area limit (4096 × 4096)

// ---------------------------------------------------------------- lexer
const isWS = b => b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;
const isDelim = b => b === 40 || b === 41 || b === 60 || b === 62 || b === 91 || b === 93 || b === 123 || b === 125 || b === 47 || b === 37;
const isDigit = b => b >= 48 && b <= 57;
const bytesOf = s => Uint8Array.from(s, c => c.charCodeAt(0));
const OBJ = bytesOf('obj'), STREAM = bytesOf('stream'), ENDSTREAM = bytesOf('endstream'), TRAILER = bytesOf('trailer');

class Ref { constructor(n, g) { this.n = n; this.g = g; } }
class Name { constructor(s) { this.s = s; } }
class Str { constructor(bytes) { this.bytes = bytes; } }
class Kw { constructor(s) { this.s = s; } }

class Lexer {
  constructor(b, p = 0) { this.b = b; this.p = p; }
  skipWS() {
    const b = this.b;
    for (;;) {
      while (this.p < b.length && isWS(b[this.p])) this.p++;
      if (b[this.p] !== 37) return;                       // % comment
      while (this.p < b.length && b[this.p] !== 10 && b[this.p] !== 13) this.p++;
    }
  }
  word() {
    const b = this.b, s = this.p;
    while (this.p < b.length && !isWS(b[this.p]) && !isDelim(b[this.p])) this.p++;
    let out = '';
    for (let i = s; i < this.p; i++) out += String.fromCharCode(b[i]);
    return out;
  }
  value(depth = 0) {
    if (depth > 64) throw new Error('PDF nesting too deep');
    this.skipWS();
    const b = this.b, c = b[this.p];
    if (this.p >= b.length) throw new Error('Unexpected end of PDF');
    if (c === 47) {                                       // /Name
      this.p++;
      return new Name(this.word().replace(/#([0-9a-fA-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16))));
    }
    if (c === 60 && b[this.p + 1] === 60) {               // << dict >>
      this.p += 2;
      const d = Object.create(null);
      for (;;) {
        this.skipWS();
        if (b[this.p] === 62 && b[this.p + 1] === 62) { this.p += 2; return d; }
        if (this.p >= b.length) throw new Error('Unterminated dictionary');
        const k = this.value(depth + 1);
        if (!(k instanceof Name)) throw new Error('Bad dictionary key');
        d[k.s] = this.value(depth + 1);
      }
    }
    if (c === 60) {                                       // <hex string>
      this.p++;
      const out = []; let hi = -1;
      while (this.p < b.length && b[this.p] !== 62) {
        const v = parseInt(String.fromCharCode(b[this.p++]), 16);
        if (Number.isNaN(v)) continue;
        if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
      }
      if (hi >= 0) out.push(hi * 16);
      this.p++;
      return new Str(Uint8Array.from(out));
    }
    if (c === 91) {                                       // [ array ]
      this.p++;
      const a = [];
      for (;;) {
        this.skipWS();
        if (b[this.p] === 93) { this.p++; return a; }
        if (this.p >= b.length) throw new Error('Unterminated array');
        a.push(this.value(depth + 1));
      }
    }
    if (c === 40) {                                       // (literal string)
      this.p++;
      const out = []; let nest = 1;
      while (this.p < b.length) {
        let ch = b[this.p++];
        if (ch === 92) {
          ch = b[this.p++];
          const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
          if (map[ch] !== undefined) out.push(map[ch]);
          else if (ch >= 48 && ch <= 55) {
            let v = ch - 48;
            for (let k = 0; k < 2 && b[this.p] >= 48 && b[this.p] <= 55; k++) v = v * 8 + b[this.p++] - 48;
            out.push(v & 255);
          } else if (ch === 13) { if (b[this.p] === 10) this.p++; }
          else if (ch !== 10) out.push(ch);
          continue;
        }
        if (ch === 40) nest++;
        if (ch === 41 && --nest === 0) break;
        out.push(ch);
      }
      return new Str(Uint8Array.from(out));
    }
    if (isDigit(c) || c === 43 || c === 45 || c === 46) { // number, or "n g R"
      const t = this.word();
      const n = Number(t);
      if (/^\d+$/.test(t)) {
        const save = this.p;
        this.skipWS();
        if (isDigit(b[this.p])) {
          const g = this.word();
          this.skipWS();
          if (/^\d+$/.test(g) && b[this.p] === 82 && (this.p + 1 >= b.length || isWS(b[this.p + 1]) || isDelim(b[this.p + 1]))) {
            this.p++;
            return new Ref(n, Number(g));
          }
        }
        this.p = save;
      }
      return Number.isFinite(n) ? n : 0;
    }
    const w = this.word();
    if (!w) { this.p++; return new Kw(String.fromCharCode(c)); }
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    return new Kw(w);
  }
}

function indexOfSeq(buf, seq, from) {
  const f = seq[0], n = seq.length;
  for (let i = buf.indexOf(f, from); i !== -1 && i <= buf.length - n; i = buf.indexOf(f, i + 1)) {
    let k = 1;
    while (k < n && buf[i + k] === seq[k]) k++;
    if (k === n) return i;
  }
  return -1;
}
const hasSeqAt = (buf, p, seq) => seq.every((v, k) => buf[p + k] === v);
const concat = (parts, total) => {
  const out = new Uint8Array(total ?? parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const arr = v => v == null ? [] : Array.isArray(v) ? v : [v];
const nameOf = v => v instanceof Name ? v.s : null;
const latin1 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; };

// ---------------------------------------------------------------- filters
async function pump(u8, fmt) {
  let ds;
  try { ds = new DecompressionStream(fmt); } catch { return null; }
  const w = ds.writable.getWriter();
  w.write(u8).catch(() => {});
  w.close().catch(() => {});
  const r = ds.readable.getReader();
  const chunks = []; let total = 0;
  try {
    for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); total += value.length; }
  } catch {
    // Truncated or trailing junk: keep what came out, as PDF readers do.
    if (!total) return null;
  }
  return concat(chunks, total);
}
async function inflate(u8) {
  return (await pump(u8, 'deflate')) || (await pump(u8, 'deflate-raw')) || (() => { throw new Error('Couldn’t decompress an image'); })();
}

function unpredict(data, p) {
  const pred = (p && p.Predictor) || 1;
  if (pred === 1) return data;
  const colors = p.Colors || 1, bpc = p.BitsPerComponent || 8, cols = p.Columns || 1;
  const bpp = Math.max(1, Math.ceil(colors * bpc / 8)), rowLen = Math.ceil(colors * bpc * cols / 8);
  if (pred === 2) {                                       // TIFF, 8-bit only
    if (bpc !== 8) throw new Error('Unsupported TIFF predictor');
    const out = data.slice();
    for (let r = 0; r + rowLen <= out.length; r += rowLen)
      for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const t = data[r * (rowLen + 1)], src = r * (rowLen + 1) + 1, dst = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (t) {
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: v = x;
      }
      out[dst + i] = v & 255;
    }
    prev = out.subarray(dst, dst + rowLen);
  }
  return out;
}

function asciiHex(u8) {
  const out = []; let hi = -1;
  for (const ch of u8) {
    if (ch === 62) break;
    const v = parseInt(String.fromCharCode(ch), 16);
    if (Number.isNaN(v)) continue;
    if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
  }
  if (hi >= 0) out.push(hi * 16);
  return Uint8Array.from(out);
}
function ascii85(u8) {
  const out = []; let tuple = [];
  const flush = n => {
    while (tuple.length < 5) tuple.push(84);
    let v = 0; for (const t of tuple) v = v * 85 + t;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n));
    tuple = [];
  };
  for (let i = 0; i < u8.length; i++) {
    const ch = u8[i];
    if (ch === 126) break;                                // ~>
    if (isWS(ch)) continue;
    if (ch === 122 && !tuple.length) { out.push(0, 0, 0, 0); continue; }
    tuple.push(ch - 33);
    if (tuple.length === 5) flush(4);
  }
  if (tuple.length) flush(tuple.length - 1);
  return Uint8Array.from(out);
}
function runLength(u8) {
  const out = [];
  for (let i = 0; i < u8.length;) {
    const n = u8[i++];
    if (n === 128) break;
    if (n < 128) { for (let k = 0; k <= n; k++) out.push(u8[i++]); }
    else { const v = u8[i++]; for (let k = 0; k < 257 - n; k++) out.push(v); }
  }
  return Uint8Array.from(out);
}

const CODECS = { DCTDecode: 'jpeg', DCT: 'jpeg', JPXDecode: 'jpx', JBIG2Decode: 'jbig2', CCITTFaxDecode: 'ccitt', CCF: 'ccitt' };
const CODEC_LABEL = { jpx: 'JPEG 2000', jbig2: 'JBIG2 (scanned black and white)', ccitt: 'CCITT fax' };

// ---------------------------------------------------------------- document
class PdfDoc {
  constructor(buf) { this.b = buf; this.objs = new Map(); this.trailers = []; }

  async load() {
    const b = this.b, L = new Lexer(b);
    let i = 0;
    while ((i = indexOfSeq(b, OBJ, i)) !== -1) {
      const at = i; i += 3;
      if (i < b.length && !isWS(b[i]) && !isDelim(b[i])) continue;
      // Walk back over "<num> <gen> ".
      let j = at - 1;
      if (j < 0 || !isWS(b[j])) continue;
      while (j >= 0 && isWS(b[j])) j--;
      const ge = j; while (j >= 0 && isDigit(b[j])) j--;
      if (j === ge || j < 0 || !isWS(b[j])) continue;
      while (j >= 0 && isWS(b[j])) j--;
      const ne = j; while (j >= 0 && isDigit(b[j])) j--;
      if (j === ne || (j >= 0 && !isWS(b[j]) && !isDelim(b[j]))) continue;
      const n = Number(latin1(b.subarray(j + 1, ne + 1)));
      L.p = at + 3;
      let val;
      try { val = L.value(); } catch { continue; }
      const rec = { n, val };
      L.skipWS();
      if (hasSeqAt(b, L.p, STREAM) && val && typeof val === 'object' && !(val instanceof Ref)) {
        let s = L.p + 6;
        if (b[s] === 13 && b[s + 1] === 10) s += 2; else if (b[s] === 10 || b[s] === 13) s++;
        const len = val.Length;
        let es = -1;
        if (typeof len === 'number' && s + len <= b.length) {
          let k = s + len; while (k < b.length && isWS(b[k])) k++;
          if (hasSeqAt(b, k, ENDSTREAM)) { rec.start = s; rec.end = s + len; es = k; }
        }
        if (es < 0) {
          es = indexOfSeq(b, ENDSTREAM, s);
          let e = es < 0 ? b.length : es;
          if (b[e - 1] === 10) e--;
          if (b[e - 1] === 13) e--;
          rec.start = s; rec.end = Math.max(s, e);
          if (len instanceof Ref) rec.lenRef = len;
        }
        i = es < 0 ? b.length : es + 9;
      } else {
        i = Math.max(i, L.p);
      }
      this.objs.set(n, rec);                              // later copies win (incremental updates)
    }
    // Stream lengths stored as separate objects.
    for (const rec of this.objs.values()) {
      if (!rec.lenRef) continue;
      const len = this.get(rec.lenRef);
      if (typeof len === 'number' && rec.start + len <= b.length) rec.end = rec.start + len;
    }
    // Objects packed inside object streams (PDF 1.5+). Streams themselves never are.
    for (const rec of [...this.objs.values()]) {
      if (nameOf(rec.val?.Type) !== 'ObjStm' || rec.start == null) continue;
      try {
        const data = await this.data(rec);
        const L2 = new Lexer(data);
        const count = this.get(rec.val.N) || 0, first = this.get(rec.val.First) || 0;
        const pairs = [];
        for (let k = 0; k < count; k++) pairs.push([L2.value(), L2.value()]);
        for (const [num, off] of pairs) {
          if (this.objs.has(num)) continue;
          try { L2.p = first + off; this.objs.set(num, { n: num, val: L2.value() }); } catch {}
        }
      } catch {}
    }
    // Trailers: classic ones, plus cross-reference streams.
    let t = 0;
    while ((t = indexOfSeq(b, TRAILER, t)) !== -1) {
      L.p = t + 7; t += 7;
      try { const d = L.value(); if (d && typeof d === 'object') this.trailers.push(d); } catch {}
    }
    for (const rec of this.objs.values()) if (nameOf(rec.val?.Type) === 'XRef') this.trailers.push(rec.val);
    this.encrypted = this.trailers.some(d => d.Encrypt != null);
  }

  get(v, depth = 0) {
    while (v instanceof Ref && depth++ < 32) v = this.objs.get(v.n)?.val;
    return v instanceof Ref ? undefined : v;
  }
  rec(v) { return v instanceof Ref ? this.objs.get(v.n) : null; }

  // Decoded stream bytes. Stops at an image codec (JPEG etc.) and says which.
  async decode(rec) {
    let data = this.b.subarray(rec.start, rec.end);
    const filters = arr(this.get(rec.val.Filter)).map(f => nameOf(this.get(f)));
    const parms = arr(this.get(rec.val.DecodeParms)).map(p => this.get(p));
    for (let k = 0; k < filters.length; k++) {
      const f = filters[k];
      if (CODECS[f]) return { data, codec: CODECS[f] };
      if (f === 'FlateDecode' || f === 'Fl') data = unpredict(await inflate(data), parms[k]);
      else if (f === 'ASCIIHexDecode' || f === 'AHx') data = asciiHex(data);
      else if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data);
      else if (f === 'RunLengthDecode' || f === 'RL') data = runLength(data);
      else throw new Error(`Unsupported compression (${f})`);
    }
    return { data, codec: null };
  }
  async data(rec) {
    const r = await this.decode(rec);
    if (r.codec) throw new Error('Unexpected image data');
    return r.data;
  }

  get root() {
    for (const d of this.trailers) { const r = this.get(d.Root); if (r) return r; }
    for (const rec of this.objs.values()) if (nameOf(rec.val?.Type) === 'Catalog') return rec.val;
    return null;
  }

  // Image object numbers in reading order, each with its page number.
  async imageOrder() {
    const pages = [];
    const seenNodes = new Set();
    const walk = (node, res, depth) => {
      const d = this.get(node);
      if (!d || typeof d !== 'object' || depth > 64) return;
      if (node instanceof Ref) { if (seenNodes.has(node.n)) return; seenNodes.add(node.n); }
      const r = d.Resources !== undefined ? d.Resources : res;
      if (d.Kids !== undefined) for (const k of arr(this.get(d.Kids))) walk(k, r, depth + 1);
      else pages.push({ d, res: r });
    };
    const root = this.root;
    if (root) walk(root.Pages, undefined, 0);

    const out = [], seen = new Set();
    const DO = /\/([^\s/[\]<>(){}%]+)\s+Do\b/g;
    const visit = async (content, res, page, depth) => {
      const xo = this.get(this.get(res)?.XObject) || {};
      let names;
      try { names = [...latin1(content).matchAll(DO)].map(m => m[1].replace(/#([0-9a-fA-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16)))); }
      catch { names = []; }
      if (!names.length) names = Object.keys(xo);
      for (const name of names) {
        const ref = xo[name];
        const rec = this.rec(ref);
        if (!rec || seen.has(rec.n)) continue;
        seen.add(rec.n);
        const sub = nameOf(this.get(rec.val?.Subtype));
        if (sub === 'Image') out.push({ n: rec.n, page });
        else if (sub === 'Form' && depth < 12 && rec.start != null) {
          let inner = new Uint8Array(0);
          try { inner = await this.data(rec); } catch {}
          await visit(inner, rec.val.Resources !== undefined ? rec.val.Resources : res, page, depth + 1);
        }
      }
    };
    for (let p = 0; p < pages.length; p++) {
      const parts = [];
      for (const c of arr(this.get(pages[p].d.Contents))) {
        const rec = this.rec(c) || this.rec(pages[p].d.Contents);
        if (!rec || rec.start == null) continue;
        try { parts.push(await this.data(rec), new Uint8Array([10])); } catch {}
      }
      await visit(concat(parts), pages[p].res, p + 1, 0);
    }
    this.pageCount = pages.length;
    if (out.length) return out;

    // No usable page tree: every image object in file order, minus masks.
    const masks = new Set();
    for (const rec of this.objs.values()) {
      for (const k of ['SMask', 'Mask']) if (rec.val?.[k] instanceof Ref) masks.add(rec.val[k].n);
    }
    for (const rec of this.objs.values()) {
      if (nameOf(this.get(rec.val?.Subtype)) === 'Image' && !masks.has(rec.n) && rec.start != null) out.push({ n: rec.n, page: null });
    }
    return out;
  }

  async colorSpace(v, depth = 0) {
    const cs = this.get(v);
    if (depth > 8) throw new Error('Color space loop');
    const byName = s => {
      if (['DeviceGray', 'G', 'CalGray'].includes(s)) return { kind: 'gray', n: 1 };
      if (['DeviceRGB', 'RGB', 'CalRGB'].includes(s)) return { kind: 'rgb', n: 3 };
      if (['DeviceCMYK', 'CMYK'].includes(s)) return { kind: 'cmyk', n: 4 };
      return null;
    };
    if (cs == null) return { kind: 'gray', n: 1 };
    if (cs instanceof Name) {
      const r = byName(cs.s);
      if (r) return r;
      throw new Error(`Unsupported color space (${cs.s})`);
    }
    if (Array.isArray(cs)) {
      const fam = nameOf(this.get(cs[0]));
      const simple = byName(fam);
      if (simple) return simple;
      if (fam === 'ICCBased') {
        const s = this.rec(cs[1]);
        const n = this.get(s?.val?.N);
        if (n === 1) return { kind: 'gray', n: 1 };
        if (n === 3) return { kind: 'rgb', n: 3 };
        if (n === 4) return { kind: 'cmyk', n: 4 };
        if (s?.val?.Alternate) return this.colorSpace(s.val.Alternate, depth + 1);
        throw new Error('Unsupported ICC color space');
      }
      if (fam === 'Indexed' || fam === 'I') {
        const base = await this.colorSpace(cs[1], depth + 1);
        const hival = this.get(cs[2]) | 0;
        let lookup = this.get(cs[3]);
        const lrec = this.rec(cs[3]);
        if (lrec && lrec.start != null) lookup = await this.data(lrec);
        else if (lookup instanceof Str) lookup = lookup.bytes;
        else throw new Error('Missing color table');
        return { kind: 'indexed', n: 1, base, hival, lookup };
      }
      throw new Error(`Unsupported color space (${fam})`);
    }
    throw new Error('Unsupported color space');
  }

  // Pixels of an image object as RGBA. Used for non-JPEG images and masks.
  async pixels(rec, { maskOnly = false } = {}) {
    const d = rec.val;
    const w = this.get(d.Width) | 0, h = this.get(d.Height) | 0;
    if (!w || !h) throw new Error('Image has no size');
    const { data, codec } = await this.decode(rec);
    if (codec === 'jpeg') return browserPixels(new Blob([data], { type: 'image/jpeg' }), w, h);
    if (codec) throw new Error(`Unsupported format (${CODEC_LABEL[codec] || codec})`);

    const stencil = !!this.get(d.ImageMask);
    const bpc = stencil ? 1 : (this.get(d.BitsPerComponent) || 8);
    const cs = stencil || maskOnly ? { kind: 'gray', n: 1 } : await this.colorSpace(d.ColorSpace);
    const n = cs.n;
    const dec = arr(this.get(d.Decode)).map(x => this.get(x));
    const rowBytes = Math.ceil(w * n * bpc / 8);
    const maxv = bpc === 16 ? 255 : (1 << bpc) - 1;
    const read = bpc === 8 ? (row, i) => data[row + i]
      : bpc === 16 ? (row, i) => data[row + i * 2]
      : (row, i) => { const bit = i * bpc; return (data[row + (bit >> 3)] >> (8 - bpc - (bit & 7))) & maxv; };
    const colorKey = Array.isArray(this.get(d.Mask)) ? this.get(d.Mask).map(x => this.get(x)) : null;
    const out = new Uint8ClampedArray(w * h * 4);
    const comp = new Array(4);
    for (let y = 0; y < h; y++) {
      const row = y * rowBytes;
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        let keyed = !!colorKey;
        for (let c = 0; c < n; c++) {
          const raw = read(row, x * n + c) || 0;
          if (keyed && !(raw >= colorKey[2 * c] && raw <= colorKey[2 * c + 1])) keyed = false;
          if (cs.kind === 'indexed') comp[c] = dec.length >= 2 ? Math.round(dec[0] + raw * (dec[1] - dec[0]) / maxv) : raw;
          else {
            let f = raw / maxv;
            if (dec.length >= 2 * (c + 1)) f = dec[2 * c] + f * (dec[2 * c + 1] - dec[2 * c]);
            comp[c] = f;
          }
        }
        let r, g, b;
        if (cs.kind === 'indexed') {
          const idx = Math.min(comp[0], cs.hival), bn = cs.base.n, L = cs.lookup;
          const k = idx * bn;
          if (cs.base.kind === 'gray') r = g = b = L[k] ?? 0;
          else if (cs.base.kind === 'rgb') { r = L[k] ?? 0; g = L[k + 1] ?? 0; b = L[k + 2] ?? 0; }
          else [r, g, b] = cmyk(L[k] / 255, L[k + 1] / 255, L[k + 2] / 255, L[k + 3] / 255);
        } else if (n === 1) r = g = b = comp[0] * 255;
        else if (n === 3) { r = comp[0] * 255; g = comp[1] * 255; b = comp[2] * 255; }
        else [r, g, b] = cmyk(comp[0], comp[1], comp[2], comp[3]);
        out[o] = r; out[o + 1] = g; out[o + 2] = b;
        out[o + 3] = keyed ? 0 : 255;
      }
    }
    return { w, h, rgba: out };
  }

  // One image object → { blob, w, h, type, codec } or null when it should be skipped.
  async image(n) {
    const rec = this.objs.get(n);
    const d = rec.val;
    const w = this.get(d.Width) | 0, h = this.get(d.Height) | 0;
    if (this.get(d.ImageMask) || w < MIN_SIDE || h < MIN_SIDE) return null;
    const { data, codec } = await this.decode(rec);
    if (codec === 'jpeg') {
      // Original JPEG bytes where they display correctly as a standalone file.
      // A soft mask (transparency) on a JPEG is dropped.
      const dec = arr(this.get(d.Decode)).map(x => this.get(x));
      return jpegOut(data, dec, w, h);
    }
    if (codec === 'jpx') {
      const blob = new Blob([data], { type: 'image/jp2' });
      try { const bm = await createImageBitmap(blob); bm.close?.(); }
      catch { throw new Error('Unsupported format (JPEG 2000)'); }
      return { blob, w, h, type: 'image/jp2', kept: true };
    }
    if (codec) throw new Error(`Unsupported format (${CODEC_LABEL[codec] || codec})`);
    if (w * h > CANVAS_MAX) throw new Error(`Too large to convert on the phone (${w} × ${h})`);

    const px = await this.pixels(rec);
    const sm = this.rec(d.SMask), mk = this.rec(d.Mask);
    if (sm || mk) {
      try {
        const m = await this.pixels(sm || mk, { maskOnly: true });
        const stencil = !sm;
        for (let y = 0; y < h; y++) {
          const my = Math.min(m.h - 1, Math.floor(y * m.h / h));
          for (let x = 0; x < w; x++) {
            const mx = Math.min(m.w - 1, Math.floor(x * m.w / w));
            const v = m.rgba[(my * m.w + mx) * 4];
            // Soft mask: gray level is opacity. Stencil mask: 1 (white here) hides the pixel.
            px.rgba[(y * w + x) * 4 + 3] = stencil ? (v > 127 ? 0 : 255) : v;
          }
        }
      } catch { /* keep the image opaque */ }
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(px.rgba, w, h), 0, 0);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    c.width = c.height = 0;
    if (!blob) throw new Error('Couldn’t convert an image');
    return { blob, w, h, type: 'image/png', kept: false };
  }
}

// ---------------------------------------------------------------- JPEG fixes
// A PDF reads a JPEG's samples as stored, then applies the image's /Decode
// array ([1 0 …] means inverted). A standalone JPEG has no /Decode, and
// decoders disagree about CMYK: some treat stored CMYK as inverted
// ("Adobe" style) only when an Adobe marker is present, others always do.
// So: gray and RGB JPEGs with an inverting /Decode are decoded and fixed
// pixel by pixel; CMYK JPEGs get their Adobe marker added or disabled
// (a lossless byte edit) so this browser shows what the PDF means.

function jpegInfo(u8) {
  if (u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
  let i = 2, nf = 0, adobe = null;
  while (i + 4 <= u8.length) {
    if (u8[i] !== 0xFF) return null;
    const m = u8[i + 1];
    if (m === 0xFF) { i++; continue; }                       // fill byte
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD8)) { i += 2; continue; }
    if (m === 0xDA || m === 0xD9) break;                     // start of scan
    const len = (u8[i + 2] << 8) | u8[i + 3];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) nf = u8[i + 9];
    if (m === 0xEE && len >= 12 && u8[i + 4] === 0x41 && u8[i + 5] === 0x64 && u8[i + 6] === 0x6F && u8[i + 7] === 0x62 && u8[i + 8] === 0x65) {
      adobe = { pos: i, transform: u8[i + 15] };
    }
    i += 2 + len;
  }
  return { nf, adobe };
}
const ADOBE_SEG = [0xFF, 0xEE, 0x00, 0x0E, 0x41, 0x64, 0x6F, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00];
function withAdobe(u8) {
  const out = new Uint8Array(u8.length + ADOBE_SEG.length);
  out.set(u8.subarray(0, 2)); out.set(ADOBE_SEG, 2); out.set(u8.subarray(2), 2 + ADOBE_SEG.length);
  return out;
}
function withoutAdobe(u8, pos) {
  const out = u8.slice();
  out[pos + 8] = 0x78;                                        // "Adobe" → "Adobx": decoders ignore it
  return out;
}

// How does this browser read CMYK JPEGs? Probe once with a tiny 8×8 CMYK JPEG
// whose stored samples are all 0 (white if read as-is, black if read inverted).
const PROBE = '/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/8AAFAgACAAIBEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAA4EQwBNAFkASwAAPwD8qq/Kqvyqr8qq/9k=';
let cmykMode;
function probeCmyk() {
  if (cmykMode) return cmykMode;
  const withMarker = Uint8Array.from(atob(PROBE), c => c.charCodeAt(0));
  const noMarker = new Uint8Array(withMarker.length - 16);
  noMarker.set(withMarker.subarray(0, 2)); noMarker.set(withMarker.subarray(18), 2);
  const inverts = async u8 => {
    try {
      const px = await browserPixels(new Blob([u8], { type: 'image/jpeg' }));
      return px.rgba[0] < 128;                                // dark = read as inverted
    } catch { return null; }
  };
  cmykMode = Promise.all([inverts(withMarker), inverts(noMarker)]).then(([marker, plain]) => ({ marker, plain }));
  return cmykMode;
}

// A small baseline JPEG decoder, used only for CMYK JPEGs this browser would
// show inverted. Returns the raw component planes at full size.
const ZZ = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const COS = (() => {
  const t = new Float64Array(64);
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) t[x * 8 + u] = (u ? 1 : Math.SQRT1_2) * Math.cos((2 * x + 1) * u * Math.PI / 16) / 2;
  return t;
})();

function huffTable(counts, symbols) {
  const maxcode = new Int32Array(18).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    valptr[len] = k; mincode[len] = code;
    code += counts[len - 1]; k += counts[len - 1];
    maxcode[len] = counts[len - 1] ? code - 1 : -1;
    code <<= 1;
  }
  return { maxcode, valptr, mincode, symbols };
}

export function decodeBaselineJpeg(u8) {
  const u16 = p => (u8[p] << 8) | u8[p + 1];
  const qt = [], hts = [];
  let frame = null, restart = 0, transform = null, i = 2;
  if (u8[0] !== 0xFF || u8[1] !== 0xD8) throw new Error('Not a JPEG');
  while (i < u8.length) {
    if (u8[i] !== 0xFF) { i++; continue; }
    const m = u8[i + 1];
    if (m === 0xFF) { i++; continue; }
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    if (m === 0xD9) break;
    const s = i + 4, e = i + 2 + u16(i + 2);
    if (m === 0xDB) {
      for (let p = s; p < e;) {
        const pq = u8[p] >> 4, tq = u8[p] & 15, t = new Int32Array(64);
        p++;
        for (let k = 0; k < 64; k++) t[ZZ[k]] = pq ? u16(p + 2 * k) : u8[p + k];
        p += pq ? 128 : 64;
        qt[tq] = t;
      }
    } else if (m === 0xC4) {
      for (let p = s; p < e;) {
        const cls = u8[p] >> 4, id = u8[p] & 15;
        const counts = u8.subarray(p + 1, p + 17);
        let total = 0; for (const c of counts) total += c;
        hts[cls * 16 + id] = huffTable(counts, u8.subarray(p + 17, p + 17 + total));
        p += 17 + total;
      }
    } else if (m === 0xC0 || m === 0xC1) {
      if (u8[s] !== 8) throw new Error('Only 8-bit JPEGs');
      const H = u16(s + 1), W = u16(s + 3), nf = u8[s + 5];
      const comps = [];
      for (let k = 0; k < nf; k++) {
        const b = s + 6 + k * 3;
        comps.push({ id: u8[b], h: u8[b + 1] >> 4, v: u8[b + 1] & 15, tq: u8[b + 2] });
      }
      const hmax = Math.max(...comps.map(c => c.h)), vmax = Math.max(...comps.map(c => c.v));
      const mcux = Math.ceil(W / (8 * hmax)), mcuy = Math.ceil(H / (8 * vmax));
      for (const c of comps) {
        c.bw = mcux * c.h; c.bh = mcuy * c.v;                    // blocks, padded to whole MCUs
        c.cw = Math.ceil(W * c.h / hmax); c.ch = Math.ceil(H * c.v / vmax);
        c.plane = new Uint8Array(c.bw * 8 * c.bh * 8);
      }
      frame = { W, H, comps, hmax, vmax, mcux, mcuy };
    } else if (m >= 0xC2 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      throw new Error('Progressive or unusual JPEG');
    } else if (m === 0xDD) {
      restart = u16(s);
    } else if (m === 0xEE && u8[s] === 0x41 && u8[s + 4] === 0x65) {
      transform = u8[s + 11];
    } else if (m === 0xDA) {
      if (!frame) throw new Error('Scan before frame');
      const ns = u8[s], scomps = [];
      for (let k = 0; k < ns; k++) {
        const c = frame.comps.find(x => x.id === u8[s + 1 + k * 2]);
        const t = u8[s + 2 + k * 2];
        scomps.push({ c, dc: hts[t >> 4], ac: hts[16 + (t & 15)], pred: 0 });
      }
      i = decodeScan(u8, e, frame, scomps, qt, restart);
      continue;
    }
    i = e;
  }
  if (!frame) throw new Error('No image frame');
  return { ...frame, transform };
}

function decodeScan(u8, pos, frame, scomps, qt, restart) {
  let bits = 0, nbits = 0, hitMarker = false;
  const bit = () => {
    if (!nbits) {
      let b = 0;
      if (!hitMarker && pos < u8.length) {
        b = u8[pos];
        if (b === 0xFF) {
          const n = u8[pos + 1];
          if (n === 0) pos += 2;
          else { hitMarker = true; b = 0; }
        } else pos++;
      }
      bits = b; nbits = 8;
    }
    nbits--;
    return (bits >> nbits) & 1;
  };
  const receive = n => { let v = 0; for (let k = 0; k < n; k++) v = (v << 1) | bit(); return v; };
  const extend = (v, n) => (n && v < (1 << (n - 1)) ? v - (1 << n) + 1 : v);
  const decodeHuff = t => {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | bit();
      if (t.maxcode[len] >= 0 && code <= t.maxcode[len] && code >= t.mincode[len]) return t.symbols[t.valptr[len] + code - t.mincode[len]];
    }
    return 0;
  };
  const blk = new Float64Array(64), tmp = new Float64Array(64);
  const decodeBlock = (sc, bx, by) => {
    const c = sc.c, q = qt[c.tq];
    blk.fill(0);
    const t = decodeHuff(sc.dc);
    sc.pred += t ? extend(receive(t), t) : 0;
    blk[0] = sc.pred * q[0];
    for (let k = 1; k < 64;) {
      const rs = decodeHuff(sc.ac), r = rs >> 4, sz = rs & 15;
      if (!sz) { if (r !== 15) break; k += 16; continue; }
      k += r;
      if (k > 63) break;
      blk[ZZ[k]] = extend(receive(sz), sz) * q[ZZ[k]];
      k++;
    }
    // Separable inverse DCT.
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      let v = 0; for (let u = 0; u < 8; u++) v += COS[x * 8 + u] * blk[y * 8 + u];
      tmp[y * 8 + x] = v;
    }
    const stride = c.bw * 8, base = by * 8 * stride + bx * 8;
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
      let v = 0; for (let u = 0; u < 8; u++) v += COS[y * 8 + u] * tmp[u * 8 + x];
      v = Math.round(v + 128);
      c.plane[base + y * stride + x] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  };
  const resetAtRestart = () => {
    for (const sc of scomps) sc.pred = 0;
    nbits = 0;
    // Skip to just past the RSTn marker.
    while (pos < u8.length && !(u8[pos] === 0xFF && u8[pos + 1] >= 0xD0 && u8[pos + 1] <= 0xD7)) pos++;
    if (pos < u8.length) pos += 2;
    hitMarker = false;
  };
  let n = 0;
  if (scomps.length === 1) {
    const sc = scomps[0], c = sc.c;
    const bw = Math.ceil(c.cw / 8), bh = Math.ceil(c.ch / 8);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      if (restart && n && n % restart === 0) resetAtRestart();
      decodeBlock(sc, bx, by); n++;
    }
  } else {
    for (let my = 0; my < frame.mcuy; my++) for (let mx = 0; mx < frame.mcux; mx++) {
      if (restart && n && n % restart === 0) resetAtRestart();
      for (const sc of scomps) for (let v = 0; v < sc.c.v; v++) for (let h = 0; h < sc.c.h; h++) decodeBlock(sc, mx * sc.c.h + h, my * sc.c.v + v);
      n++;
    }
  }
  // Continue after this scan's data, at the next real marker.
  while (pos < u8.length && !(u8[pos] === 0xFF && u8[pos + 1] !== 0 && !(u8[pos + 1] >= 0xD0 && u8[pos + 1] <= 0xD7))) pos++;
  return pos;
}

// CMYK JPEG → RGB JPEG, reading the samples the way a PDF does.
async function cmykToRgbJpeg(data, inverted) {
  const j = decodeBaselineJpeg(data);
  if (j.comps.length !== 4) throw new Error('Not CMYK');
  const { W, H, comps, hmax, vmax } = j;
  const out = new Uint8ClampedArray(W * H * 4);
  const s = [0, 0, 0, 0];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    for (let k = 0; k < 4; k++) {
      const c = comps[k];
      s[k] = c.plane[Math.floor(y * c.v / vmax) * c.bw * 8 + Math.floor(x * c.h / hmax)];
    }
    if (j.transform === 2) {                                   // YCCK → CMY(K)
      const Y = s[0], cb = s[1] - 128, cr = s[2] - 128;
      s[0] = 255 - (Y + 1.402 * cr);
      s[1] = 255 - (Y - 0.344136 * cb - 0.714136 * cr);
      s[2] = 255 - (Y + 1.772 * cb);
    }
    const ink = k => Math.min(1, Math.max(0, (inverted ? 255 - s[k] : s[k]) / 255));
    const [r, g, b] = cmyk(ink(0), ink(1), ink(2), ink(3));
    const o = (y * W + x) * 4;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
  }
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  c.width = c.height = 0;
  if (!blob) throw new Error('Couldn’t convert an image');
  return { blob, w: W, h: H, type: 'image/jpeg', kept: false };
}

async function jpegOut(data, dec, w, h) {
  const keep = bytes => ({ blob: new Blob([bytes], { type: 'image/jpeg' }), w, h, type: 'image/jpeg', kept: bytes === data });
  const info = jpegInfo(data);
  if (!info || !info.nf) return keep(data);
  const pairs = [];
  for (let c = 0; c < info.nf; c++) pairs.push(dec.length >= 2 * (c + 1) ? [dec[2 * c], dec[2 * c + 1]] : [0, 1]);
  const identity = pairs.every(([a, b]) => a === 0 && b === 1);

  if (info.nf === 4) {
    const allInv = pairs.every(([a, b]) => a === 1 && b === 0);
    if (!identity && !allInv) return keep(data);             // unusual partial Decode: leave it
    const mode = await probeCmyk();
    const shows = info.adobe ? mode.marker : mode.plain;      // does this browser invert it as is?
    if (shows === null || shows === allInv) return keep(data);
    // Wrong way round here: switch the marker so the browser flips its reading.
    if (allInv && !info.adobe && mode.marker) return keep(withAdobe(data));
    if (!allInv && info.adobe && info.adobe.transform === 0 && mode.plain === false) return keep(withoutAdobe(data, info.adobe.pos));
    // No lossless fix in this browser: decode it here and save the colors the PDF shows.
    try { return await cmykToRgbJpeg(data, allInv); }
    catch { return keep(data); }                              // e.g. progressive CMYK: leave as is
  }

  if (identity) return keep(data);
  // Gray or RGB with a Decode array (usually [1 0]: a stored negative).
  const px = await browserPixels(new Blob([data], { type: 'image/jpeg' }));
  const map = pairs.length === 1 ? [pairs[0], pairs[0], pairs[0]] : pairs;
  const L = map.map(([a, b]) => { const t = new Uint8Array(256); for (let v = 0; v < 256; v++) t[v] = Math.round(255 * (a + (b - a) * v / 255)); return t; });
  const p = px.rgba;
  for (let i = 0; i < p.length; i += 4) { p[i] = L[0][p[i]]; p[i + 1] = L[1][p[i + 1]]; p[i + 2] = L[2][p[i + 2]]; }
  const c = document.createElement('canvas');
  c.width = px.w; c.height = px.h;
  c.getContext('2d').putImageData(new ImageData(p, px.w, px.h), 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  c.width = c.height = 0;
  if (!blob) throw new Error('Couldn’t convert an image');
  return { blob, w: px.w, h: px.h, type: 'image/jpeg', kept: false };
}

function cmyk(c, m, y, k) {
  return [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)];
}

async function browserPixels(blob, w, h) {
  const bm = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bm.width; c.height = bm.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(bm, 0, 0);
  bm.close?.();
  const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
  const out = { w: c.width, h: c.height, rgba };
  c.width = c.height = 0;
  return out;
}

export const isPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');

// file: a File/Blob. onProgress(done, total).
// Returns { images: [{ blob, w, h, type, hash, page, kept }], skipped: [{ page, reason }], pages }.
export async function extractPdfImages(file, onProgress) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (indexOfSeq(buf.subarray(0, 1024), bytesOf('%PDF'), 0) < 0) throw new Error('This file isn’t a PDF.');
  const doc = new PdfDoc(buf);
  await doc.load();
  if (doc.encrypted) throw new Error('This PDF is encrypted or password-protected, so its images can’t be read here.');
  const order = await doc.imageOrder();
  const images = [], skipped = [], hashes = new Set();
  for (let i = 0; i < order.length; i++) {
    onProgress && onProgress(i, order.length);
    const { n, page } = order[i];
    try {
      const img = await doc.image(n);
      if (!img) continue;
      const hash = await sha256hex(new Uint8Array(await img.blob.arrayBuffer()));
      if (hashes.has(hash)) continue;                       // same image embedded twice
      hashes.add(hash);
      images.push({ ...img, hash, page });
    } catch (e) {
      skipped.push({ page, reason: e.message || String(e) });
    }
  }
  onProgress && onProgress(order.length, order.length);
  return { images, skipped, pages: doc.pageCount || 0 };
}

// For tests: pretend to be a browser with a given CMYK convention.
export function _setCmykMode(mode) { cmykMode = mode ? Promise.resolve(mode) : undefined; }
