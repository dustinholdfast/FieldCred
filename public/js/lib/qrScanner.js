// Camera QR scanning for the gate flow (js/pages/scan.js).
//
// WHY THIS EXISTS: before this, "scanning" at a gate meant the guard leaving
// FieldCred, opening the phone's native camera app, tapping a notification,
// and landing back in a browser tab — per badge, per worker, at shift change.
// This keeps the camera inside the app so a guard scans, sees a verdict, and
// scans the next person.
//
// DECODER STRATEGY: native `BarcodeDetector` where available, jsQR only as a
// fallback. Android Chrome — the platform the Play Store build targets — has
// BarcodeDetector, so the common path ships zero extra bytes and decodes off
// the main thread in native code. The 131 KB jsQR bundle is behind a dynamic
// import() that only runs on browsers without it (iOS/Safari, older desktop
// Chrome). Keep it that way; see js/vendor/README.md.

// How often to run detection. Deliberately NOT every animation frame: a QR
// only needs to be caught within a fraction of a second of being held up, and
// at 60fps the fallback path (canvas readback + jsQR on the main thread) would
// pin the CPU and drain a gate tablet's battery for no gain.
const SCAN_INTERVAL_MS = 120;

// Ignore a re-read of the code we just acted on. A QR stays in frame for many
// scan ticks after it's decoded, so without this a single badge fires the
// result handler dozens of times.
const DUPLICATE_WINDOW_MS = 2500;

/**
 * Interprets a scanned QR payload as a FieldCred link.
 *
 * Pure — no DOM, no network — so the branching here is unit-testable
 * (tests/qrScanner.test.mjs). Returns a discriminated result rather than
 * throwing, because every outcome including "this isn't ours" is a normal
 * thing for a camera pointed at the world to see.
 *
 * @param {string} text        raw decoded QR contents
 * @param {string} currentTenant  tenant slug this device is serving
 */
export function parseScannedCode(text, currentTenant) {
  if (typeof text !== 'string' || !text.trim()) return { kind: 'unknown' };

  let url;
  try {
    url = new URL(text.trim());
  } catch {
    return { kind: 'unknown' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'unknown' };

  // Routing is hash-based, so the slug lives in the fragment, not the path.
  const match = /^#\/(r|gate)\/([^/?#]+)/.exec(url.hash);
  if (!match) return { kind: 'unknown' };

  const kind = match[1] === 'r' ? 'worker' : 'gate';
  let slug;
  try {
    slug = decodeURIComponent(match[2]);
  } catch {
    slug = match[2]; // malformed %-escape; use it raw and let the lookup fail
  }
  if (!slug) return { kind: 'unknown' };

  // Cross-tenant guard. Every badge/gate QR this app generates carries
  // ?tenant= (js/components/shareDialog.js, js/lib/badgeCards.js), and each
  // tenant is a physically separate Supabase project — so a slug from another
  // tenant is not merely absent here, it could in principle collide with a
  // DIFFERENT real worker in this tenant and show a confident verdict for the
  // wrong person. Fail closed and say why, rather than looking it up.
  const scannedTenant = url.searchParams.get('tenant');
  if (scannedTenant && currentTenant && scannedTenant !== currentTenant) {
    return { kind: 'foreign-tenant', slug, tenant: scannedTenant };
  }

  // A QR with no ?tenant= at all (hand-made, or predating that param) is
  // accepted: we can't tell whose it is, and the lookup itself still can't
  // return anyone outside this tenant's own database.
  return { kind, slug, tenant: scannedTenant || null };
}

// Resolves a decode function for this browser, preferring the native API.
// Returns null if neither option can work, so the page can show a real
// explanation instead of a camera that silently never decodes anything.
async function createDecoder() {
  if ('BarcodeDetector' in globalThis) {
    try {
      // Support for the API and support for *QR specifically* are different
      // questions on some builds — ask before committing to it.
      const formats = await globalThis.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
        return {
          engine: 'native',
          // Detects straight off the video element — no canvas readback.
          async decode(video) {
            const codes = await detector.detect(video);
            return codes.length ? codes[0].rawValue : null;
          },
        };
      }
    } catch {
      // Constructor or format query threw — fall through to jsQR.
    }
  }

  let jsQR;
  try {
    const mod = await import('../vendor/jsqr.mjs');
    jsQR = mod.default || mod;
  } catch {
    return null;
  }

  // jsQR needs raw pixels, so this path pays for a canvas readback each tick.
  // Downscale to at most 640px on the long edge first: QR finder patterns
  // survive it easily, and it roughly quarters the work versus a 1280px frame.
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    engine: 'jsqr',
    async decode(video) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return null;
      const scale = Math.min(1, 640 / Math.max(vw, vh));
      const w = Math.round(vw * scale);
      const h = Math.round(vh * scale);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.drawImage(video, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      const result = jsQR(data, w, h, { inversionAttempts: 'dontInvert' });
      return result ? result.data : null;
    },
  };
}

