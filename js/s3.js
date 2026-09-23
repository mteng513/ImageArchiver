// Minimal S3 client for Backblaze B2's S3-compatible API, signed with AWS SigV4
// using WebCrypto. Every upload is a single PutObject (never multipart).
import { enc, hex } from './util.js';

async function sha256(data) {
  return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
// RFC 3986 encoding as SigV4 expects.
function uriEnc(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function parseEndpoint(endpoint) {
  let e = endpoint.trim();
  if (!/^https?:\/\//.test(e)) e = 'https://' + e;
  const u = new URL(e);
  const m = u.hostname.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/);
  return { origin: u.origin, host: u.host, region: m ? m[1] : 'us-east-1' };
}

export class S3 {
  constructor({ endpoint, bucket, keyId, secret, region }) {
    const p = parseEndpoint(endpoint);
    this.origin = p.origin;
    this.host = p.host;
    this.region = region || p.region;
    this.bucket = bucket.trim();
    this.keyId = keyId.trim();
    this.secret = secret.trim();
  }

  // Returns {url, headers} for a signed request. `now` is injectable for tests.
  async sign(method, key, body, query = {}, now = new Date()) {
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const date = amzDate.slice(0, 8);
    const path = '/' + uriEnc(this.bucket) + (key ? '/' + key.split('/').map(uriEnc).join('/') : '');
    const payloadHash = await sha256(body || new Uint8Array(0));
    const qs = Object.keys(query).sort().map(k => uriEnc(k) + '=' + uriEnc(query[k])).join('&');
    const canonHeaders = `host:${this.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const creq = [method, path, qs, canonHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const sts = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(creq)].join('\n');
    let k = await hmac('AWS4' + this.secret, date);
    k = await hmac(k, this.region);
    k = await hmac(k, 's3');
    k = await hmac(k, 'aws4_request');
    const sig = hex(await hmac(k, sts));
    return {
      url: this.origin + path + (qs ? '?' + qs : ''),
      headers: {
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        'Authorization': `AWS4-HMAC-SHA256 Credential=${this.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
      },
    };
  }

  async req(method, key, body, query) {
    const { url, headers } = await this.sign(method, key, body, query);
    let r;
    try {
      r = await fetch(url, { method, headers, body: body || undefined, cache: 'no-store' });
    } catch (e) {
      const err = new Error('Couldn’t reach B2. If this is the first connection, the bucket’s CORS rule is probably not set yet.');
      err.network = true;
      throw err;
    }
    return r;
  }

  async put(key, bytes) {
    const r = await this.req('PUT', key, bytes);
    if (!r.ok) throw await s3Error(r, 'upload');
  }

  // Returns Uint8Array, or null if the object doesn't exist.
  async get(key) {
    const r = await this.req('GET', key);
    if (r.status === 404) return null;
    if (!r.ok) throw await s3Error(r, 'download');
    return new Uint8Array(await r.arrayBuffer());
  }

  async del(key) {
    const r = await this.req('DELETE', key);
    if (!r.ok && r.status !== 404) throw await s3Error(r, 'delete');
  }
}

async function s3Error(r, what) {
  let msg = '';
  try {
    const t = await r.text();
    const m = t.match(/<Message>([^<]*)<\/Message>/);
    msg = m ? m[1] : t.slice(0, 200);
  } catch {}
  const e = new Error(`B2 ${what} failed (${r.status})${msg ? ': ' + msg : ''}`);
  e.status = r.status;
  if (r.status === 403 && /cap|limit/i.test(msg)) e.capped = true;
  return e;
}
