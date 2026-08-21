# FieldCred for Android

The Play Store app is a **Trusted Web Activity** (TWA): a thin Android shell
that runs the exact same web app at `https://app.fieldcred.co` full-screen,
with no browser UI. There is no second codebase and no separate release of
app logic — shipping a fix to the website ships it to the Android app on the
user's next launch. The APK changes only when the icon, name, launch URL, or
Android-level configuration changes.

That is the whole reason for this approach. The alternative (React
Native/Capacitor) would mean maintaining a second implementation of clearance
evaluation and the offline scan queue, which is precisely the code that must
never disagree with itself.

## What the app is for

It launches straight to `#/scan` — the in-app camera scanner — because the
Android app exists for gate guards. Everything else in FieldCred is reachable
from there, but a guard opening the app at shift change gets a live camera and
nothing else in the way.

### The gate companion app, and `startUrl`

`startUrl` is **`/#/gate-app`** — the FieldCred Gate kiosk (see the main
README), not the bare `#/scan` camera. It has the same scanner plus the
full-screen verdicts, manual lookup and the supervisor tabs, which is the
whole job a guard opens this app to do.

This was changed before the first release on purpose. `appVersionCode` is
still 1 and `assetlinks.json` still holds placeholders, so nothing has ever
shipped and there is no installed user whose landing screen this disturbs —
which makes now the only free moment to make the call. After a release it
would cost a version bump and a Play review to revisit.

To go back to the plain scanner, set `"startUrl": "/#/scan"` and rebuild.
Either way the other route still works as a normal in-app route, and the web
manifest ships a **Gate mode** launcher shortcut (long-press the icon).

A **second** TWA (`co.fieldcred.gate`, its own `packageId`) is the other
option the design handoff raised. It buys a separate Play listing and a
separate icon, and costs a second signing key, a second `assetlinks.json`
entry, and a second release to keep in step forever. Not worth it unless the
gate app is being sold or deployed separately from FieldCred itself.

Note the camera needs no extra Android permission declaration here: a TWA
runs in Chrome, so `getUserMedia` is granted through Chrome's own per-origin
permission prompt, which is already how `#/scan` works today.

### The QR-origin constraint does not bite the gate app

"Multi-tenancy — known constraint" below warns that badge/gate QRs embed
whatever origin the admin generated them on (`location.origin`, still true in
`js/components/shareDialog.js` and `js/lib/badgeCards.js`), so a QR made on
`acme.app.fieldcred.co` drops a scanner onto a non-trusted origin and into a
Custom Tab with a URL bar.

**The gate companion app never navigates to a scanned URL.**
`parseScannedCode()` extracts the slug from the fragment and the app looks it
up directly (`js/lib/gateVerdict.js`); the origin in the QR is never visited.
So a gate device on the canonical host works with QRs generated anywhere, as
long as the QR's `?tenant=` matches the device's tenant — which the
cross-tenant guard already enforces.

That warning still applies to someone scanning a badge with the phone's
*native* camera app, which does open the URL. It is the in-app scanner that
sidesteps it.

### Splash screen — needs a manual step after every `bubblewrap update`

