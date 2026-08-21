# FieldCred — Platform Review & Five Recommendations

Reviewed 2026-07-29 against the working tree at `D:\Claude\Projects\fieldcred`. Sized against your actual budget: 5–10 hrs/week, day-90 target of 3–5 paying customers.

## What's genuinely good, so you know what not to touch

The engineering discipline here is above the norm for a one-person pre-launch product, and three specific decisions are load-bearing — don't undo them:

- **Clearance is derived in exactly one place** (`js/lib/clearance.js`, called by `gateVerdict.js`) and **re-derived server-side** in `record_gate_scan()`. A client can't forge a green verdict. Most competitors can't say this.
- **Offline gate verdicts fail closed** and label their own staleness. Reviewers of HammerTech, SiteDocs and myComply beg for working offline mode; HammerTech's is vendor-claimed and disputed by its own Capterra reviewers. This is a real differentiator — lead with it in sales.
- **`gate_scans` is append-only over PostgREST** (SECURITY DEFINER write path only, no insert policy for anyone) and denormalizes site/worker names so renames don't rewrite history.

Also: 20 real help-center articles, 13 passing unit tests on the pure logic, and a per-tenant-project isolation model that makes "is my data mixed with another contractor's?" a non-question.

## Market context that shapes every recommendation below

**myComply publishes $499 / $999 / $1,999 per year** by worker count, and the base tiers already include certification management, expiration alerts, training matrices and document sharing. They ship Procore and Autodesk integrations. They own your price band with a superset of your admin features.

**But their gate — NFC Smart Badge + Smart Brick reader — sits in the $6,999–8,999/yr Pro Pack.** Smartapp's JobSite BADGE kiosk is $695/mo. Avetta's kiosk is APAC-only. HammerTech and ISN are GC-paid or network-priced, and every one of them assumes a general contractor deploys the gate.

**Your wedge is one sentence: a credential-checked gate that works offline, needs no proprietary hardware, is included in the base price, and can be deployed by the subcontractor without waiting for a GC to mandate anything.** Every recommendation below either widens that wedge or removes something blocking you from selling it.

One more thing worth saying out loud in sales: **OSHA explicitly does not operate any database to verify course-completion cards** and "for privacy reasons, OSHA does not provide individual verification." Your manual attestation model isn't a gap — it's the industry state of the art, and you can prove it. NCCCO crane cards issued 2022+ are the only trades credential I found with a real QR-based public verifier.

---

# 1. Close the money path and kill the manual-FTP tenant registry

**This is not a feature request. It is the reason the platform cannot currently accept a customer.**

Current state, verified in the tree:

- `signup-config.php` still has `notifyEmail => 'YOUR_EMAIL@example.com'` and `resendFrom => 'onboarding@resend.dev'` (Resend's shared test sender, which can only deliver to the account owner's own address). To be clear about what this does **not** break: the `pilot.fieldcred.co` landing page POSTs straight to the HubSpot Forms API and never touches the PHP endpoints, so pilot leads are fine. What it *does* break is the in-app **"Request more capacity"** click in `admin.js` (~line 431) and the **"Request access"** form in `js/pages/signup.js` — both POST to `./signup-notify.php`, and `signup-notify.php` line 73 only guards on the API key, so it no longer 500s. It proceeds to call Resend with a placeholder recipient. Either the lead is silently black-holed at example.com while the prospect sees success, or Resend rejects and line 118 returns a 502. Neither is an outbound-blocker, but both are silent failures on real inbound paths.
- Stripe: `PRICE_TIER_MAP_JSON` is still `price_REPLACE_ME`. No Checkout session code. `billing-service/` has no `.env.local` and no confirmed Railway deploy. `index.html`'s CSP `connect-src` excludes the billing host, so the browser would refuse the fetch even if wired. `js/pages/admin.js` posts upgrade clicks to `signup-notify.php`, not `/api/portal-session` — nothing in `js/` mentions Stripe at all.
- **The architectural one:** provisioning ends at `status = 'awaiting_deploy'` because the tenant registry is a flat PHP file. A paying customer cannot log in until you manually FTP an entry into `tenants.php`. That's a human step wedged into the middle of the signup funnel, and it's also a single point of failure for every existing tenant.

