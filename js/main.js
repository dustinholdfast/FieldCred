import { route, notFound, startRouter, navigate, getPath, redispatch } from './lib/router.js';
import { topNavHtml, attachTopNav } from './components/topNav.js';
import { renderDirectory } from './pages/directory.js';
import { renderProfile } from './pages/profile.js';
import { renderAdmin } from './pages/admin.js';
import { renderSites } from './pages/sites.js';
import { renderSiteDetail } from './pages/siteDetail.js';
import { renderSiteScanLog } from './pages/siteScanLog.js';
import { renderEditProfile } from './pages/editProfile.js';
import { renderPublicRecord } from './pages/publicRecord.js';
import { renderGateConfig } from './pages/gateConfig.js';
import { renderScan } from './pages/scan.js';
import { renderGateApp } from './pages/gateApp.js';
import { renderLogin } from './pages/login.js';
import { renderSignup } from './pages/signup.js';
import { renderResetPassword } from './pages/resetPassword.js';
import { getSession, onAuthStateChange, signOut } from './lib/auth.js';
import { initSupabase, isConfigured, tenantName } from './lib/supabaseClient.js';
import { installErrorReporting } from './lib/errorReporting.js';
import { syncQueuedScans } from './lib/offlineSync.js';
import { roleFromSession, roleCan } from './lib/roles.js';
import { showToast } from './components/toast.js';

installErrorReporting();

const app = document.getElementById('app');
let currentSession = null;

function teardown() {
  document.getElementById('modal-root').innerHTML = '';
}

function mountShell(active) {
  app.innerHTML = `
    <div class="app-shell">
      ${topNavHtml(active, { user: currentSession?.user, role: roleFromSession(currentSession), tenantName })}
      <div class="page-content" id="page-content"></div>
    </div>
  `;
  attachTopNav(app, {
    onSignOut: async () => {
      await signOut();
      navigate('/login');
    },
  });
  return document.getElementById('page-content');
}

function mountBare() {
  app.innerHTML = '';
  return app;
}

// The whole staff-facing app (directory, profiles, admin, edit) requires a
// signed-in session — it shows contact info and compliance data that the
// public share page deliberately hides. Only /r/:slug and /login are public.
// `capability` (optional) additionally gates the route by the user's role
// (js/lib/roles.js). A role that can't reach a page is bounced to the
// directory with a toast instead of landing on a screen whose every control
// is disabled. This is UX only — RLS is the real enforcement — but it keeps
// hidden nav links from becoming dead-ends if someone deep-links or a stale
// tab is reused after a role change.
function requireAuth(handler, capability = null) {
  return (params, query) => {
    if (!isConfigured || !currentSession) {
      const intended = getPath();
      teardown();
      const content = mountBare();
      renderLogin(content, {}, new URLSearchParams(intended === '/login' ? '' : `next=${encodeURIComponent(intended)}`));
      return;
    }
    if (capability && !roleCan(roleFromSession(currentSession), capability)) {
      showToast("Your role can't access that page.");
      navigate('/directory');
      return;
    }
    handler(params, query);
  };
}

route(
  '/directory',
  requireAuth((params, query) => {
    teardown();
    const content = mountShell('directory');
    renderDirectory(content, params, query);
  })
);

route(
  '/admin',
  requireAuth((params, query) => {
    teardown();
    const content = mountShell('admin');
    renderAdmin(content, query);
  }, 'viewAdmin')
);

route(
  '/sites',
  requireAuth(() => {
    teardown();
    const content = mountShell('sites');
    renderSites(content);
  }, 'viewSites')
);

route(
  '/site/:id',
  requireAuth((params) => {
    teardown();
    const content = mountShell('sites');
    renderSiteDetail(content, params);
  }, 'viewSites')
);

route(
  '/site/:id/log',
  requireAuth((params) => {
    teardown();
    const content = mountShell('sites');
    renderSiteScanLog(content, params);
  })
);

route(
  '/worker/new',
  requireAuth(() => {
    teardown();
    const content = mountShell(null);
    renderEditProfile(content, {});
  }, 'editWorkers')
);

route(
  '/worker/:id/edit',
  requireAuth((params) => {
    teardown();
    const content = mountShell(null);
    renderEditProfile(content, params);
  }, 'editWorkers')
);

route(
  '/worker/:id',
  requireAuth((params) => {
    teardown();
    const content = mountShell(null);
    renderProfile(content, params);
  })
);

route('/r/:slug', (params, query) => {
  teardown();
  const content = mountBare();
  renderPublicRecord(content, params, query);
});

// Public gate device-config — a site's QR points here to set which site this
// device checks against. No auth: it only reads public site data by slug.
route('/gate/:slug', (params) => {
  teardown();
  const content = mountBare();
  renderGateConfig(content, params);
});

// In-app camera scanner (js/pages/scan.js). Public for the same reason as the
// two routes above: a gate device is a shared kiosk nobody signs in to. This
// page shows no data of its own — it only routes to /r/:slug and /gate/:slug,
// which enforce their own visibility rules.
route('/scan', () => {
  teardown();
  const content = mountBare();
  renderScan(content);
});

