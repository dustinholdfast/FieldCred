# FieldCred — Changelog

Source of truth for every change made to FieldCred's database, storage
config, and application code. If it's not in here, it didn't happen —
and if it's in here, it's because it was **confirmed applied**, not
just written.

## The one rule that matters

**Never log a change on the strength of "I wrote/generated the fix."**
Log it only after you've run it against the live system (or shipped the
code) and confirmed the result — a query output, a passing test, a
manual click-through. A migration file sitting in the repo unapplied is
not a change. This log exists specifically because that distinction got
blurred once already (see 2026-07-11, public_workers view) and a live
worker profile showed wrong data for an unknown period as a result.

## Entry format

```
## YYYY-MM-DD — Short title
**Type:** Schema | Storage | Code | Config
**Applied to:** [tenant project ref(s), or "N/A — template only"]
**Verified by:** [what you ran/checked to confirm it worked]

What changed and why, in a sentence or two.

Files: `path/to/file` (if code) or migration number (if SQL)
Rollback: how to undo this, if not obvious
```

---

## 2026-07-11 — Security hardening pass (multiple entries, one session)

### Legacy PII tables dropped
**Type:** Schema
**Applied to:** qiozckjlojvhdtrsjzfp (primary/only tenant project)
**Verified by:** REST endpoint returned 404 for `employees` and
`employee_certifications` post-drop; confirmed via incognito fetch.

`employees` / `employee_certifications` — an abandoned v1 shape
(name, email, phone, certificate_number) — had an anon SELECT policy of
`true`, exposing full worker PII to unauthenticated internet traffic.
Not part of `schema.sql`; created out-of-band, likely early manual
testing. Dropped.

Migration: `001_security_hardening.sql`
Rollback: N/A — tables held no data worth preserving (confirmed empty
before drop was not fully verified; treated as acceptable given
zero live customers at time of fix).

### RLS enabled on all base tables
**Type:** Schema
**Applied to:** qiozckjlojvhdtrsjzfp
**Verified by:** `select relname, relrowsecurity from pg_class ...`
returned `true` for workers, certifications, settings, plan_limits.

Belt-and-braces — policies are inert without RLS on. Confirmed already
true for most tables; enforced explicitly regardless.

Migration: `001_security_hardening.sql`

### public_workers view — credential number leak (v1 fix)
**Type:** Schema
**Applied to:** qiozckjlojvhdtrsjzfp
**Verified by:** anon fetch of `public_workers` showed no `number`
field in cert objects.

View was passing the full `certifications` jsonb through to anon,
including `number` (credential/license lookup key — not a status).
Rebuilt as an explicit key whitelist. **This version used
`issued_date`/`expiration_date` as key names, copied from seed data —
these do not match the app's real field names.** Superseded same day,
see below.

### public_workers view — corrected field names (v2 fix)
**Type:** Schema
**Applied to:** ⚠️ Written into `schema.sql` and handed over as a file.
**NOT confirmed applied to qiozckjlojvhdtrsjzfp at time of writing** —
this is the gap that caused the incident below.

Real app cert shape (from `state.js` `emptyCert()`) uses `earnedDate` /
`expiryDate` / `badgeImageUrl` / `verificationUrl` / `certificateFileUrl`,
not the seed data's snake_case keys. v1 fix above would have silently
shown blank dates on every real (non-seed) worker's public badge.

**INCIDENT:** this fix was delivered as an updated `schema.sql` file
with instructions to "reupload to the repo." That instruction was never
followed by an explicit "now run this in the SQL editor." Committing a
file to a repo does not execute it against a live database. The old
(v1) view kept running live. When Charles Davis's certification was
edited through the real app and re-saved in the app's actual field
shape, the live view — still looking for the old key names — returned
`null` for both dates. Downstream status logic treated `expiryDate:
null` as valid rather than expired. A newly-expired certification
displayed as "Cleared to work" on the public badge page for an unknown
period until caught by manual QA (comparing the authenticated profile
view against the public badge view for the same worker).

**Fixed:** view re-run directly in SQL editor 2026-07-11, confirmed via
direct anon fetch showing real `earnedDate`/`expiryDate` values and the
correct expired status rendering on the public page.

Also added `verificationUrl` and `badgeImageUrl` to the whitelist
(both intentionally public); confirmed `certificateFileUrl` excluded.

Migration: `schema.sql` (public_workers view block)
Verified by: `select * from public_workers where public_slug = '<slug>'`
— confirmed `earnedDate`/`expiryDate` populated, `number` and
`certificateFileUrl` absent.

**Follow-up required:** any worker whose certifications still carry the
old `issued_date`/`expiration_date` shape (unedited seed data) will now
show null dates publicly. Check:
```sql
select name from workers
where certifications::text ilike '%issued_date%'
   or certifications::text ilike '%expiration_date%';
```

