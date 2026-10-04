# Vendored third-party code

These files are checked in on purpose. The app has no build step, so its
dependencies are self-hosted here rather than pulled from a CDN at runtime — a
CDN outage can't take the app down, an upstream release can't land untested, and
a strict `script-src 'self'` CSP is satisfiable.

## `neon-js.js`

Neon JS client, **pinned to `@neondatabase/neon-js@0.7.0-beta`**, bundled to a
single ES module (`createClient` + `SupabaseAuthAdapter`). The app has no
runtime npm install; this file is the client.

### Re-vendoring / upgrading

From a temporary install of the package (do not leave it in `package.json`):

```sh
# neon-entry.mjs:
#   export { createClient, SupabaseAuthAdapter } from '@neondatabase/neon-js';
npx esbuild ./neon-entry.mjs --bundle --format=esm --platform=browser --target=es2020 --outfile=./js/vendor/neon-js.js --legal-comments=none
```

Confirm the bundle has no leftover `from "..."` imports, then delete the
entry file and the temporary `node_modules`. Bump the version note in
`js/lib/backendClient.js`.

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