/**
 * Starts the camera and runs a decode loop, calling onResult with each newly
 * seen QR payload.
 *
 * Returns a handle with stop() — ALWAYS call it when leaving the page, or the
 * camera light stays on and the stream keeps running in the background.
 */
export async function startScanner({ video, onResult, onError }) {
  const decoder = await createDecoder();
  if (!decoder) {
    onError?.({ code: 'no-decoder', message: "This browser can't decode QR codes." });
    return { stop() {}, engine: null };
  }

  // Camera access requires a secure context. On a plain-http origin Chrome
  // doesn't merely refuse getUserMedia — it omits `navigator.mediaDevices`
  // entirely, so the call below would throw a TypeError that the mapping in
  // the catch turns into "another app may be using the camera": the wrong
  // cause, pointing at the wrong fix. Production is always HTTPS, so this is
  // really about on-device testing against a dev server over a LAN IP (see
  // .claude/launch.json) — exactly when a misleading message costs the most
  // time.
  if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    onError?.({
      code: 'insecure-context',
      message: 'The camera is only available over HTTPS (or localhost).',
    });
    return { stop() {}, engine: decoder.engine };
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // `ideal`, not `exact`: a laptop or a tablet with only a front camera
      // should still work rather than failing outright with
      // OverconstrainedError. On a phone this still picks the rear camera.
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
  } catch (err) {
    const code =
      err?.name === 'NotAllowedError'
        ? 'permission-denied'
        : err?.name === 'NotFoundError' || err?.name === 'DevicesNotFoundError'
          ? 'no-camera'
          : 'camera-failed';
    onError?.({ code, message: err?.message || 'Could not start the camera.' });
    return { stop() {}, engine: decoder.engine };
  }

  video.srcObject = stream;
  video.setAttribute('playsinline', ''); // iOS: without this the video goes fullscreen-native
  video.muted = true;
  try {
    await video.play();
  } catch {
    // Autoplay rejection — the stream is live and the loop below still works
    // once the element starts rendering; not worth failing the whole scanner.
  }

  let stopped = false;
  let paused = false;
  let lastValue = null;
  let lastAt = 0;
  let timer = null;

  async function tick() {
    if (stopped) return;
    if (!paused && video.readyState >= 2) {
      try {
        const value = await decoder.decode(video);
        if (value) {
          const now = Date.now();
          const isDuplicate = value === lastValue && now - lastAt < DUPLICATE_WINDOW_MS;
          lastValue = value;
          lastAt = now;
          if (!isDuplicate && !stopped) onResult?.(value);
        }
      } catch {
        // A single failed frame (readback race, detector hiccup) is normal —
        // keep looping rather than killing the scanner over one bad tick.
      }
    }
    if (!stopped) timer = setTimeout(tick, SCAN_INTERVAL_MS);
  }
  timer = setTimeout(tick, SCAN_INTERVAL_MS);

  return {
    engine: decoder.engine,
    // Suspends decoding without dropping the camera stream, so resuming is
    // instant — used while a verdict is on screen.
    pause() {
      paused = true;
    },
    resume() {
      // Clear the duplicate guard so the SAME badge can deliberately be
      // re-scanned right after a verdict is dismissed.
      lastValue = null;
      paused = false;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    },
  };
}
