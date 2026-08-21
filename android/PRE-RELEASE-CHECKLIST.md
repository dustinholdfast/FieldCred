# Pre-release checklist — FieldCred Gate

Everything that has to be true before the gate app is deployed to the web and
submitted to Play. Written 2026-07-20, when the app had never been released
(`appVersionCode` 1, `shellApkVersion` 0, `assetlinks.json` still holding
placeholders).

**Why this file exists:** the gate app was verified in a desktop browser with
the camera blocked and no Supabase session. That left two whole surfaces —
supervisor mode and the real camera — never executed even once. Section 1 is
those. Do not skip them because the rest of the app looked fine; they share no
code paths with what was tested.

Legend: **[you]** needs a human (credentials, a real device, a Play account).

## Status — 2026-07-20

First on-device run done, on an Android phone against the dev server over a LAN
IP (`chrome://flags` → "Insecure origins treated as secure"), pointed at the
demo tenant.

**Confirmed working:** the camera opens and decodes; the gate app renders and
behaves; supervisor mode reached via sign-in, PIN set, supervisor side used.

**Still open** — do not assume these from the above, they exercise different
code paths:

- The **session-expiry test** in §1.1. This is the one that proves the PIN is
  not acting as the security boundary, and it is the easiest to skip precisely
  because everything else works.
- Camera **release** (indicator light out after navigating away) and the
  **>1 hour soak** that proves the orphaned-instance fix held across a token
  refresh — §1.2.
- All of **§3 Offline**. Not meaningfully testable over a LAN dev server:
  dropping Wi-Fi also drops the connection to the server. Needs either the USB
  route or a real HTTPS deploy.
- **§2** on every tenant other than demo.

---

## 1. Never-executed surfaces — blocking

### 1.1 Supervisor mode **[you]**

Not one of these screens has rendered. Sign in on the demo tenant and walk it.

Getting in:

- [ ] From guard home, tap the footer (`DEVICE LOCKED TO GATE MODE · SUPERVISOR
      SIGN-IN TO EXIT`). With no session it must go to `#/login`, not a PIN pad.
- [ ] After signing in you land back in the gate app, **not** the directory.
      (Login returns to `?next=/gate-app?sup=1`.)
- [ ] First time through, you get **SET A SUPERVISOR PIN**, not the unlock pad.
- [ ] Entering 4 digits auto-submits — there is no confirm key by design.
- [ ] You land on supervisor HOME.

Coming back:

- [ ] Return to gate mode (SITE tab → `RETURN TO GATE MODE`), then exit again.
      This time you get the **unlock** pad, not the set-PIN screen.
- [ ] A wrong PIN clears the dots and says "Wrong PIN — try again."
- [ ] The right PIN opens supervisor home.
- [ ] `Forgot it? Sign in instead →` reaches the login page.
- [ ] **Session-expiry path:** with a PIN set, clear the Supabase session
      (sign out in another tab, or clear its localStorage), then unlock with
      the *correct* PIN. It must bounce to `#/login` — a valid PIN with a dead
      session must never open the tabs. This is the check that proves the PIN
      isn't acting as the security boundary.

The three tabs:

- [ ] **HOME** — SCANS TODAY / CLEARED / BLOCKED show real numbers, and they
      count *today only*, not the whole log. Scan someone, come back, confirm
      the count moved.
- [ ] **HOME** — "RECENT SCANS" lists at most 5, newest first.
- [ ] **LOG** — full list; blocked rows carry a red `Missing: …` second line.
- [ ] **LOG** — with something queued offline, the amber "N offline scans
      queued" line appears.
- [ ] **SITE** — the site's required credential types match what the Sites
      admin screen shows for it.
- [ ] **SITE** — a site with *no* requirements says so plainly and does not
      imply anyone can be cleared.
- [ ] **LOOKUP** tab opens the lookup screen and closing it returns to
      *supervisor* home, not guard home.
- [ ] Tab bar: the active tab inverts (navy fill, white text).

### 1.2 Real Android device, real camera **[you]**

The preview pane blocks `getUserMedia`, so none of this has run. Use a real
Android phone or tablet on Chrome.

- [ ] Camera opens on the scanner screen and the viewfinder shows live video.
- [ ] A badge QR decodes. (Android Chrome should take the native
      `BarcodeDetector` path — `js/vendor/jsqr.mjs` is only the fallback.)
- [ ] **Scan two workers in a row without leaving the scanner.** The camera
      must *not* restart between them — this is the entire reason this app
      exists rather than routing to `/r/:slug`.
- [ ] Haptics are distinguishable without looking: cleared = one short buzz,
      blocked = three, unrecognized = one long.
- [ ] A site gate QR (`#/gate/:slug`) re-pairs the device from inside the app.
- [ ] A QR that isn't FieldCred's (any random one) keeps scanning quietly —
      no verdict screen, no buzz.
- [ ] **Camera release:** background the app (home button), return — camera
      comes back. Lock the screen, unlock — camera comes back. Navigate away
      from the gate app entirely — **the camera indicator light goes out.**
- [ ] Leave the app open in gate mode for over an hour, then scan. It must
      still work: Supabase refreshes its token about hourly, and each refresh
      re-enters the page. (This is the orphaned-instance bug fixed in
      `js/pages/gateApp.js`; an hour is the cheapest way to prove it stayed
      fixed.)
