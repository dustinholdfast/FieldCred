# FieldCred — Messaging & Positioning

**What this file is:** The positioning statement, value propositions, differentiators, and ready-to-use language for FieldCred. Every headline, pitch, and post should trace back to something here.

**The brand in one line:** FieldCred keeps crews cleared to work — cert tracking, expiration alerts, and QR gate verification — built for the field, in a market of office-bound HR software and abandoned spreadsheets.

**Stage note (confirmed 2026-07-18):** Pre-launch. Full core loop shipped and working end-to-end. Free early access during the pilot; pricing not set — no pricing language beyond "free early access." Nothing external citable: no customers, stats, testimonials, integrations, or credentials. Primary CTA everywhere: **join the pilot**.

---

## Positioning statement

For contractors, staffing agencies, and safety managers who have to prove every worker on site is certified, **FieldCred** is the credential compliance platform that tracks certs, flags expirations before they bite, and lets a supervisor verify anyone at the gate with a QR scan — no logins, no office callbacks, no spreadsheet.

---

## Core value propositions

**1. Know before it bites.**
Every OSHA card, license, and operator permit in one place, with expirations flagged ahead of time — so renewals happen on the calendar, not at the gate.
*Proof:* The expiration-alert engine is shipped and working; nothing lapses silently.

> Assumption: The default alert window (e.g., 60/30 days out) is unconfirmed — get the real number from Dustin before using one in copy.

**2. Verified at the gate in seconds.**
A supervisor scans a worker's QR code and sees current status instantly. No logins, no calls to the office, no binder in the truck.
*Proof:* The QR verification flow is shipped and working — demo it, don't describe it.

**3. Audit-ready without the scramble.**
When the GC, the client, or an inspector asks for training records, the answer comes from the platform, not a week of archaeology.
*Proof:* All credentials live in one tracked place per worker and roster.

> Assumption: Specific reporting/export features are unconfirmed — verify what exists before promising "exportable reports" in copy.

**4. Built for the field, free to try.**
Workers don't need accounts or an app rollout. The office loads the roster; the field just scans. And during the pilot, early access is free — bring a real crew roster and see if it holds up.
*Proof:* No-worker-login design is shipped; the pilot offer removes the cost objection entirely.

---

## Differentiators vs. the real alternatives

**vs. the spreadsheet:** The spreadsheet doesn't warn anyone, doesn't stand at the gate, and lives in one person's head. It works right up until the day it publicly doesn't.

**vs. HR/EHS suites:** They store documents in the office. FieldCred answers the field question — *is this worker cleared, right now, at this gate* — which document storage was never built to do. Position alongside HR systems, not against them.

**vs. doing nothing:** The stake isn't abstract compliance; it's a worker sent home mid-mobilization, a crew short-handed, a client questioning every person you send. One gate incident costs more than tracking ever will.

> Note: Dustin confirmed it's too early to know who FieldCred actually loses to. These three are the hypothesized alternatives; update when real lost-deal patterns emerge.

---

## Messaging pillars

**Pillar 1 — "Cleared to work." (the gate moment)**
- "The GC wants every cert before Monday. Here's how that stops being a fire drill."
- "Your best worker's card expired three weeks ago. Nobody knew. That's the whole problem."
- "Scan. See. Wave through."

**Pillar 2 — "Nothing lapses silently." (expiration tracking)**
- "Certs don't fail at renewal time. They fail quietly, months earlier, in a spreadsheet nobody opened."
- "FieldCred flags every expiration ahead of time — renewals become scheduling, not emergencies."

**Pillar 3 — "The field doesn't do logins." (built for the jobsite)**
- "No worker accounts. No app rollout. No password resets at the gate. A QR code and a phone."
- "If your compliance system needs a callback to the office, it's an office system."

**Pillar 4 — "Audit-ready is an answer, not a scramble." (proof on demand)**
- "OSHA asks for training records after an incident. You want that answer to take minutes, not a week."
- "Every cert, every worker, every site — in one place before the meeting ends."

---

## Objection handling — top 5