**Do this:** move the registry from `tenants.php` to a table in a small control-plane Postgres (the billing service already has one — `billing-service/schema.sql`), and have `tenant-lookup.php` read from it. Keep the flat file as a fallback if you want a safety net. That single change turns provisioning from "scripted, then Dustin FTPs a file" into "scripted, done" and lets `provision.mjs` finish the job it already almost does.

**Effort:** ~4 hrs for the config/CSP/Stripe wiring, ~6–8 hrs for the registry move. **Do the config fixes this week.**

---

# 2. Turn the gate from a scan log into a presence system

This is the highest value-per-hour functional expansion in the product, and it's mostly one migration.

`gate_scans` today has a single `scanned_at` and **no direction, no device identity, no guard identity**. There is no "who is on site right now" query anywhere in the codebase. The supervisor HOME tab counts SCANS TODAY / CLEARED / BLOCKED — not people present. A re-scan is just a second independent row.

Buyers will assume your gate produces a headcount, because every adjacent product's does. myComply's entire NYC LL196 pitch is that "Local Law 196 requires permit holders to keep accurate daily attendance logs" and its badges auto-generate timecards. HammerTech markets instant evacuation roll-call.

**Add, in order:**

1. **`direction` on `gate_scans`** (`in` / `out`, default `in`) plus a mode toggle on the gate app. One migration, one button.
2. **A "ON SITE NOW" supervisor tab** — workers whose latest scan today is `in`. This is the muster/evacuation roll-call, and it's a view, not a subsystem.
3. **`device_id` and `guard_label`** on the scan row, sourced from `gateSession.js`. Right now a scan log entry can't answer "which tablet, which guard" — that's a hole in the audit story you're selling.
4. **Put the worker's photo on the verdict poster.** `gateApp.js` currently renders `initialsSquareHtml(...)` — initials in a box — even though `photo_url` is already on the `public_workers` view and already reaching the client. As it stands, a photograph or screenshot of someone else's badge produces a fully confident CLEARED poster with no way for the guard to catch it. This is close to a one-line fix with an outsized credibility payoff.

**Draw the line deliberately at presence, not payroll.** Don't compute hours, don't export to payroll, don't call it timekeeping. "Who's on site, and are they cleared" is your product. "How many hours did Miguel work" is someone else's, and chasing it will eat the next year.

**Effort:** ~10–14 hrs total. Item 4 alone is under an hour and I'd ship it first.

---

# 3. Fix the notification layer — and alert on blocked scans

The moment your entire product exists for — a worker turned away at the gate — **currently generates no notification to anyone.** The guard sees a red screen, a row lands in `gate_scans`, and that's it. The supervisor finds out when someone calls.

The rest of the alerting story is below market too:

- **One recipient.** `settings.notification_email` is a single tenant-wide inbox. No per-site, per-department, or per-supervisor routing. No per-user preferences — there's no user table to hang them on.
- **One window.** `RENEWAL_WINDOW_DAYS = 60` is a global constant in `status.js`. HCSS ships configurable 30/60/90-day alerts as a headline feature. Expiration Reminder — $49/mo — includes SMS from its lowest tier.
- **One cadence.** Daily or weekly, one hour, one timezone.
- **No worker ever hears about their own expiring card.** Every renewal starts with an admin noticing.

**Do this:**

1. **Immediate blocked-scan alert** to a per-site notification address. Highest-value, smallest scope: the Edge Function pattern already exists, and this is arguably the single most sellable notification in the product ("you'll know before the worker calls you").
2. **Tiered expiry windows** — 90/60/30/7 day tiers with a sent-flag per cert per tier so the same card doesn't nag daily for 90 days.
3. **Per-site recipient routing.** A `notification_email` on `sites`, falling back to the tenant default.
4. **SMS via the Resend account's sibling or Twilio** — defer, but know that a $49/mo competitor includes it and your buyers are field people who don't read email.

**Effort:** ~6 hrs for the blocked-scan alert, ~8–10 for tiered windows plus routing.

---

# 4. Make the audit pack the thing that gets forwarded