- [ ] Deny camera permission once and confirm the error screen offers
      `LOOK UP BY NAME` rather than dead-ending.

---

## 2. Backend, per tenant **[you]**

Migration 011 is verified on **demo only**. Every other tenant needs it, or its
gate devices will show "DO NOT ADMIT" for everyone.

For each tenant project:

- [ ] `supabase/migrations/011_gate_companion.sql` applied.
- [ ] `typeId` comes back on a public record:
      ```sql
      select c ->> 'typeId'
      from public_workers w, jsonb_array_elements(w.certifications) c
      limit 5;
      ```
      All `null` means certs aren't tagged yet — run the credential-type
      backfill from the Admin screen. The key being *absent* means the view
      didn't update.
- [ ] Decide on roster lookup and make it explicit:
      ```sql
      -- on: guards can look workers up by name
      grant execute on function public.search_site_roster(text, text) to anon, authenticated;
      -- off: supported opt-out; guards see "turned off for gate devices here"
      revoke execute on function public.search_site_roster(text, text) from anon;
      ```
      **On demo this grant is currently missing** — decide whether that was
      intentional.
- [ ] At least one site has required credential types set. A site with none
      can clear nobody, by design.
- [ ] Remove the probe row left in demo's audit log on 2026-07-20:
      ```sql
      delete from public.gate_scans where site_slug = '__probe__';
      ```

---

## 3. Offline behaviour

Best done on the real device, with airplane mode.

- [ ] Scan a worker while online (this is what caches them), then go offline
      and scan the same worker: verdict still appears, with
      "● Verdict from cached data (…)".
- [ ] Guard home shows the amber OFFLINE banner and a queued-scan count.
- [ ] The verdict footer says **QUEUED FOR SITE LOG**, not "LOGGED".
- [ ] Come back online — the queue drains and the scans appear in the LOG tab.
- [ ] A worker **never seen on this device** with no signal fails closed: it
      must not produce a green screen.
- [ ] Reboot the device with no signal and open the app. It should still boot
      into the kiosk (service worker `fieldcred-shell-v4`).

---

## 4. Web deploy

The website deploy is what actually ships the gate app. No APK is involved.

- [ ] Merge `gate-companion-app`.
- [ ] `node --test` passes (109 tests as of this commit).
- [ ] Deploy. Do **not** deploy `android/`, `Marketing/`, or `billing-service/`
      to the docroot.
- [ ] Load `https://app.fieldcred.co/#/gate-app` in a normal mobile browser and
      confirm it renders before touching Play.
- [ ] Confirm the service worker updated (`fieldcred-shell-v4`) — the app ships
      unhashed filenames, so a stale shell is the usual "my fix didn't deploy".

---

## 5. Play Store — first release **[you]**

Order matters here; step 5.5 cannot be done before 5.4.

- [ ] `bubblewrap doctor` in a real terminal. The Android SDK is **not**
      installed yet and this prompt is genuinely interactive.
- [ ] **Create the signing keystore yourself.** Not an assistant, not in the
      repo, backed up somewhere durable. Lose it and you can never update this
      listing again; leak it and someone else can publish as you.
      ```sh
      keytool -genkeypair -v -keystore ../../fieldcred-release.keystore \
        -alias fieldcred -keyalg RSA -keysize 4096 -validity 10000
      ```
- [ ] `bubblewrap update && bubblewrap build`.
- [ ] Put your **local key** SHA-256 into `.well-known/assetlinks.json`,
      replacing `REPLACE_WITH_UPLOAD_OR_LOCAL_KEY_SHA256`. Deploy the site.
- [ ] Sideload `app-release-signed.apk` and confirm it opens **without a URL
      bar** and lands on the gate app.
- [ ] Upload the `.aab` to Play Console.
- [ ] Play Console → Test and release → Setup → App signing → copy the **App
      signing key** SHA-256 into `assetlinks.json`, replacing
      `REPLACE_WITH_PLAY_APP_SIGNING_SHA256`. **Deploy the site again.**
      Expect the first store install to show a URL bar until this is done —
      that key does not exist until after the first upload. It is not a bug.
- [ ] Install from the Play track and confirm the URL bar is gone.

Listing prerequisites, which gate submission independently of the build:

- [ ] Privacy policy URL.
- [ ] Data safety form — the app uses the camera. It decodes QR codes on-device
      and does not upload images; declare what is actually true.
- [ ] Content rating questionnaire, target audience, store listing copy and
      screenshots.

---

## 6. Decisions to confirm before rollout

- [ ] **`startUrl` is `/#/gate-app`.** Changed before first release, while it
      was free. If the app should open the plain scanner instead, change it now
      — after release it costs a version bump and a review.
- [ ] **Canonical host for gate devices.** Run them on
      `https://app.fieldcred.co/?tenant=<slug>`, one origin, one listing. The
      QR-origin caveat in `android/README.md` does *not* affect the in-app
      scanner (it reads the slug and never visits the URL), but it does affect
      anyone scanning a badge with the phone's native camera app.
- [ ] **Supervisor PIN is a convenience lock, not a boundary.** Whoever
      operates the gates should know a shared tablet's PIN protects nothing on
      its own — the Supabase session does. Worth one line in the rollout notes.