### link_expires enforcement added
**Type:** Schema
**Applied to:** qiozckjlojvhdtrsjzfp
**Verified by:** view definition includes the `safe_to_date()` predicate;
not yet stress-tested against malformed `link_expires` values in
production data.

Column existed, was never enforced — a badge never actually stopped
being public regardless of what the UI implied. Added `safe_to_date()`
(fails closed on unparseable input) and a WHERE clause. `'never'` means
no expiry.

Migration: `schema.sql`

### Storage: certificates bucket locked, per-bucket policies
**Type:** Storage
**Applied to:** qiozckjlojvhdtrsjzfp
**Verified by:** anon fetch of a known certificate object returned
400/404 post-fix; a known photo object still returned 200.

Single "Public read of fieldcred images" policy granted SELECT with no
role restriction (defaults to `public` = everyone) across all three
buckets, including certificates. Certificate PDFs carry full legal
name, license number, issuing body, sometimes DOB — a materially
different sensitivity class from a headshot. Split into
`certificates` (private, authenticated-only) vs `photos`/`badges`
(stays public — badge page hotlinks with no session).

Also fixed bucket-insert idempotency: was `on conflict do nothing`,
which meant re-running schema.sql against an existing project could
never flip an already-public bucket back to private. Changed to
`do update set public = excluded.public`.

Migration: `schema.sql`, `001_security_hardening.sql`

### 6 orphaned certificate files deleted
**Type:** Storage
**Applied to:** qiozckjlojvhdtrsjzfp
**Verified by:** `select count(*) from storage.objects where
bucket_id = 'certificates'` → 0 post-delete.

Bare-UUID files with no reference from any worker's `certifications`
jsonb — predate the app ever having a working certificate-upload path.
Confirmed orphaned (grepped all worker cert JSON for any url/file/path
key; none found) before deletion.

### Public slug entropy
**Type:** Schema + Code
**Applied to:** qiozckjlojvhdtrsjzfp (data backfilled); code fix ships
with next deploy
**Verified by:** `select public_slug from workers` — all 15 rows show
an 8-char hex suffix post-backfill; confirmed via regex
`~ '-[a-f0-9]{8}$'`.

Seed data had bare-name slugs (`james-carter`) — guessable, allowing
roster enumeration by trying common surnames. Backfilled all existing
rows with random 8-char hex suffixes; added a unique index.
Separately found `makeSlug()` in `state.js` was using
`Math.random().toString(36).slice(2,6)` (non-cryptographic, 4 chars)
instead of the already-defined-but-unused `randomSuffix()`
(crypto.getRandomValues, 8 chars). Fixed to call it.

Files: `state.js` (`makeSlug`)

---

## 2026-07-11 — Certificate upload feature (previously broken)

**Type:** Code + Schema
**Applied to:** qiozckjlojvhdtrsjzfp (schema); code ships with deploy
**Verified by:** end-to-end manual test — uploaded a cert as staff,
saved successfully, opened it via signed URL from the authenticated
view, confirmed absent from the public badge page, confirmed a signed
URL expired after ~6 minutes.

Certificate PDFs upload but the save path called `uploadImage('certificates', file)`,
which uses `getPublicUrl()` — incompatible with the now-private
certificates bucket (returns a URL that never resolves). Also found:
`publicCertCardHtml` (public badge page) had a **live, working download
link** straight to `certificateFileUrl` before the view fix above
neutralized it — i.e. certificate PDFs were one tap from an anonymous
QR scan. Removed outright rather than left dormant.

Two unrelated latent bugs surfaced only once this path actually ran
end-to-end for the first time:
- `makeId()` was called throughout `state.js` (`emptyCert()`, both
  upload functions) but never defined or imported anywhere in the
  codebase. Added, using `crypto.randomUUID()`.
- `crypto.randomUUID()` then failed in the test environment (requires
  a secure context — HTTPS or localhost — that this environment
  apparently doesn't have). Replaced with a hand-built 128-bit ID from
  `crypto.getRandomValues()`, already proven working elsewhere in the
  same file.

Files: `state.js` (`uploadCertificate`, `getCertificateUrl`, `uploadImage`
guard, `makeId`), `editProfile.js` (save flow, "View current" link),
`certCard.js` (`certRowHtml`, `publicCertCardHtml`), `profile.js`
(click wiring)

---

## Template for new entries

```
## YYYY-MM-DD — Short title
**Type:** Schema | Storage | Code | Config
**Applied to:** [project ref(s)]
**Verified by:** [specific check you ran]

Description.

Files/Migration: ...
Rollback: ...
```
