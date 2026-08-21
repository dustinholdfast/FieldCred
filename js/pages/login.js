import { signIn, requestPasswordReset } from '../lib/auth.js';
import { navigate } from '../lib/router.js';
import { isConfigured, tenantSlug, tenantName, usedFallback } from '../lib/supabaseClient.js';
import { setTenantOverride } from '../lib/tenant.js';
import { escapeHtml } from '../lib/format.js';
import { logoImage } from '../components/logo.js';

const PENDING_EMAIL_KEY = 'fieldcred:pending-email';

// Switches to a different tenant by persisting the override and doing a
// full reload — the Supabase client is tied to one project, so there's no
// clean way to hot-swap it mid-session; a fresh load re-runs initSupabase()
// against the new tenant instead.
function reloadIntoTenant(slug, pendingEmail) {
  if (pendingEmail) {
    try {
      sessionStorage.setItem(PENDING_EMAIL_KEY, pendingEmail);
    } catch {
      // sessionStorage unavailable — they'll just retype their email, no big deal
    }
  }
  setTenantOverride(slug);
  const url = new URL(location.href);
  url.searchParams.set('tenant', slug);
  location.href = url.toString();
}

// Resolves a tenant from an email's domain (tenants.php's `domains` list).
// Returns null on no match / bad input / lookup failure — all treated the
// same by the caller: just proceed with sign-in against the current tenant.
async function lookupTenantByEmail(email) {
  try {
    const res = await fetch(`./tenant-lookup-by-domain.php?email=${encodeURIComponent(email)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function renderLogin(container, params, query) {
  const next = query.get('next') || '/directory';
  const fallbackWarning =
    usedFallback && tenantSlug && tenantSlug !== 'default'
      ? `<div class="auth-error show">Couldn't find a company called "${escapeHtml(tenantSlug)}" — showing ${escapeHtml(tenantName || 'the default instance')} instead.</div>`
      : '';

  if (!isConfigured) {
    container.innerHTML = `
      <div class="auth-page">
        <div class="auth-card">
          <div class="auth-brand">${logoImage({ width: 160 })}</div>
          <div class="auth-title">Backend not configured</div>
          <div class="auth-sub">Tenant "${escapeHtml(tenantSlug || '')}" wasn't found in the tenant registry, and no fallback is set in <code>js/lib/config.js</code>. Check <code>tenants.php</code>, or run <code>supabase/schema.sql</code> for a single-tenant setup and fill in <code>config.js</code>, then reload. To test a specific tenant directly, visit this page with <code>?tenant=slug</code> in the URL.</div>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-brand">${logoImage({ width: 160 })}</div>
        <div class="auth-title">Sign in</div>
        <div class="auth-sub">Workforce credential platform — staff access only</div>
        ${fallbackWarning}
        ${tenantName ? `<div class="mono" style="text-align:center;font-size:11px;color:var(--text-muted);margin:-10px 0 18px;">Connecting to <strong style="color:var(--text-secondary-2);">${escapeHtml(tenantName)}</strong></div>` : ''}
        <div class="auth-error" id="auth-error"></div>
        <form id="login-form">
          <div class="auth-field field">
            <label class="field-label">EMAIL</label>
            <input type="email" id="login-email" autocomplete="username" required>
          </div>
          <div class="auth-field field">
            <label class="field-label">PASSWORD</label>
            <input type="password" id="login-password" autocomplete="current-password" required>
          </div>
          <button type="submit" class="btn btn-primary btn-block" id="login-submit">Sign in</button>
        </form>
        <div style="text-align:center;margin-top:14px;">
          <a id="forgot-password" style="font-size:12.5px;">Forgot password?</a>
        </div>
        <div style="text-align:center;margin-top:10px;">
          <a href="https://fieldcred.co/#demo" style="font-size:12.5px;">New here? Request access</a>
        </div>
      </div>
    </div>
  `;

  const form = container.querySelector('#login-form');
  const errorBox = container.querySelector('#auth-error');
  const submitBtn = container.querySelector('#login-submit');
  const emailInput = container.querySelector('#login-email');
  const passwordInput = container.querySelector('#login-password');
  const forgotLink = container.querySelector('#forgot-password');

  // The message box doubles as error (red, default) and confirmation (green).
  // Always route through these so the success styling can't leak into a later
  // error message (or vice-versa).
  function showError(message) {
    errorBox.style.color = '';
    errorBox.style.background = '';
    errorBox.textContent = message;
    errorBox.classList.add('show');
  }
  function showSuccess(message) {
    errorBox.style.color = 'var(--valid-text)';
    errorBox.style.background = 'var(--valid-bg)';
    errorBox.textContent = message;
    errorBox.classList.add('show');
  }

  // Forgot password — sends Supabase's reset email. Deliberately gives the
  // same confirming message whether or not the address has an account, so
  // this can't be used to probe which emails are registered.
  forgotLink.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    if (!email) {
      showError('Enter your email above first, then tap “Forgot password?”');
      emailInput.focus();
      return;
    }
    errorBox.classList.remove('show');
    forgotLink.textContent = 'Sending…';
    forgotLink.style.pointerEvents = 'none';
    try {
      await requestPasswordReset(email);
    } catch {
      // Swallow — don't reveal whether the address exists or the backend state.
    }
    forgotLink.textContent = 'Forgot password?';
    forgotLink.style.pointerEvents = '';
    showSuccess(`If an account exists for ${email}, a reset link is on its way.`);
  });

  // Restore an email typed just before a domain-triggered tenant switch —
  // reloading the page (required to reconnect to a different tenant) wipes
  // the form, so hand it back rather than making them retype it. Doesn't
  // clear the key here (only on a successful sign-in, further down) —
  // main.js's auth-state-change listener re-renders this page a second
  // time shortly after boot, and clearing on read would lose the restored
  // value to that second, now-empty render.
  try {
    const pending = sessionStorage.getItem(PENDING_EMAIL_KEY);
    if (pending) {
      emailInput.value = pending;
      passwordInput.focus();
    }
  } catch {
    // sessionStorage unavailable — nothing to restore
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.remove('show');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    // A work email is the only way a client identifies their tenant now —
    // check before attempting sign-in so someone on the wrong instance
    // gets switched, not just a wrong-password-looking error.
    const match = await lookupTenantByEmail(email);
    if (match?.slug && match.slug !== tenantSlug) {
      reloadIntoTenant(match.slug, email);
      return; // page is reloading, nothing left to do here
    }

    try {
      await signIn(email, password);
      try {
        sessionStorage.removeItem(PENDING_EMAIL_KEY);
      } catch {
        // sessionStorage unavailable — nothing to clean up
      }
      navigate(next);
    } catch (err) {
      showError(err.message || 'Could not sign in.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
    }
  });
}
