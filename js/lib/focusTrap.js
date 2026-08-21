// Keeps Tab focus inside a modal. Call from the dialog's keydown handler and
// pass the modal element; returns true if it moved focus. Written to be
// re-query-safe (it reads the current DOM each call), so it survives dialogs
// that re-render their contents in place (e.g. the share dialog).
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function keepFocusInside(e, modalEl) {
  if (e.key !== 'Tab' || !modalEl) return false;
  const items = [...modalEl.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  if (!items.length) return false;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !modalEl.contains(active))) {
    e.preventDefault();
    last.focus();
    return true;
  }
  if (!e.shiftKey && (active === last || !modalEl.contains(active))) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

// Moves focus to the first focusable control inside the modal (falling back to
// the modal itself), so keyboard users start inside the dialog, not behind it.
export function focusFirst(modalEl) {
  if (!modalEl) return;
  const first = modalEl.querySelector(FOCUSABLE);
  (first || modalEl).focus();
}
