import { escapeHtml, initials } from '../lib/format.js';

// Deterministic tint from a name, so the same worker always gets the same
// color across the app. Fixed saturation/lightness keeps every tint calm and
// keeps the text/background pair legible (WCAG-safe contrast for dark text on
// its own light tint).
function tintFor(name) {
  let hash = 0;
  const s = String(name);
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return { bg: `hsl(${hue} 44% 90%)`, fg: `hsl(${hue} 48% 30%)` };
}

// Renders the worker's photo if present, otherwise their initials on a
// deterministic tint — replaces the diagonal-stripe placeholder, which read as
// an unfinished wireframe. The initials are an inline SVG with a viewBox, so
// they scale to whatever size the container (className/style) sets without the
// caller needing to pass a font size.
export function avatarHtml(name, photoUrl, { className = 'photo-placeholder', style = '' } = {}) {
  if (photoUrl) {
    return `<div class="${className}" style="${style}"><img src="${escapeHtml(photoUrl)}" alt=""></div>`;
  }
  const { bg, fg } = tintFor(name || '');
  const text = initials(name || '') || '—';
  return `<div class="${className}" style="${style}">
    <svg class="avatar-initials" viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="100" height="100" fill="${bg}"></rect>
      <text x="50" y="52" text-anchor="middle" dominant-baseline="central" font-family="'IBM Plex Sans', system-ui, sans-serif" font-weight="600" font-size="40" fill="${fg}">${escapeHtml(text)}</text>
    </svg>
  </div>`;
}
