import { updatePassword } from '../lib/auth.js';
import { navigate } from '../lib/router.js';
import { logoImage } from '../components/logo.js';
import { exitRecoveryMode } from '../main.js';

// Shown after the user clicks the reset link in their email — Supabase
// establishes a temporary recovery session and fires PASSWORD_RECOVERY, which
// main.js routes here. They set a new password, then land in the app signed in.
export function renderResetPassword(container) {
  container.innerHTML = `
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-brand">${logoImage({ width: 160 })}</div>
        <div class="auth-title">Set a new password</div>
        <div class="auth-sub">Choose a new password for your account.</div>
        <div class="auth-error" id="reset-error"></div>
        <form id="reset-form">
          <div class="auth-field field">
            <label class="field-label">NEW PASSWORD</label>
            <input type="password" id="reset-password" autocomplete="new-password" required minlength="8">
          </div>
          <div class="auth-field field">
            <label class="field-label">CONFIRM PASSWORD</label>
            <input type="password" id="reset-confirm" autocomplete="new-password" required minlength="8">
          </div>
          <button type="submit" class="btn btn-primary btn-block" id="reset-submit">Update password</button>
        </form>
      </div>
    </div>
  `;

  const form = container.querySelector('#reset-form');
  const errorBox = container.querySelector('#reset-error');
  const submitBtn = container.querySelector('#reset-submit');
  const passwordInput = container.querySelector('#reset-password');
  const confirmInput = container.querySelector('#reset-confirm');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.remove('show');

    const password = passwordInput.value;
    if (password.length < 8) {
      errorBox.textContent = 'Password must be at least 8 characters.';
      errorBox.classList.add('show');
      return;
    }
    if (password !== confirmInput.value) {
      errorBox.textContent = "Those passwords don't match.";
      errorBox.classList.add('show');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Updating…';
    try {
      await updatePassword(password);
      exitRecoveryMode();
      navigate('/directory');
    } catch (err) {
      errorBox.textContent = err.message || 'Could not update your password.';
      errorBox.classList.add('show');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Update password';
    }
  });
}
