import { escapeHtml } from '../lib/format.js';
import { logoImage } from '../components/logo.js';

// Public "Request access" form — Phase 1 of self-serve onboarding: this
// doesn't provision anything itself, it just emails the operator (via
// signup-notify.php -> Resend) so they can run through
// supabase/PROVISIONING.md by hand. No auth required to reach this page —
// it's registered as a public route in main.js, same as /login and /r/:slug.
export function renderSignup(container) {
  container.innerHTML = `
    <div class="auth-page">
      <div class="auth-card" style="width:440px;">
        <div class="auth-brand">${logoImage({ width: 160 })}</div>
        <div class="auth-title">Request access</div>
        <div class="auth-sub">Tell us about your company and we'll set up your own FieldCred instance.</div>
        <div class="auth-error" id="signup-error"></div>
        <div id="signup-success" style="display:none;text-align:center;padding:20px 0;">
          <div style="font-size:15px;font-weight:600;color:var(--valid-text);margin-bottom:8px;">Request received</div>
          <div style="font-size:13px;color:var(--text-secondary);line-height:1.5;">We'll be in touch shortly to get your instance set up. In the meantime, feel free to close this tab.</div>
        </div>
        <form id="signup-form">
          <div class="auth-field field">
            <label class="field-label">COMPANY NAME</label>
            <input type="text" id="signup-company" required maxlength="200">
          </div>
          <div class="auth-field field">
            <label class="field-label">YOUR WORK EMAIL</label>
            <input type="email" id="signup-email" autocomplete="email" required maxlength="200">
          </div>
          <div class="auth-field field">
            <label class="field-label">COMPANY EMAIL DOMAIN <span style="font-weight:400;color:var(--text-muted);">(optional)</span></label>
            <input type="text" id="signup-domain" placeholder="e.g. acmecorp.com" maxlength="255">
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Lets your team sign in with their work email later, no ID to remember. Leave blank if unsure — we can add it after.</div>
          </div>
          <div class="auth-field field">
            <label class="field-label">ANYTHING ELSE? <span style="font-weight:400;color:var(--text-muted);">(optional)</span></label>
            <textarea id="signup-note" rows="3" maxlength="2000" style="width:100%;padding:10px 12px;border:1px solid var(--border-4);border-radius:var(--radius-input);font:inherit;font-size:13.5px;resize:vertical;"></textarea>
          </div>
          <div class="visually-hidden">
            <label for="signup-website">Leave this field empty</label>
            <input type="text" id="signup-website" name="website" tabindex="-1" autocomplete="off">
          </div>
          <button type="submit" class="btn btn-primary btn-block" id="signup-submit">Request access</button>
        </form>
        <div style="text-align:center;margin-top:16px;">
          <a href="#/login" style="font-size:12.5px;">Back to sign in</a>
        </div>
      </div>
    </div>
  `;

  const form = container.querySelector('#signup-form');
  const errorBox = container.querySelector('#signup-error');
  const successBox = container.querySelector('#signup-success');
  const submitBtn = container.querySelector('#signup-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.remove('show');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    const payload = {
      companyName: container.querySelector('#signup-company').value.trim(),
      adminEmail: container.querySelector('#signup-email').value.trim(),
      domain: container.querySelector('#signup-domain').value.trim(),
      note: container.querySelector('#signup-note').value.trim(),
      website: container.querySelector('#signup-website').value, // honeypot
    };

    try {
      const res = await fetch('./signup-notify.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send that — try again in a moment.');

      form.style.display = 'none';
      successBox.style.display = 'block';
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.add('show');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Request access';
    }
  });
}
