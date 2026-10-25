import { escapeHtml } from '../lib/format.js';
import { isPermissionError } from '../lib/roles.js';

let hideTimer = null;

export function showToast(message) {
  const root = document.getElementById('toast-root');
  clearTimeout(hideTimer);
  root.innerHTML = `<div class="toast">${escapeHtml(message)}</div>`;
  hideTimer = setTimeout(() => {
    root.innerHTML = '';
  }, 2200);
}

// Surface a failed write. If RLS rejected it because the user's role can't
// perform the action (a hidden control reached anyway — e.g. a stale tab, or
// a role that changed under the user), say so plainly instead of leaking a
// raw Postgres error. Otherwise fall back to the caller's message.
export function showActionError(err, fallback) {
  if (isPermissionError(err)) {
    showToast("Your role can't do this.");
    return;
  }
  showToast(fallback || `Something went wrong: ${err?.message || err}`);
}
