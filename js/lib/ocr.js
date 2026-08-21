// Lazy client-side OCR via self-hosted Tesseract.js (js/vendor/tesseract/).
//
// Nothing here loads until ocrImage() is first called — the ~7 MB of wasm core
// and language data is dynamically imported/fetched on demand, so normal app
// loads and the public gate never pay for it. One worker is created and reused
// across scans in a session. All assets are same-origin (no CDN), which keeps
// the app's strict 'self' CSP intact aside from the wasm-eval allowance the
// engine needs (see index.html).

let workerPromise = null;

function vendorBase() {
  // Absolute URL to js/vendor/tesseract/ regardless of how the page is hosted.
  return new URL('./js/vendor/tesseract/', document.baseURI).href;
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('../vendor/tesseract/tesseract.esm.min.js');
      const base = vendorBase();
      return createWorker('eng', 1, {
        workerPath: `${base}worker.min.js`,
        corePath: `${base}tesseract-core-lstm.wasm.js`,
        langPath: base,
        gzip: true, // eng.traineddata is shipped gzipped
      });
    })().catch((err) => {
      workerPromise = null; // let a later call retry a fresh load
      throw err;
    });
  }
  return workerPromise;
}

// Recognize text from an image File/Blob/URL/element. Returns the raw text.
export async function ocrImage(image) {
  const worker = await getWorker();
  const { data } = await worker.recognize(image);
  return data.text || '';
}