1. **"The spreadsheet works fine."** — Until the keeper is on vacation or the audit lands. The spreadsheet stores; it doesn't warn, and it isn't at the gate. Ask when it was last fully verified against actual cards.
2. **"You're brand new."** — True, and the pilot is priced accordingly: free. The core product — tracking, alerts, QR gate verification — works end-to-end today. Early users get it free and shape where it goes. No lock-in, no bill, just a real test with a real roster.
3. **"My guys won't use an app."** — They don't have to. Workers carry a QR code; supervisors scan it. Zero worker logins, zero training rollout for the crew.
4. **"HR already stores the certs."** — Storage isn't verification. HR answers "do we have a copy"; FieldCred answers "is this worker cleared, right now, at this gate."
5. **"We just survived a software rollout."** — Fair. This one is roster-in, QR-out. The field crew's workflow changes by exactly one scan.

---

## Boilerplate

**Elevator pitch (~30 words):**
FieldCred keeps crews cleared to work. It tracks every worker's certifications, flags expirations before they bite, and lets supervisors verify anyone at the gate with a QR scan — no logins, no callbacks.

**Short boilerplate (~75 words):**
FieldCred is a workforce credential compliance platform for contractors, staffing agencies, and safety managers. It tracks worker certifications — OSHA cards, licenses, operator permits — flags expirations before they cause a problem, and lets supervisors verify who's cleared at the gate with a QR scan, no logins or office callbacks required. Built for the field: the office loads the roster, the gate just scans, and audits become an answer instead of a scramble. Now in pilot — early access is free.

**Long boilerplate (~150 words):**
FieldCred is a workforce credential compliance platform built for the people who have to prove every worker on site is certified. Contractors, staffing agencies, and safety managers run on certifications — OSHA cards, trade licenses, operator permits, site orientations — and most track them with a spreadsheet, a binder, and one person's memory. That system fails in public: a worker bounced at the gate, a mobilization stalled, an auditor waiting on records nobody can find. FieldCred replaces it. Every credential lives in one place with expirations flagged ahead of time, so renewals happen on the calendar instead of at the gate. Supervisors verify any worker in seconds with a QR scan — no worker logins, no callbacks to the office. And when a GC, client, or inspector asks for proof, the answer comes from the platform, not a week of digging. FieldCred is in pilot now, and early access is free.

---

## Pricing (confirmed 2026-07-22 — not yet public, Stripe not live)

Flat monthly tiers gated on worker count (enforced server-side via `plan_limits.max_workers`, not per-seat billing — deliberate, since staffing-agency turnover makes per-seat billing painful for exactly the persona most likely to buy the top tier):

- **Starter** — up to 100 workers — **$99/month**. Targets the owner/ops-manager persona replacing a spreadsheet. Core loop only: cert tracking, expiration alerts, QR gate verification.
- **Growth** — up to 500 workers — **$349/month**. Targets the safety manager/HSE lead persona (the "most natural FieldCred user" per audience-icp.md). Same core loop plus reporting/audit-trail depth — confirm exactly which reporting features are shipped before this goes in customer-facing copy.
- **Enterprise** — uncapped workers — **custom/contact us**. Targets staffing agencies at volume; not self-serve in Stripe Checkout, handled manually until there's real deal data to anchor a list price.

Still free during the pilot — these prices take effect once Stripe billing goes live, not before. Do not use these numbers in any pilot-facing copy until then.

> Assumption: Starter/Growth dollar amounts are Dustin's initial call, not market-tested. Revisit after the first few paying signups.

## Open gaps (post-interview, 2026-07-18)

- **Founder story:** Skipped in the interview — still the biggest missing positioning asset. Capture why Dustin built FieldCred when he's ready.
- **Buyer pattern:** Too early to tell which persona converts. Revisit after pilot signups accumulate.
- **Alert window default and reporting/export specifics:** Unconfirmed product details — get exact numbers/features before using them in copy.
- **Pricing:** ~~Only "free early access during the pilot" is citable.~~ Resolved 2026-07-22 — see "Pricing" section above. Still gated on Stripe going live.
- **Channels:** Attention/channel section in audience-icp.md is inference; the first real data is where pilot users come from.
