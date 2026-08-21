# FieldCred → HubSpot import

Two files, exported from Airtable `Target List — Industrial Subs` on 2026-07-28.

| File | Object | Rows |
|---|---|---|
| `fieldcred-hubspot-companies.csv` | Companies | 200 |
| `fieldcred-hubspot-contacts.csv` | Contacts | 105 |

---

## Import them together, not separately

In HubSpot: **CRM → Contacts → Import → Start an import → File from computer → Multiple files with associations → Contacts + Companies.**

Upload the contacts file first, then the companies file. When HubSpot asks which column links them, choose **Company domain name** — it's present in both files and it's HubSpot's native association key. (`Company name` is also in both as a fallback, but domain is more reliable.)

If you import them as two separate one-object imports, the contacts land unassociated and you'll be linking 105 records by hand.

---

## Custom properties you need to create first

HubSpot will not import these unless the property already exists. Create them under **Settings → Properties** before you start, or just skip-map them during import.

**Company properties**

| Property | Type | Notes |
|---|---|---|
| FieldCred Tier | Dropdown | `A — Industrial/turnaround`, `B — Commercial/industrial trade`, `C — Verify fit` |
| FieldCred Trade Category | Dropdown | 20 values — easier to create as single-line text and clean up later |
| Trade (as listed) | Single-line text | Raw trade string from the source directory |
| FieldCred Fit Score | Number | 55–101. Higher = better ICP match |
| Union Signatory | Dropdown | Yes / No |
| Est Field Workers | Number | **Empty on every row** — not published anywhere public. Fill from discovery calls. |
| Prequal Network | Multi-checkbox | **Empty on every row.** ISN/Avetta/Veriforce lists are behind login. Ask on the call. |
| General Company Email | Single-line text | Use HubSpot's *text* type, not email — this is a shared inbox, not a person |
| Lead Source Directory | Single-line text | Which association/union directory the company came from |
| Lead Source URL | Single-line text | The exact page |
| FieldCred Notes | Multi-line text | Verification notes, entity flags, why enrichment failed. **Read these before calling.** |

**Contact properties**

| Property | Type | Notes |
|---|---|---|
| Email Verified | Dropdown | `Yes - published on company site` / `NO - phone only` |
| Contact Source URL | Single-line text | The page the name/title came from. Blank = unverified. |
| FieldCred Tier | Dropdown | Same values as the company property |
| FieldCred Trade Category | Single-line text | |

Everything else maps to HubSpot defaults: Company name, Company domain name, Website URL, Phone number, City, State/Region, Country/Region, First name, Last name, Email, Job title, Lifecycle stage, Lead status.

---

## Things to know before you click import

**Only 33 of 105 contacts have an email address.** The other 72 are name + title + company main line. That's deliberate — no email was ever guessed or constructed from a name pattern. The `Email Verified` column tells you which is which. Contacts without email import fine; they just can't be deduped or emailed, so treat them as call targets.

**Lifecycle stage is set to `Lead` and Lead status to `New` on every contact.** Change or drop those columns if your pipeline uses different values.

**31 of 200 companies have no domain.** HubSpot can't dedupe those, and their contacts will associate by company name instead. They're mostly CAM Buyers Guide stubs and firms with no website at all.

**Three domains are shared across seven company rows — HubSpot will merge them, which is correct:**
- `smartenergyinsulation.com` (3 rows) — Lake State Insulation, Toledo Mechanical Insulation, and Michigan Mechanical Abatement are all one Farmington Hills parent
- `gemincorporated.com` (2 rows) — GEM, Inc. (Walbridge OH) and GEM Industrial are the same Rudolph Libbe company
- `bondy-insulation.com` (2 rows) — R.L. Bondy and R L Bondy Insulation LLC

Let the merge happen. It resolves duplicates you'd otherwise chase manually.

**One duplicate contact email:** `Brian.Klatt@rlgbuilds.com` appears twice (GEM, Inc. and GEM Industrial). HubSpot will collapse it into one contact — also correct.

**Kurt Deal appears twice with two different emails** (`positivetradesgroup.com` and `thesperlingcompany.com`). Two separate records, both verified on their own sites. Could be the same person at two companies or two different people — worth 30 seconds to check before you send anything.

---

## Where to start once it's in

Filter contacts to `Job title contains "Safety"` → **18 records.** These are named safety directors and EHS managers, the exact buyer `audience-icp.md` describes. Eight are within 30 minutes of Toledo. Two have direct emails printed (Andy Bovee at Murray Painting, Jeff King at VM Systems); the rest are phone.

Then filter companies to `FieldCred Tier = A` → 97 industrial/turnaround contractors, the sharpest ICP fit.

---

## Data provenance

Every company came from a real, publicly fetchable directory page — AGC of NW Ohio, UA Local 50, MCA NW Ohio, Michigan MCA, SMCNECA, MI NECA, SMACNA, ABC SE Michigan, the W. Soule approved-subcontractor list, and the Western Lake Erie Insulation contractor list. Every contact came from the company's own website or a legitimate association directory, with the source page recorded.

Nothing in these files was invented. Directory aggregators (ZoomInfo, RocketReach, Buzzfile, Manta, D&B) were excluded as unreliable. Two source PDFs are older — W. Soule is 2019, ABC SE Michigan is 2022 — so verify phone numbers on those before dialing; the `FieldCred Notes` column flags them.