// FieldCred Gate — the kiosk companion app (js/pages/gateApp.js). Public for
// the same reason as /scan, /r/:slug and /gate/:slug: a gate device is a
// shared tablet nobody signs in to. Guard mode reads only anon-safe endpoints
// (get_public_site, public_workers, search_site_roster, record_gate_scan).
//
// Its SUPERVISOR half does need a session — but it can't sit behind
// requireAuth(), because that would bounce the far more common guard-mode
// visitor to a login screen they have no credentials for. The page handles
// that boundary itself: entering supervisor mode hands off to /login and
// comes back via ?sup=1, and every supervisor read is RLS-gated regardless.
route('/gate-app', (params, query) => {
  teardown();
  const content = mountBare();
  renderGateApp(content, params, query);
});

route('/signup', () => {
  teardown();
  const content = mountBare();
  renderSignup(content);
});

// Reached via the PASSWORD_RECOVERY auth event (see init below), which
// navigates here once Supabase establishes a temporary recovery session from
// the emailed reset link. Public route — the recovery session is what gates it.
route('/reset-password', () => {
  teardown();
  const content = mountBare();
  renderResetPassword(content);
});

route('/login', (params, query) => {
  teardown();
  if (isConfigured && currentSession) {
    navigate(query.get('next') || '/directory');
    return;
  }
  const content = mountBare();
  renderLogin(content, params, query);
});

notFound(() => {
  teardown();
  app.innerHTML = `
    <div class="app-shell">
      ${topNavHtml(null, { user: currentSession?.user, role: roleFromSession(currentSession), tenantName })}
      <div class="page-content">
        <div class="empty-state">Page not found. <a href="#/directory">Back to directory</a></div>
      </div>
    </div>
  `;
  attachTopNav(app);
});

// Read BEFORE anything touches the URL — Supabase's client rewrites/clears
// this hash as part of processing it. Deciding "this is a recovery link"
// from the raw URL itself, captured before any of that happens, is the
// only thing here immune to how/when the SDK processes it.
//
// TWO link types land here, and both mean "this person has a session but no
// usable password yet":
//
//   type=recovery — the Forgot-password email (js/lib/auth.js).
//   type=invite   — the admin invite Supabase sends when provision-tenant.mjs
//                   creates a tenant. Missed until 2026-07-31: an invited
//                   admin landed signed in, was never shown the set-password
//                   screen, and had no password at all — so the moment they
//                   signed out they were locked out of a tenant they had just
//                   paid for, with no way back except another invite.
//
// A normal sign-in has no `type` in the hash and is unaffected.
const SET_PASSWORD_LINK_TYPES = new Set(['recovery', 'invite']);

function isPasswordRecoveryLink() {
  const hashParams = new URLSearchParams(location.hash.slice(1));
  return SET_PASSWORD_LINK_TYPES.has(hashParams.get('type'));
}

// True for the whole visit once a recovery link is detected, until
// resetPassword.js calls exitRecoveryMode() after an actual successful
// password update — NOT cleared by routing away on its own, since routing
// away without user action is exactly the bug this guards against.
let recoveryModeActive = false;
export function exitRecoveryMode() {
  recoveryModeActive = false;
}

async function init() {
  recoveryModeActive = isPasswordRecoveryLink();
  await initSupabase();
  if (isConfigured) {
    onAuthStateChange((session, event) => {
      currentSession = session;
      if (event === 'PASSWORD_RECOVERY') {
        recoveryModeActive = true;
      }
      if (recoveryModeActive) {
        navigate('/reset-password');
        return;
      }
      redispatch();
    });
    currentSession = await getSession();
  }
  startRouter();

  if (recoveryModeActive) {
    navigate('/reset-password');
    // Supabase's client clears the recovery params from the URL via
    // history.replaceState — which does NOT fire hashchange — on its own
    // async schedule, and (confirmed via debug trace in production,
    // 2026-07) fires only an INITIAL_SESSION event here, never
    // PASSWORD_RECOVERY. If any *other* auth event fires afterward (a
    // token refresh, e.g.), main.js's own redispatch() path reads the
    // now-cleared hash and routes to /directory instead. Poll for a few
    // seconds and re-assert /reset-password if anything knocks us off it;
    // recoveryModeActive only turns off via a real password update, so
    // this can't fight a legitimate navigation.
    const deadline = Date.now() + 5000;
    const interval = setInterval(() => {
      if (!recoveryModeActive || Date.now() > deadline) {
        clearInterval(interval);
        return;
      }
      if (getPath() !== '/reset-password') {
        navigate('/reset-password');
      }
    }, 150);
  }
}
init();

// App-shell offline support (sw.js) — best-effort, never blocks app startup.
// See sw.js for scope: same-origin static assets only, never Supabase calls.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// Drain any gate scans queued while offline (js/lib/offlineSync.js): once
// now, at app startup, and again whenever the browser regains a connection.
syncQueuedScans().catch(() => {});
window.addEventListener('online', () => {
  syncQueuedScans().catch(() => {});
});

// Expose for quick manual QA in the browser console.
window.__fieldcred = { navigate };