Your own ICP doc names the trigger: *"The GC wants every cert before Monday."* The product's answer to that today is a browser print-to-PDF popup, per-site only, that produces no file.

Specifically:

- `auditPack.js` builds an HTML string, `siteDetail.js` opens it in a popup, and you print it. Header comment: *"No PDF library — 'PDF' is the browser's print-to-PDF."* No file is produced, nothing is stored, nothing is emailed, and there is no CSV or JSON form.
- **No tenant-wide report exists** — `CHANGES.md` lists it as out of scope.
- The pack contains no photos, no badge images, and no links to the certificate PDFs themselves (private bucket, 300-second signed URLs).
- No document ID, no hash, no page numbers, no tamper evidence beyond a "Generated <timestamp>" line.
- **Worker and cert records are freely mutable with no change log at all.** `updateWorker` overwrites the whole `certifications` jsonb. The prior expiry date, the prior file, and who changed it are unrecoverable. An expiry date can be edited *after* a blocked scan with no trace. For a product whose pitch is audit-readiness, that's the soft spot a sharp safety manager will find.

**Do this:**

1. **A shareable, expiring compliance-packet link** — the same content, served at a public slug the GC opens with no login, with an expiry date like the worker share links already have (`publicLinks.js` gives you the pattern). This is your poor man's integration and your best distribution channel: the artifact your customer sends to a GC has your product's name on it, and the GC is your next lead. This is the single highest-leverage item on this whole list.
2. **A real PDF file**, not a print dialog — plus a machine-readable CSV/JSON sibling so it can be attached to an ISN or Avetta submission.
3. **A tenant-wide rollup** across all sites.
4. **An append-only `cert_changes` log** (worker, cert, field, old value, new value, actor, timestamp). Cheap to write, and it converts "we have records" into "we can prove nobody edited the records."

**Effort:** ~12–16 hrs for items 1 and 4 together. Items 2 and 3 can wait.

---

# 5. Put Spanish on every worker-facing screen

**Hispanic workers are 32% of the US construction workforce** (NAHB, Oct 2025 — up from 23.6% in 2010). Every string in FieldCred is a hardcoded English literal, `index.html` is `<html lang="en">`, and grepping `js/` for i18n/locale/translation returns only `localeCompare` sort calls.

For an admin-only tool that's a defensible defer. **The gate kiosk is not an admin-only tool.** The highest-stakes text in your entire product — a full-screen **NOT CLEARED** poster and "Direct the worker to their supervisor" — is read by the worker standing at the gate, and there is no Spanish rendering path for it. That's a real failure mode, not a nice-to-have.

There's a compliance angle too: OSHA inspectors now log "Language used" per training event, and trade-association guidance for 2026 flags documentation-and-language gaps as the source of most costly penalties.

**Scope it narrowly.** You don't need to translate the admin dashboard. You need a message catalog covering:

- the gate verdict posters and guard-facing prompts in `gateApp.js`
- the public record page (`publicRecord.js`)
- the printed badge card (`badgeCards.js`)

That's on the order of 60–80 strings, plus a language toggle persisted in `gateSession.js` alongside the paired site. Pull the strings into a `js/lib/i18n.js` catalog as you go; the rest of the app can migrate later or never.

**Effort:** ~8–10 hrs. Cheap, differentiating, and it demos beautifully.

---

# What I'd deliberately NOT build, and why

Being explicit about this is worth as much as the list above, because each of these will get asked for and each will cost you a quarter.

