// Compact brand mark for tight inline spots (the 24px top-nav slot) — the
// real logo (assets/logo.png) is a detailed square composition that turns
// to mush at that size, so this simplified shield+check stands in for it
// wherever space is that constrained.
//
// size classes: '' (24px, desktop nav) | 'sm' (22px, profile nav) | 'xs' (16px, mobile)
export function shieldLogo(sizeClass = '') {
  const cls = sizeClass ? `shield ${sizeClass}` : 'shield';
  return `
    <svg class="${cls}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 0 L24 4.32 L24 13.92 L12 24 L0 13.92 L0 4.32 Z" fill="var(--brand)"/>
      <path d="M7.3 12.6 L10.3 15.6 L16.9 8.4" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>
  `;
}

// The real FieldCred logo — shield, worker silhouette, QR accent, wordmark,
// and tagline all composed into one square image. Used wherever there's
// room to show it properly (login page, public share page); the wordmark
// and tagline are already baked in, so nothing else needs to render
// alongside it.
export function logoImage({ width = 180 } = {}) {
  // logo-360.png: a 360px-wide downscale of the 1254px source (~118 KB vs
  // ~980 KB). Shown at most 160px wide, so 360 still covers 2x displays while
  // cutting the transfer ~88% — matters most on the public record page, which
  // gets opened at a gate on a phone over cellular. width/height are set so the
  // browser reserves space before it loads (no layout shift).
  return `<img src="./assets/logo-360.png" width="360" height="360" alt="FieldCred — Verify. Comply. Get to work." class="brand-logo-img" style="width:${width}px;height:auto;">`;
}
