# FieldCred — Security Incident Log

Separate from CHANGELOG.md on purpose. This is the document that answers
"have you had a security incident" honestly and specifically, instead of
from memory, the first time a design partner's security review asks.

Every entry gets a severity, an honest exposure assessment, and a
resolution date. **Findings from your own testing/audit count and
belong here** — a self-found, promptly-fixed issue is a credibility
asset in a security conversation, not something to omit. What matters
to a reviewer is whether you have a process that catches things, not
whether the count is zero.

## Severity guide
- **Critical** — PII or credentials exposed to unauthenticated parties
- **High** — sensitive data exposed to authenticated-but-wrong-tenant, or a control that silently doesn't work
- **Medium** — data integrity/availability issue with no confidentiality impact
- **Low** — hardening gap with no evidence of exploitation path

---

## INC-001 — Legacy tables exposed worker PII to anonymous traffic
**Date found / fixed:** 2026-07-11 (same day)
**Severity:** Critical
**Discovered by:** Internal SQL audit (RLS policy review), not external report

**What:** `employees` and `employee_certifications` — tables from an
abandoned v1 data model, not part of the current schema template — had
an anon SELECT policy granting unrestricted read access. Exposed
first/last name, email, phone, job title, department, hire date, and
certificate numbers to anyone with the public anon API key (which is,
by design, embedded in the client-side JS bundle).

**Exposure assessment:** FieldCred had zero customers, zero organic
traffic, and no public listings at the time. No evidence of external
access. Table contents were not confirmed empty before deletion
(should have been checked first — noted as a process gap, see
CHANGELOG 2026-07-11).

**Resolution:** Tables dropped. Confirmed via direct REST fetch
(404 post-fix).

---

## INC-002 — Credential/license numbers exposed via public badge view
**Date found / fixed:** 2026-07-11 (same day)
**Severity:** High
**Discovered by:** Internal audit

**What:** The `public_workers` view (what the public QR badge page
reads) passed the full `certifications` jsonb column through
unfiltered, including a `number` field — credential/license lookup
numbers. Not phone/email (those were already correctly excluded by
column choice), but a lookup key that shouldn't be public regardless.

**Exposure assessment:** Same low-traffic caveat as INC-001. Slugs
were also guessable at the time (see INC-004), somewhat raising the
plausibility that this could have been enumerated, though no evidence
it was.

**Resolution:** View rebuilt as an explicit key whitelist rather than
a passthrough.

---

## INC-003 — Certificate PDFs reachable from an anonymous QR scan
**Date found / fixed:** 2026-07-11 (same day)
**Severity:** Critical
**Discovered by:** Internal audit, during certificate-upload feature work

**What:** Two independent issues stacked:
1. The `certificates` storage bucket was public with no role
   restriction on its read policy.
2. `publicCertCardHtml` (rendered on the anonymous public badge page)
   contained a working `<a href>` download link directly to
   `certificateFileUrl`.

Combined effect: a certificate PDF — typically carrying full legal
name, license number, issuing authority, sometimes DOB — was one tap
away from anyone who scanned a worker's public QR badge. This is a
materially worse exposure than INC-002: a downloadable identity
document, not just a status field.

**Exposure assessment:** Same low-traffic caveat. 6 files existed in
the certificates bucket at discovery; confirmed orphaned (no worker
record referenced any of them — consistent with pre-launch manual
testing, not real customer uploads) before deletion.

**Resolution:** Bucket flipped to private, authenticated-only read
policy. The download link in `publicCertCardHtml` was **deleted from
the code**, not merely starved of data by the view fix — so the
public page's safety doesn't depend on the data layer alone
remembering to withhold the field going forward.

---

## INC-004 — Guessable public badge URLs (roster enumeration)
**Date found / fixed:** 2026-07-11 (same day)
**Severity:** Medium
**Discovered by:** Internal audit

**What:** Public badge slugs were bare names (`james-carter`) rather
than including the random suffix the app's own `makeSlug()` was
supposed to generate. Root cause: seed data was inserted via raw SQL,
bypassing the app's slug logic entirely — the app code itself was
correct but unexercised for these rows. Separately found the app's
random-suffix generator used `Math.random()` (non-cryptographic, 4
characters) rather than the already-defined, unused
`crypto.getRandomValues()`-based function in the same file.

