// Draws PDF pages as images, exactly as a PDF viewer shows them (text,
// artwork and pictures together), using Mozilla's PDF.js from vendor/pdfjs
// (Apache 2.0). It loads only when a PDF is imported, runs on the phone, and
// fetches nothing but its own files from this site.

const BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
const MAX_AREA = 16_000_000;      // iOS canvas limit is 16,777,216 pixels
const MAX_SIDE = 32000;
const MIN_SCALE = 2;              // pages without pictures: 144 dpi, sharp text
const MAX_SCALE = 8;
const THUMB_W = 360;

let lib;
function pdfjs() {
  lib ||= import('../vendor/pdfjs/pdf.min.mjs').then(m => {
    m.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';
    return m;
  });
  return lib;
}

export const isPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

// How many pixels per PDF point the sharpest picture on the page carries, so a
// full-page scan keeps its resolution. 0 when the page has no pictures.
async function pictureScale(m, page) {
  const O = m.OPS;
  const ops = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0], best = 0;
  const stack = [];
  const seen = (w, h) => {
    const dw = Math.hypot(ctm[0], ctm[1]), dh = Math.hypot(ctm[2], ctm[3]);
    if (w > 0 && h > 0 && dw > 1 && dh > 1) best = Math.max(best, w / dw, h / dh);
  };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], a = ops.argsArray[i];
    if (fn === O.save) stack.push(ctm);
    else if (fn === O.restore) ctm = stack.pop() || ctm;
    else if (fn === O.transform && a && a.length >= 6) ctm = mul(ctm, a);
    else if (fn === O.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(a?.[0]) || ArrayBuffer.isView(a?.[0])) ctm = mul(ctm, a[0]); }
    else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === O.paintImageXObject) seen(a?.[1], a?.[2]);
    else if (fn === O.paintInlineImageXObject) seen(a?.[0]?.width, a?.[0]?.height);
  }
  return best;
}

function toBlob(canvas, type, q) {
  return new Promise(r => canvas.toBlob(r, type, q));
}

// file: File/Blob. askPassword(retry) → Promise<string|undefined> for locked PDFs.
// Returns { pages, name, thumb(n), render(n), close() }.
export async function openPdf(file, { askPassword } = {}) {
  const m = await pdfjs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let doc, task, password, tries = 0;
  for (;;) {
    task = m.getDocument({
      data: bytes.slice(),                  // the worker takes ownership of the copy
      password,
      cMapUrl: BASE + 'cmaps/', cMapPacked: true,
      standardFontDataUrl: BASE + 'standard_fonts/',
      wasmUrl: BASE + 'wasm/', iccUrl: BASE + 'iccs/',
      enableXfa: false,
    });
    try { doc = await task.promise; break; }
    catch (e) {
      if (e?.name !== 'PasswordException') throw new Error('Couldn’t read this PDF' + (e?.message ? ` (${e.message})` : '.'));
      if (!askPassword || tries++ >= 3) throw new Error('This PDF is password-protected.');
      password = await askPassword(tries > 1);
      if (!password) throw new Error('This PDF is password-protected.');
    }
  }

  const draw = async (n, scaleFor) => {
    const page = await doc.getPage(n);
    try {
      const base = page.getViewport({ scale: 1 });
      const pics = await pictureScale(m, page);
      let s = scaleFor(base, pics);
      s = Math.min(s, Math.sqrt(MAX_AREA / (base.width * base.height)), MAX_SIDE / base.width, MAX_SIDE / base.height);
      const viewport = page.getViewport({ scale: s });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      return { canvas, pics };
    } finally {
      page.cleanup();
    }
  };

  return {
    pages: doc.numPages,
    // Small preview for the picker, as an object URL.
    async thumb(n) {
      const { canvas } = await draw(n, base => THUMB_W / base.width);
      const blob = await toBlob(canvas, 'image/jpeg', 0.8);
      canvas.width = canvas.height = 0;
      return URL.createObjectURL(blob);
    },
    // Full page. Pages with pictures keep the sharpest picture's resolution and
    // save as JPEG; text-only pages save as PNG so the lettering stays crisp.
    async render(n) {
      const { canvas, pics } = await draw(n, (base, p) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, p)));
      const blob = pics ? await toBlob(canvas, 'image/jpeg', 0.9) : await toBlob(canvas, 'image/png');
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error(`Couldn’t draw page ${n}`);
      return blob;
    },
    close() { task.destroy(); },
  };
}
