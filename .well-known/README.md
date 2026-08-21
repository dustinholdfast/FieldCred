# `.well-known/assetlinks.json`

Digital Asset Links — what lets the Android app (a Trusted Web Activity) open
`app.fieldcred.co` **without browser chrome**. Chrome fetches this file at
launch and checks that it names the running app's package and signing
fingerprint. If verification fails, the app still works but renders inside a
visible Custom Tab with a URL bar, which is the usual symptom people describe
as "my TWA shows an address bar".

`assetlinks.json` is plain JSON and cannot carry comments, hence this file.

## Why there are two fingerprints

This is the single most common reason TWA verification fails, so read this
before pasting anything in.

When you upload an `.aab` to Google Play with **Play App Signing** on (the
default, and mandatory for new apps), Google re-signs the app with a key you
never possess. The APK that reaches a user's phone is therefore *not* signed
with your keystore:

1. **Play App Signing key** — what installed apps from the Play Store are
   actually signed with. **This is the one that matters in production.**
   Play Console → your app → *Test and release* → *Setup* → *App signing* →
   copy the SHA-256 under "App signing key certificate".
   Note it only exists after your first upload, so the very first release
   necessarily happens before you can fill this in.
2. **Upload / local key** — your own keystore. Needed so a locally built
   `bubblewrap build` APK, installed over USB, also verifies. Get it with:

   ```sh
   keytool -list -v -keystore android.keystore -alias android \
     | grep -i "SHA256:"
   ```

Keeping both listed means local test builds and Play builds both verify. There
is no downside to listing both.

## Deploying it

The file must be reachable at exactly:

```
https://app.fieldcred.co/.well-known/assetlinks.json
```

served as `application/json`, over HTTPS, with **no redirect** — Chrome does
not follow redirects when verifying, so an http→https or www→apex hop makes
verification fail silently.

Tenant subdomains wildcard to this same docroot, so this one file
simultaneously covers `acme.app.fieldcred.co` and every other tenant — which
is what lets a single Play listing serve all customers rather than one app per
tenant. If tenants are ever split onto separate hosts, each host needs its own
copy of this file and the extra origins must be added to
`android/twa-manifest.json` under `shortcuts`/`additionalTrustedOrigins`.

## Verifying

After deploying, check it end to end with Google's own API:

```sh
curl -s "https://digitalassetlinks.googleapis.com/v1/statements:list?\
source.web.site=https://app.fieldcred.co&\
relation=delegate_permission/common.handle_all_urls" | grep -i maxAge
```

A `maxAge` in the response means the statement was fetched and parsed. On the
device, `chrome://internals/#digital-asset-links` shows the live verification
result for an installed app.
