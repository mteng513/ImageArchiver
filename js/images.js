// Decoding, thumbnails and hashing for incoming images.
import { sha256hex } from './crypto.js';

const THUMB_SHORT = 400;   // ~400 px as in the plan
const THUMB_LONG_MAX = 1000;

async function decode(blob) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(blob); } catch {}
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function sniffType(u8) {
  if (u8[0] === 0xff && u8[1] === 0xd8) return 'image/jpeg';
  if (u8[0] === 0x89 && u8[1] === 0x50) return 'image/png';
  if (u8[0] === 0x47 && u8[1] === 0x49) return 'image/gif';
  if (u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'image/webp';
  if (u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) return 'image/heic';
  return 'application/octet-stream';
}

export async function processImage(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = await sha256hex(bytes);
  const type = (blob.type && blob.type.startsWith('image/')) ? blob.type : sniffType(bytes);
  const src = await decode(blob);
  const w = src.width || src.naturalWidth;
  const h = src.height || src.naturalHeight;
  if (!w || !h) throw new Error('Couldn’t read that image');
  const short = Math.min(w, h);
  let scale = Math.min(1, THUMB_SHORT / short);
  if (Math.max(w, h) * scale > THUMB_LONG_MAX) scale = THUMB_LONG_MAX / Math.max(w, h);
  const tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
  const c = document.createElement('canvas');
  c.width = tw; c.height = th;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, tw, th);
  if (src.close) src.close();
  const thumbBlob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
  c.width = c.height = 0;
  const thumb = new Uint8Array(await thumbBlob.arrayBuffer());
  return { bytes, hash, type, w, h, thumb };
}
