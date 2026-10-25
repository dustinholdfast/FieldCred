import { STATUS_META } from '../lib/status.js';
import { escapeHtml } from '../lib/format.js';

// status: 'valid' | 'expiring' | 'expired' | 'missing'
export function statusPill(status, { label } = {}) {
  const meta = STATUS_META[status];
  const text = label || meta.label;
  return `<span class="pill status-${status}"><span class="pill-dot"></span>${escapeHtml(text)}</span>`;
}

const COUNT_NOUNS = { valid: 'valid', expiring: 'expiring', expired: 'expired', missing: 'no date' };

export function countPill(status, count) {
  return statusPill(status, { label: `${count} ${COUNT_NOUNS[status] ?? status}` });
}
