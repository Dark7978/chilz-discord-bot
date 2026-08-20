// ── OCR helper ───────────────────────────────────────────────────────────────
// Reads text out of images (Discord attachments) so the anti-scam detector can
// catch scams that live entirely inside a screenshot (fake MrBeast tweet, etc.).
// Uses a single long-lived Tesseract worker so we don't pay startup cost per image.

const { createWorker } = require('tesseract.js');

let workerPromise = null;

// One worker serves every server, so the language list is the union of what they
// speak. Tesseract downloads each language's data once, on first use.
const LANGS = process.env.OCR_LANGS || 'eng';

async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker(LANGS).catch(err => {
      workerPromise = null;              // allow a later retry if init failed
      throw err;
    });
  }
  return workerPromise;
}

/** Download an image URL to a Buffer (Discord CDN links). */
async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

/**
 * OCR a single image URL. Returns extracted text ('' on any failure).
 * Guarded by a timeout so a huge/broken image can't hang the bot.
 */
async function readImage(url, timeoutMs = 15000) {
  try {
    const worker = await getWorker();
    const buf    = await fetchImage(url);
    const result = await Promise.race([
      worker.recognize(buf),
      new Promise((_, rej) => setTimeout(() => rej(new Error('OCR timeout')), timeoutMs)),
    ]);
    return (result?.data?.text || '').trim();
  } catch (err) {
    console.error('[OCR] readImage failed:', err.message);
    return '';
  }
}

module.exports = { readImage };