**Impact if exploited:** Enumerating common surnames would confirm
which named individuals work at a company, their role, and their
certification status — without defeating any authentication, just
guessing URLs.

**Resolution:** All existing slugs regenerated with 8-char
cryptographically-random suffixes; unique constraint added.
`makeSlug()` fixed to use the existing crypto-random function.

---

## INC-005 — Public badge displayed incorrect (non-expired) status for an expired credential
**Date found / fixed:** 2026-07-11 (same day, ~hours after the fix that caused it)
**Severity:** Medium (data integrity / availability of accurate compliance status — no confidentiality impact)
**Discovered by:** Manual QA — comparing the authenticated profile view against the public badge view for the same worker after editing a certification

**What:** A corrected `public_workers` view (fixing INC-002) was
written and delivered as an updated `schema.sql` file, with the
instruction to commit it to the repo. That instruction was not
followed by an explicit "now execute this against the live database."
Committing a file to version control does not apply it to a running
system — the live database kept running the *previous* version of the
view. When a worker's certification was subsequently edited and
expired through the real application, the live (stale) view was
looking for field names that no longer matched the app's actual data
shape, returned null for the expiry date, and downstream status logic
rendered that as non-expired ("Cleared to work") on the public badge.

**For a product whose entire value proposition is accurate real-time
compliance status, this is the most product-relevant finding in this
log**, even though it carries no data-confidentiality component.

**Exposure assessment:** Unknown duration between the view fix being
written and being caught — bounded by same-session discovery, but the
exact window within that session isn't precisely known.

**Resolution:** Corrected view executed directly against the live
database; confirmed via direct anon REST fetch. Process fix: SQL
changes are now applied and confirmed via pasted query output in the
same exchange they're written, never bundled into a "here's an updated
file" handoff (see CHANGELOG.md header rule).

---

---

## INC-006 — Tenant-lookup fallback could silently connect to the wrong project in production
**Date found / fixed:** 2026-07-11 (same day)
**Severity:** High (by design, not by current impact — see exposure assessment)
**Discovered by:** Internal audit — tracing the full tenant-resolution chain (tenant.js → tenant-lookup.php → tenants.php → supabaseClient.js)

**What:** `supabaseClient.js` fell back to a hardcoded project (`config.js`)
whenever a tenant lookup failed, for any reason — unregistered slug,
`tenant-lookup.php` unreachable, network error — with no way to
distinguish a legitimate local-dev scenario (the fallback's documented
purpose) from a production failure. Confirmed `config.js` holds real,
live credentials for the primary project (`qiozckjlojvhdtrsjzfp`), not
placeholders.

**Exposure assessment:** No impact to date — the fallback project and
the sole existing tenant (`default`) are the same project, so the
fallback firing was indistinguishable from correct behavior. Risk was
structural, not yet realized: the first tenant added with a *different*
project would have been exposed to silently landing on this project
instead of failing visibly, on any lookup failure. Caught before any
second tenant was provisioned.

**Resolution:** `supabaseClient.js` now gates the fallback to explicit
local-dev signals (`localhost` / `127.0.0.1` / `file:`) only. Any
lookup failure outside those contexts fails closed — `isConfigured =
false`, `supabase = null` — instead of connecting anywhere.
`config.js` itself left as-is (real credentials); no longer reachable
in production regardless, though swapping it for placeholders remains
a reasonable optional hardening step.

Also fixed same session: `tenant-lookup.php` was returning the full
tenant record (`name`, `domains`) instead of the `{url, anonKey}` its
own comment claimed — whitelisted explicitly. `tenants.php`'s
protection (relies on always being parsed as PHP, never served as
static text) — relocated outside the web root; **confirmed via direct
request returning 404, and confirmed the app still loads/logs in
normally post-move** (verifies `tenant-lookup.php`'s `require` path to
the relocated file still resolves).

## Template for new entries

```
## INC-00X — Short description
**Date found / fixed:** 
**Severity:** Critical | High | Medium | Low
**Discovered by:** 

**What:** 

**Exposure assessment:** 

**Resolution:** 
```
