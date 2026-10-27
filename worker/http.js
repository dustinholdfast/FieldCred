// Response helpers shared by the Worker's route modules.

export const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(self), payment=(), usb=(), interest-cohort=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

export function json(status, body, extraHeaders) {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function forbidden() {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('Content-Type', 'text/plain; charset=UTF-8');
  headers.set('Cache-Control', 'no-store');
  return new Response('Forbidden', { status: 403, headers });
}

export function limited(retryAfter) {
  return json(429, { error: 'Too many requests — please try again later.' }, {
    'Retry-After': String(retryAfter),
  });
}

export function cleanField(value, maxLen) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const stripped = trimmed.replace(/[\x00-\x1F\x7F]/g, '');
  return Array.from(stripped).slice(0, maxLen).join('');
}

export function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[ch]));
}
