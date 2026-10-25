// Turning a QR into a PNG data URL.
//
// Every place FieldCred hands a QR to something outside the live DOM — a
// print window with no scripts of its own (strict script-src 'self' CSP), a
// download link — needs the code as an image, not as a widget. Both helpers
// here produce that, and both exist because qrcodejs is a DOM library: it
// draws into an element and gives you no way to ask for bytes directly.
//
// QRCode is a global loaded in index.html (js/vendor/qrcode.min.js).

// Grab a data URL out of an element a QRCode was already rendered into.
// qrcodejs produces a canvas plus an <img> built from it; either will do.
// Returns null if neither is there yet (or the canvas is tainted).
export function qrNodeDataUrl(node) {
  const img = node?.querySelector('img');
  if (img && img.src && img.src.startsWith('data:')) return img.src;
  const canvas = node?.querySelector('canvas');
  if (!canvas) return null;
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

// Render one QR offscreen in THIS document and resolve its PNG data URL.
// Resolves null rather than rejecting if it never paints — a card or a sign
// printing without its code is a better failure than no document at all.
export function qrDataUrl(text, { size = 260, colorDark = '#0f2148', colorLight = '#ffffff' } = {}) {
  return new Promise((resolve) => {
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(holder);
    // eslint-disable-next-line no-undef
    new QRCode(holder, {
      text,
      width: size,
      height: size,
      colorDark,
      colorLight,
      // eslint-disable-next-line no-undef
      correctLevel: QRCode.CorrectLevel.M,
    });

    const start = Date.now();
    (function grab() {
      const src = qrNodeDataUrl(holder);
      if (src) {
        holder.remove();
        resolve(src);
      } else if (Date.now() - start > 2500) {
        holder.remove();
        resolve(null);
      } else {
        requestAnimationFrame(grab);
      }
    })();
  });
}
