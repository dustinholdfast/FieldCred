# FieldCred — Marketing Workspace Instructions

This folder is the marketing brain for FieldCred, a workforce credential compliance platform for contractors, staffing agencies, and safety managers. Owner: Dustin.

## Before any marketing work

Read these files first, in this order:

1. **brand-voice.md** — how FieldCred sounds. All copy must comply.
2. **audience-icp.md** — who we're talking to and what's on their mind.
3. **messaging-positioning.md** — what we say: value props, pillars, boilerplate.
4. **content-strategy.md** — channels, pillars, cadence, CTA.
5. **content-calendar.md** — what's shipped, what's planned. Check it to avoid repeating topics.

Also read **fieldcred-context-prompt.md** only if asked to regenerate the context files; otherwise ignore it.

## Hard rules

- **No implied endorsements.** Never state or imply that FieldCred is endorsed by, approved by, or affiliated with OSHA, any licensing board, or any certification issuer. FieldCred tracks and verifies records; it does not issue credentials.
- **No fear-selling.** Urgency = honest operational stakes (workers sent home, stalled mobilizations, audit scrambles), stated plainly, once. We are the calm alternative — see brand-voice.md.
- **No traction claims — nothing external is citable (confirmed 2026-07-18).** No customers, users, stats, testimonials, integrations, or credentials of any kind. Marketing describes the product and the problem, period. Feature claims limited to the shipped core loop: cert tracking, expiration alerts, QR gate verification.
- **No pricing content beyond "free early access during the pilot."** Pricing isn't set.
- **Pilot honesty.** FieldCred is pre-launch; never disguise it as an established product. Being new + free + working is the pitch.
- **Nothing publishes or sends without Dustin's explicit approval.** Draft, show him, wait. This includes posts, emails, and page updates.
- **Primary CTA is "join the pilot — free early access."** Every piece carries it (Dustin's confirmed pick, 2026-07-18).

## Workflow

1. Draft the requested piece grounded in the context files. Deliver it for Dustin's review.
2. On approval and shipping, update content-calendar.md (status, date, link) in the same session.
3. When Dustin corrects a draft's voice, facts, or positioning, offer to fold the correction into the relevant context file so it sticks.
4. Anything invented or inferred gets flagged `> Assumption:` — never silently guessed.

## What's confirmed vs. still assumed (interview run 2026-07-18)

**Confirmed by Dustin:** pre-launch stage; full core loop shipped and working end-to-end; free early access during pilot (pricing otherwise unset); primary CTA = join the pilot; voice direction as drafted; no existing copy to preserve; nothing external citable; target trigger moments = the gate/GC moment and the audit/incident moment.

**Landing page (2026-07-18):** pilot-landing-industrial.html is the chosen pilot page (Dustin picked industrial over the light variant; pilot-landing-light.html kept as reference only). Visual identity now documented in brand-voice.md — match it in all future visuals. **Hosting confirmed: https://pilot.fieldcred.co** (canonical/OG tags set). **Form backend: HubSpot** (switched from Web3Forms 2026-07-18). The page posts to the HubSpot Forms API — portal 246641133, na2 region, form GUID 69e497ad-f0c2-4789-87b1-f087d2b37721 — so submissions become CRM contacts. pilot@fieldcred.co confirmed as a real mailbox (used in the error fallback). **LIVE at https://pilot.fieldcred.co as of 2026-07-18** (verified rendering). **Form wiring still untested end-to-end:** submit one test entry on the live page and confirm it appears in HubSpot contacts — if the HubSpot form's field names don't match what the page sends (email, firstname, lastname, company, phone, field_workers, message), submissions will fail and the payload needs remapping.

**Domains:** marketing site fieldcred.co · app at app.fieldcred.co · pilot page at pilot.fieldcred.co.

**⚠ Unresolved conflict with the live site (found 2026-07-18):** fieldcred.co currently shows "Request a demo" and "Sign in" CTAs, a Pricing section, and the tagline "Know who's cleared before they clock in" — which conflicts with the pilot positioning in these files (join-the-pilot CTA, no pricing set, free early access). Also, the live site's look is clean/light with a dark nav, not the industrial identity chosen for the pilot page. Dustin needs to reconcile: either the main site updates to pilot-stage messaging, or these files need to reflect what the site claims. Do not draft content that leans on either side of the contradiction until resolved. The live tagline is good — candidate for adoption into messaging-positioning.md if Dustin wants to keep it.

**Still open:**
- Founder story — skipped in the interview; the biggest missing positioning asset. Ask when relevant.
- Buyer pattern (which persona converts) and lost-deal pattern — too early; validate against pilot signups and update audience-icp.md.
- Product specifics: default expiration-alert window, reporting/export features, onboarding time. Get real numbers before using any in copy.
- Channels and cadence — carried over from Holdfast as defaults; reshape around where pilot users actually come from.
