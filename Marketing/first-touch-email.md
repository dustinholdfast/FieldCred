# FieldCred — First Touch Cold Email

**For:** the 33 contacts in `fieldcred-hubspot-contacts.csv` with a verified email address.
**Written against:** `Marketing/brand-voice.md` and `Marketing/messaging-positioning.md`. No traction claims, no fear-selling, no pricing beyond "free during pilot," no implied OSHA affiliation.
**Drafted 2026-07-28. Nothing here has been sent.**

---

## Read this before you send anything

**The email template in `GTM-30-60-90.md` is dead — don't use it.** It opened with *"you're listed in ISNetworld as an electrical sub."* We established that ISN's contractor list isn't public, which means I can't verify that about anyone, which means that line is a guess presented as research. If a safety director checks and you're wrong, you're done. The versions below use a hook I can actually verify: **the association or union directory each company was genuinely listed in.** That's on every record in the `Lead Source Directory` column.

**The pilot page is live and the form goes to HubSpot — not to the PHP endpoint.** (Corrected 2026-07-29; an earlier version of this file said otherwise and was wrong.)

`pilot.fieldcred.co` POSTs straight to the HubSpot Forms API. `signup-config.php`, `signup-notify.php`, and Resend are not in this path at all.

- `data-portal-id="246641133"` — **verified.** Matches the connected HubSpot account, the same portal the target-list CSVs import into. Submissions land as contacts next to your imported list.
- `data-form-guid="69e497ad-f0c2-4789-87b1-f087d2b37721"` — well-formed, but unverified. HubSpot Forms read requires reauthorizing the connection.

**Two things left to confirm before you send:**
1. That form is **published** in HubSpot and its `field_workers` and `message` fields map to real properties. Submit one test through the live page and watch for the contact.
2. **`pilot@fieldcred.co` exists as a mailbox.** If the HubSpot POST fails, the page tells the prospect *"email us instead: pilot@fieldcred.co"* — that's your only fallback, and a bounce there is a lead lost twice.

