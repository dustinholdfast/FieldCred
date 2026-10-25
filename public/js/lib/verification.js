import { safeExternalUrl, formatDateTime } from './format.js';

// Third-party verification sources — see CHANGES.md "Structured cert
// verification" entry for the full story. Neither NCCER nor OSHA offers a
// public API for a third party like FieldCred to check a card
// programmatically (confirmed by research, not assumption, before writing
// this): NCCER's Online Verification is a login-gated lookup-by-card-number
// tool on their own site, and OSHA 10/30 verification is fragmented across
// whichever Authorized Training Organization issued the card — there's no
// single OSHA-run verification service. So this is NOT an API integration.
// It's a structured attestation model: FieldCred points staff at the real,
// authoritative portal and records who confirmed the card there and when,
// replacing the old "type any URL you want" free-text field.
//
// portalUrl is each source's own general verification entry point (not a
// deep link to a specific card — neither site supports that from an
// unauthenticated outside link). The card/cert number staff enter alongside
// it is what they type into that portal by hand to check it.
export const VERIFICATION_SOURCES = {
  NCCER: {
    label: 'NCCER',
    portalUrl: 'https://registry.nccer.org/',
    portalLabel: 'NCCER Registry',
  },
  OSHA: {
    label: 'OSHA',
    // Aggregator covering many (not all) Authorized Training Organizations'
    // cards. If a card's specific issuer has its own portal, that's a better
    // check than this — OSHA has no single central verification service.
    portalUrl: 'https://www.oshacardportal.com/portalapp/verify/',
    portalLabel: 'OSHA Card Portal',
  },
};

// Resolves the outbound "Verify" link for a cert. NCCER/OSHA get their fixed
// canonical portal (source of truth, not a free-text field an admin could
// point anywhere). Anything else falls back to the legacy free-text
// verificationUrl field — this keeps every cert saved before this feature
// shipped working exactly as it did (source is undefined on old records, so
// it lands in this branch), and still covers state boards / other issuers
// that don't have a hardcoded entry here.
//
export function verificationLink(cert) {
  const source = cert.verificationSource;
  if (source && VERIFICATION_SOURCES[source]) {
    const s = VERIFICATION_SOURCES[source];
    return { url: s.portalUrl, label: `Verify on ${s.portalLabel}` };
  }
  const url = safeExternalUrl(cert.verificationUrl);
  return url ? { url, label: 'Verify' } : null;
}

// Plain-text form of the "Verified" attestation — js/components/certCard.js
// has the styled in-app badge version (verifiedBadgeHtml); this is for
// contexts that render into a bare document with their own inline styles,
// like the audit pack print window (js/lib/auditPack.js), where the app's
// pill/badge CSS isn't loaded. Never inferred from just having a link on
// file — cert.verified is a deliberate admin action (see js/lib/state.js
// emptyCert()). Returns null when not verified.
export function verificationStampText(cert) {
  if (!cert.verified) return null;
  const who = cert.verifiedBy ? ` by ${cert.verifiedBy}` : '';
  const when = cert.verifiedAt ? ` on ${formatDateTime(cert.verifiedAt)}` : '';
  return `Verified${who}${when}`;
}