- **Worker self-service / a worker app.** Being commoditized to $0 by the credential issuers themselves. ISN's Empower app is free to all ISN contractor subscribers. As of Feb 2026, **BuilderFax is the official free NCCER digital wallet** — it auto-fetches NCCER credentials, marks them verified vs. manually uploaded, sends expiration alerts, and shares by QR, email or text. Don't compete with free; consider integrating with BuilderFax instead, and get to them before someone else does.
- **COI / insurance-certificate tracking.** A large adjacent category with its own funded vendors (Certificial, Jones, Billy, CertFocus). Buyers will ask. Have an answer ready — "we track worker credentials, not company insurance" — and don't build it.
- **Training / LMS.** Not your product. A credential type is a name and an issuer; keep it that way.
- **Subcontractor hierarchy.** Real, but it inverts your buyer from the sub to the GC, and the GC tier is where ISN, Avetta, Veriforce/Highwire and HammerTech live. Revisit after 20 paying subs, not before.
- **Verifiable Credentials / Open Badges 3.0 issuance.** The standards are ratified (W3C VC 2.0 became a Recommendation in May 2025) but **no trades issuer signs with them.** Design your cert record so a signed credential can be *ingested* later. Don't invest in issuance.
- **Procore integration.** The one deferred item I'm least comfortable with, because "no integrations" is your most dangerous gap against myComply. But your first customers are 30–150-worker specialty subs in NW Ohio — Procore is the GC's tool, not theirs. The shareable compliance packet in recommendation 4 buys you most of the same value for a fraction of the work. Revisit when a real prospect names it as a blocker.

---

# Appendix — bugs and inconsistencies found while reviewing

Small, real, worth fixing while you're in the file anyway.

1. **`admin.js` contradicts itself on no-expiry certs.** `isCompliant()` is `expired === 0`, so a cert with a blank expiry date counts as *compliant* in the department table — while the CLEARED stat card counts the same cert *against* you. Pick one definition.
2. **`admin.js` overstates its own exports.** The header pill reads "Every table on this page exports to CSV." The department table has no export.
3. **The expiring/expired table shows only 10 rows** (`.slice(0, 10)`) with no "show all." The CSV export includes everything, so the data's there — the UI just quietly truncates.
4. **`/site/:id/log` has no `capability` argument** in `main.js`, so the `gate` role can deep-link straight to any site's scan log. That matches the intent documented in `schema.sql`'s role table, but it's unguarded in the router rather than deliberately allowed — worth a comment either way.
5. **`setSiteRequiredTypes` and `setSiteAssignments` are delete-then-insert with no transaction.** A partial failure leaves a site with *fewer* requirements than intended — which fails **open** for clearance. Wrap both in an RPC.
6. **Badge images and photos live in public buckets** while certificate PDFs are correctly private with 300-second signed URLs. `public_workers` publishes `badgeImageUrl`, so any badge image is readable by URL forever. Probably fine — but it's a decision, so document it.
7. **The verification attestation never reaches the gate.** `public_workers` omits `verified`, `verifiedBy`, `verifiedAt` and `cardNumber`, so the "someone actually checked this on the NCCER portal" signal — arguably your strongest trust artifact — appears only in the authenticated UI and the audit pack. Consider exposing a boolean `verified` on the view.
8. **The directory loads the entire worker table** and filters client-side with no pagination or virtualization. Fine at 50 workers, painful at 500 with certs embedded as jsonb — which is the top of your stated ICP band.
9. **`plan_tier` is free text with no CHECK constraint**, and the marketing caps (100/500) don't match the code examples (50/100).
10. **No uptime monitoring on `app.fieldcred.co`, and no Supabase PITR/backups.** For a product whose value proposition is "the records are always there," a monitoring check and a backup schedule are close to free and directly on-message.

---

# Suggested order of work

Given 5–10 hrs/week and a 3–5 paying customer target at day 90:

| Week | Do this | Hrs |
|---|---|---|
| This week | Fix `signup-config.php` (`notifyEmail` + a verified `resendFrom` domain) · photo on the verdict poster · appendix items 1, 2, 5 | ~5 |
| 2–3 | Stripe wiring + CSP + `admin.js` → `/api/portal-session` | ~6 |
| 3–5 | Tenant registry off the flat file — provisioning becomes hands-off | ~8 |
| 5–7 | Shareable compliance-packet link + `cert_changes` log (rec 4) | ~14 |
| 7–9 | Gate direction + ON SITE NOW + device/guard identity (rec 2) | ~12 |
| 9–11 | Blocked-scan alert + tiered expiry windows (rec 3) | ~14 |
| 11–13 | Spanish on the three worker-facing surfaces (rec 5) | ~10 |

Weeks 1–5 are the ones that decide whether you can take money at all. Everything after that is widening the wedge.