*(Unrelated to outbound, but still true: `signup-config.php` has `notifyEmail => 'YOUR_EMAIL@example.com'`, which breaks the in-app "Request more capacity" button in `js/pages/admin.js`. That's an existing-tenant upgrade path, not a lead path.)*

The drafts below are ready — the pilot link goes in the P.S., not the main ask.

**Turn off HubSpot email tracking for touch #1.** Tracking pixels are a deliverability tax, and safety managers are often behind locked-down Outlook that flags them. You want this email to look like a person wrote it in Outlook, because a person did.

---

## Version A — Safety / EHS titled (3 contacts)

Andy Bovee (Murray Painting), Jeff King (VM Systems), James Brown (Fred Christen, safety@ inbox).

These are the highest-value sends on the list. Slow down and personalize the first line by hand.

**Subject line options — test two:**
- `catching a card before it lapses`
- `how do your guys prove they're current at the gate?`

---

Andy —

You run safety at Murray Painting, so you've already got a system for OSHA cards, fit tests, and whatever else your painters need to be site-ready. My question is about the gap between renewals — whether something reminds you a card is about to lapse, or whether that's you remembering.

I built FieldCred for that gap. It holds every worker's certifications, flags them weeks before they expire, and gives each worker a QR code a supervisor can scan at the gate to see whether that man is cleared to work. No logins for the crew. No callback to the office.

It's new. The tracking, the alerts, and the gate scan all work end to end today — I'd rather show you a live scan than send you slides. Early access is free while we're in pilot.

Worth fifteen minutes? Send me two times that work and I'll take either.

Dustin
FieldCred

P.S. If you'd rather look before you talk — pilot.fieldcred.co. Same information, no meeting.

---

## Version B — Owner / President / VP (15 contacts)

Kurt Deal (×2), Ben Reinhart, William Darish, Tom Behmlander, Rick Sparks, Shane Brawt, Michael Doran, Joel McGrath, Brian Klatt (×2), Griffin Williams, and the three Branch Managers (Bill Drummond, Tom O'Connell, Mike Luczkowski).

**Subject line options — test two:**
- `cert tracking before the GC asks`
- `question about your crew's cards`

---

Kurt —

Found Positive Trades Group on the UA Local 50 contractor list. Mechanical and industrial work means your guys carry a stack of cards — OSHA 10 or 30, site orientations, whatever each plant requires before it lets anyone through the gate.

Most shops your size track that in a spreadsheet. It holds up right until it doesn't: a man shows up Monday, his card lapsed three weeks ago, nobody caught it, and now he's going home and you're short-handed.

FieldCred tracks every worker's certifications, flags expirations weeks ahead, and lets a supervisor scan a worker's QR code at the gate to see whether he's cleared. The office loads the roster. The field just scans. No worker logins.

It's new, it works, and early access is free while we're in pilot. Fifteen minutes and I'll show you a live scan on my phone.

Reply with a couple of times and I'll work around yours.

Dustin
FieldCred

P.S. If you'd rather size it up first, it's all on pilot.fieldcred.co.

**Swap the first line per record** using the `Lead Source Directory` column — "the AGC of Northwest Ohio contractor list," "the MCA of Northwest Ohio signatory list," "the Michigan MCA member directory," "the SMCNECA member list." Swap "Mechanical and industrial work" for their actual trade.

---

## Version C — No title on file (15 contacts)

Benjamin Rosenberg, James Hall, Ron Sheahan, Zach Donley, Kristine Menzing, Sam Ellison, Jeffrey Howard, Lynne Vlk, Emily Hendershot, Chad Christensen, Chad Miller, Mark Katz, Bruce Wenzlick, Jeremy Cook, Rich Cramer.

These came from association directories that print a name but no role, so you're writing blind. Lead with the routing question — it gets replies even when you've got the wrong person, and a name handed to you by someone inside the company is worth more than the email you were going to send.

**Subject line options — test two:**
- `who handles cert tracking at Dee Cramer?`
- `quick question on crew certifications`

---

Rich —

Found Dee Cramer on the SMACNA Metro Detroit list. Short question: who over there keeps track of whether a field guy's OSHA card or site orientation is still current?

If that's you — here's why I'm asking. I built FieldCred. It holds every worker's certifications, flags them before they expire, and lets a supervisor scan a QR code at the gate to see whether that man is cleared to work. No logins for the crew, no phone call back to the office.

If it's someone else, a name would help and I'll leave you alone.

It's new and it's free while we're in pilot. Fifteen minutes and I'll show you a live scan.

Dustin
FieldCred

P.S. pilot.fieldcred.co if you want to see it before you point me at anyone.

---

## Signature — use this on all three

You're sending commercial email to people who didn't ask for it. CAN-SPAM requires a real physical mailing address and a working opt-out. This is not optional, and you of all people shouldn't be sloppy about a compliance requirement.

```
Dustin [Last Name]
Founder, FieldCred
[phone] · dustin@fieldcred.co
pilot.fieldcred.co

FieldCred, [street address], [city] OH [zip]
Don't want to hear from me again? Reply "stop" and I'll take you off the list.
```

Use a `@fieldcred.co` address, not the Jinni one. Sending a construction-software pitch from a travel-agency domain reads as a mistake.

---

## Attachments: send none. Here's what to build instead.

You asked what I'd attach. **Nothing.** Three reasons:

1. **Deliverability.** Attachments from an unknown sender on a young domain are one of the fastest ways into a spam folder. Industrial companies run conservative Outlook filtering. You'd be trading a 30-40% open rate for a 10% one.
2. **Commitment mismatch.** A 100-word email asking for 15 minutes shouldn't arrive with homework attached.
3. **You have nothing to put in it.** No customers, no case study, no stats. A one-pager built from feature bullets is worse than no one-pager.

**Build these three instead — they're for the *reply*, not the send.**

**1. A 60–90 second screen recording of a real gate scan. Build this first.** This is the single highest-value asset you could make this week, and you can make it today off the `demo` tenant. Show it in this order: a worker profile with a cert expiring in 30 days → the admin dashboard flagging it → a phone scanning the QR at a gate → the full-screen CLEARED verdict → then scan an expired worker and show NOT CLEARED. No voiceover needed. Host it unlisted on YouTube or Loom and paste the link when someone replies "send me something."

Your own brand voice guide says it: *"Show, don't adjective. Screenshots and the QR scan itself beat paragraphs."* A video of the thing working answers the "you're brand new, why should I trust you" objection better than any PDF can.

**2. A one-page PDF — built, but held in reserve.** Some people will ask for something they can forward to their owner. Have it ready. One page, the industrial visual identity from `pilot-landing-industrial.html` (charcoal, safety yellow, hazard stripe). Contents: what it does in three lines, four product screenshots, the pilot terms in plain English (free, 30 days, stated end date, no obligation), your contact info. No stats. No logos. No testimonials. Attach it on the *reply*, where it's expected and won't hurt deliverability.

**3. Link your help center.** `help-center/` has 20 real articles and it's already deployed. It's the most credible thing you own — it's evidence a real product exists with real documentation, which is exactly what a skeptical safety manager wants to see. Drop the link in the follow-up: *"if you want to poke around before we talk, the docs are here."*

---

## Send mechanics

**Don't blast 33 at once from a cold domain.** That's a spam-trap pattern. Send 8–10 a day over four days.

**Before the first send, confirm SPF, DKIM, and DMARC are configured on fieldcred.co.** If they aren't, 33 cold emails will damage the domain you're about to run the whole business on. Ten minutes with your DNS host.

**Timing:** Tuesday–Thursday, 6:30–7:30 a.m. Eastern. These people are up before their crews and clearing email before the first site visit. Avoid Monday morning and anything after 3 p.m.

**Plain text. No HTML template, no logo, no images.** It should look like you typed it.

**Three touches, then stop.** Touch 1 as above. Touch 2 at day 5 — two lines, "did this reach the right person?" Touch 3 at day 12 — one line, offer to close the loop. Then mark them `No response — closed` and move on. Chasing past three touches costs you hours you don't have.

**Log every send in HubSpot** so the Touch # and Outreach Status columns stay honest. If you're eyeballing who you've contacted, you'll double-send inside two weeks.

---

## Two records to fix before you send

**Kurt Deal appears twice** — `kurt.deal@positivetradesgroup.com` and `kurt.deal@thesperlingcompany.com`. Both verified on their own company sites. Same person at two companies, or two different people. If it's one person, sending him two near-identical cold emails on the same morning is the worst possible first impression. Check first.

**Brian Klatt appears twice** on the same address (`Brian.Klatt@rlgbuilds.com`) for GEM, Inc. and GEM Industrial. Same person, same Rudolph Libbe company. Send once.

That takes 33 sends down to **31 people**.
