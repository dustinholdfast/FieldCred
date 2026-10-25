import { icons } from '../lib/icons.js';
import { escapeHtml } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { shieldLogo } from './logo.js';
import { roleCan, roleLabel } from '../lib/roles.js';

// `cap` is the capability from js/lib/roles.js that gates the link — a gate
// user, for instance, only has viewDirectory, so Sites/Admin drop out.
const NAV_LINKS = [
  { key: 'directory', label: 'Directory', href: '/directory', cap: 'viewDirectory' },
  { key: 'sites', label: 'Sites', href: '/sites', cap: 'viewSites' },
  { key: 'admin', label: 'Admin', href: '/admin', cap: 'viewAdmin' },
];

// active: 'directory' | 'admin' | null (null hides nav highlighting, e.g. on a profile/edit page)
// user: the signed-in Supabase user (or null) — shows their email + a sign-out control when present.
// role: 'admin' | 'safety' | 'gate' — filters which nav links show (RLS is the real gate; this is UX).
// tenantName: which client/database this session is connected to — shown next to the wordmark
// so it's never ambiguous which tenant you're viewing/editing (multiple Supabase projects now).
export function topNavHtml(active, { query = '', user = null, role = 'admin', tenantName = null } = {}) {
  const links = NAV_LINKS.filter((l) => roleCan(role, l.cap))
    .map((l) => `<a href="#${l.href}" class="${l.key === active ? 'active' : ''}">${l.label}</a>`)
    .join('');

  // Non-admin roles see a small badge so it's obvious the reduced UI is
  // intentional (their role), not a bug. Admin — the default/legacy state —
  // shows nothing, to keep the existing look unchanged for everyone today.
  const roleBadge = role && role !== 'admin'
    ? `<div class="topnav-role" title="Your role: ${escapeHtml(roleLabel(role))}">${escapeHtml(roleLabel(role))}</div>`
    : '';

  return `
    <div class="topnav">
      <div class="topnav-left">
        <div class="brand-mark" data-nav="/directory">
          ${shieldLogo()}
          <span class="wordmark">FIELDCRED</span>
        </div>
        ${tenantName ? `<div class="topnav-tenant" title="${escapeHtml(tenantName)} — connected database">${escapeHtml(tenantName)}</div>` : ''}
        ${roleBadge}
        <nav class="topnav-nav">${links}</nav>
      </div>
      <div class="topnav-right">
        <div class="topnav-search">
          ${icons.search.replace('class="icon"', 'class="icon icon-sm"')}
          <input type="text" id="topnav-search-input" placeholder="Search workers, certs…" value="${escapeHtml(query)}" autocomplete="off">
        </div>
        ${
          user
            ? `<div class="topnav-user">
                 <span class="mono topnav-user-email" title="${escapeHtml(user.email || '')}">${escapeHtml(user.email || '')}</span>
                 <button class="topnav-signout" id="topnav-signout">Sign out</button>
               </div>`
            : ''
        }
        <div class="avatar" title="${escapeHtml(user?.email || '')}">${escapeHtml((user?.email || '?').trim()[0]?.toUpperCase() || '?')}</div>
      </div>
    </div>
  `;
}

export function attachTopNav(container, { onSignOut } = {}) {
  const brand = container.querySelector('[data-nav]');
  if (brand) brand.addEventListener('click', () => navigate(brand.dataset.nav));

  const search = container.querySelector('#topnav-search-input');
  if (search) {
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = search.value.trim();
        navigate(`/directory${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      }
    });
  }

  const signOutBtn = container.querySelector('#topnav-signout');
  if (signOutBtn && onSignOut) signOutBtn.addEventListener('click', onSignOut);
}
