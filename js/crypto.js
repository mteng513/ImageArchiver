// AES-256-GCM. File layout matches CryptoKit's combined form and the plan:
//   nonce (12 bytes) || ciphertext || tag (16 bytes)
import { enc, hex } from './util.js';

const PBKDF2_ITER = 310000;

export function newMasterKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function importAes(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encrypt(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

export async function decrypt(key, data) {
  const u = data instanceof Uint8Array ? data : new Uint8Array(data);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, key, u.subarray(12));
  return new Uint8Array(pt);
}

export async function encryptJSON(key, obj) {
  return encrypt(key, enc.encode(JSON.stringify(obj)));
}
export async function decryptJSON(key, data) {
  return JSON.parse(new TextDecoder().decode(await decrypt(key, data)));
}

async function passKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Wrap the raw master key with a passcode (or store it plainly when no lock).
export async function wrapMaster(raw, pass) {
  if (!pass) return { plain: raw };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await passKey(pass, salt);
  return { salt, blob: await encrypt(k, raw) };
}

export async function unwrapMaster(wrapped, pass) {
  if (wrapped.plain) return new Uint8Array(wrapped.plain);
  const k = await passKey(pass, wrapped.salt);
  return decrypt(k, wrapped.blob); // throws on wrong passcode
}

export async function sha256hex(data) {
  return hex(await crypto.subtle.digest('SHA-256', data));
}
