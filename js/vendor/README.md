# Vendored third-party code

These files are checked in on purpose. The app has no build step, so its
dependencies are self-hosted here rather than pulled from a CDN at runtime — a
CDN outage can't take the app down, an upstream release can't land untested, and
a strict `script-src 'self'` CSP is satisfiable.

## `supabase-js.js` (+ `node/`)

Supabase JS client, **pinned to `@2.110.5`**, bundled to a single ES module.
`node/*.mjs` are the small Node polyfills (buffer/process/events/tty/async_hooks)
that the bundle imports; their paths were rewritten from esm.sh-absolute
(`/node/x.mjs`) to local-relative (`./node/x.mjs`).

### Re-vendoring / upgrading

```sh
# 1. Fetch the bundled build for the version you want:
curl -sL "https://esm.sh/@supabase/supabase-js@<VERSION>/es2020/supabase-js.bundle.mjs" -o supabase-js.js

# 2. Fetch each /node/*.mjs it imports (transitively) into node/, then rewrite paths:
sed -i 's#"/node/#"./node/#g' supabase-js.js
sed -i 's#"/node/#"./#g' node/*.mjs

# 3. Confirm nothing external remains, and run the app's login page — it should
#    reach Supabase ("Connecting to <tenant>") with no console errors:
grep -R '"/node/\|https://' . && echo "external refs remain — fix before shipping"
```

Then bump the version note in `js/lib/supabaseClient.js`.

## `qrcode.min.js`

`qrcodejs` — client-side QR generation. Unchanged from upstream.

## `jsqr.mjs`

`jsQR` (Apache-2.0), **pinned to `@1.4.0`** — QR *decoding*, the other
direction from `qrcode.min.js`. Used only as the gate scanner's fallback
decoder (`js/lib/qrScanner.js`) on browsers without the native
`BarcodeDetector` API — mainly iOS/Safari and older desktop Chrome. Android
Chrome, the platform the Play Store build targets, has `BarcodeDetector`
natively, so it never downloads this file: `qrScanner.js` imports it
dynamically, only after feature detection fails.

That laziness is the whole reason a 131 KB decoder is acceptable here; keep it
behind the dynamic `import()` if you touch that code.

### Re-vendoring / upgrading

```sh
curl -sL "https://esm.sh/jsqr@<VERSION>/es2020/jsqr.bundle.mjs" -o jsqr.mjs
grep -o 'https://[^"]*' jsqr.mjs && echo "external refs remain — fix before shipping"
```

Verify by loading `#/scan` in a browser with `BarcodeDetector` disabled (or
Safari) and scanning a real badge QR.