Bubblewrap generates the splash images from **`iconUrl`, the same source as the
launcher icon** (`SPLASH_IMAGES` in `@bubblewrap/core`'s `TwaGenerator.js`).
There is no separate splash-image field, so the two cannot be given different
artwork through `twa-manifest.json`.

They want different artwork, though. A launcher icon is 48dp and has to stay a
clean mark — the shield, `assets/icon-512.png`. The splash gets a whole screen,
so it carries the real logo with wordmark and tagline, `assets/logo.png`.

`apply-splash.mjs` bridges that: it overwrites the generated shield splashes
with pre-rendered logo versions from `android/splash/`. **Build sequence:**

```sh
bubblewrap update
node apply-splash.mjs      # <-- or you ship the shield splash
bubblewrap build
```

`bubblewrap update` regenerates the whole `res/` tree and silently puts the
shield back. The build does not fail if you forget — you just ship the wrong
splash and find out after installing.

The images are pre-rendered and committed rather than generated at run time, so
the script needs no image library and the project stays dependency-free. The
recipe for regenerating them (and why they are 80% of frame, flattened onto
white) is at the bottom of `apply-splash.mjs`.

One thing not worth fighting: on **Android 12+** the system shows its own
splash first, using the circle-masked *launcher icon*, before the TWA's splash
appears. So the sequence is shield-in-a-circle, then the full logo. That is
Android's behaviour for every app, not something the TWA config can suppress.

## Files here

- `twa-manifest.json` — the entire Android configuration. **This is the source
  of truth**; the generated Gradle project is disposable and gitignored.
- Everything else Bubblewrap generates (`app/`, `gradle*`, `build/`) is
  ignored — regenerate it with `bubblewrap update`.

`android/` must **not** be deployed to the web host. It is unrelated to what
the browser serves, and shipping it just puts build files in your docroot.

## Prerequisites

```sh
npm install -g @bubblewrap/cli
bubblewrap doctor          # offers to install JDK 17 + Android SDK for you
```

**Run `bubblewrap doctor` in a real terminal.** It is genuinely interactive
(licence acceptance, install paths) and cannot be driven by piping answers
into it.

State on this machine as of 2026-07-20, so you know where you're starting:

- JDK 17 — **installed**, at `~/.bubblewrap/jdk/jdk-17.0.11+9`.
- Android SDK — **not installed**; `androidSdkPath` in
  `~/.bubblewrap/config.json` is still empty. `bubblewrap doctor` will fill it
  in.

One quirk worth knowing: on Windows, Bubblewrap fetches the **32-bit** JDK
(`OpenJDK17U-jdk_x86-32_windows_hotspot`). It generally works, but if Gradle
dies with an out-of-memory error during `bubblewrap build`, that's why —
install a 64-bit JDK 17 and point `~/.bubblewrap/config.json` at it.

## First release

### 1. Create the signing keystore — you must do this, not an assistant

Whoever owns the Play listing owns this key. If it is lost, you can never
update the app under the same listing again; if it leaks, someone else can
publish as you. Keep it **outside this repo** (`twa-manifest.json` expects it
two levels up) and back it up somewhere durable.

```sh
keytool -genkeypair -v \
  -keystore ../../fieldcred-release.keystore \
  -alias fieldcred \
  -keyalg RSA -keysize 4096 -validity 10000
```

### 2. Build

```sh
cd android
bubblewrap update          # regenerates the Gradle project from twa-manifest.json
bubblewrap build           # prompts for the keystore passwords
```

Produces `app-release-bundle.aab` (upload this to Play) and
`app-release-signed.apk` (sideload this to test).

### 3. Wire up Digital Asset Links

Get your local key's fingerprint:

```sh
keytool -list -v -keystore ../../fieldcred-release.keystore -alias fieldcred | grep -i SHA256
```

Put it in `../.well-known/assetlinks.json` and deploy the website.
**Read `../.well-known/README.md` first** — there are two fingerprints and
using the wrong one is the usual cause of "my app shows a URL bar".

### 4. Submit to Play

Upload the `.aab` in Play Console. New apps require Play App Signing, so after
the first upload go to *Test and release → Setup → App signing*, copy the
**App signing key** SHA-256, add it to `assetlinks.json` alongside your local
one, and redeploy the website. Verification will not pass on store-installed
builds until you do.

## Shipping an update

Website changes need no app release at all. For an actual app change:

1. Edit `twa-manifest.json`, bumping **both** `appVersionCode` (integer, must
   strictly increase — Play rejects a reused value) and `appVersionName`.
2. `bubblewrap update && bubblewrap build`
3. Upload the new `.aab`.

## Multi-tenancy — known constraint

A TWA verifies against **one origin**. Tenants live on subdomains
(`acme.app.fieldcred.co`, see `js/lib/tenant.js`), and each subdomain is a
distinct origin, so a single Play listing cannot silently cover all of them:
navigating to a subdomain that is not in `additionalTrustedOrigins` drops the
user into a Custom Tab **with a visible URL bar**. The app still works, but it
stops looking like an app.

`.well-known/assetlinks.json` is shared across every subdomain (they wildcard
to one docroot), so the *website* side is already fine. The Android side has
two options:

- **Recommended — one listing, canonical host.** Gate devices run on
  `https://app.fieldcred.co/?tenant=<slug>`, which `js/lib/tenant.js` already
  supports and makes sticky in `localStorage`. One origin, one app, no
  per-customer release. The catch: gate and badge QR codes must be *generated*
  from that canonical host, since the QR embeds whatever origin the admin
  generated it on.
- **One entry per tenant.** Add each `<tenant>.app.fieldcred.co` to
  `additionalTrustedOrigins` and ship an app update per new customer. Correct,
  but it makes onboarding a customer require a Play release — avoid unless a
  customer specifically requires their own subdomain in the app.

If you go with the recommended option, verify that badge/gate QR generation
uses the canonical host before rolling gate devices out; today it uses
`location.origin` (`js/components/shareDialog.js`, `js/lib/badgeCards.js`).
