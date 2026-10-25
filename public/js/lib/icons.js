// Inline SVG icon set — replaces the design prototype's text glyphs
// (⤢ ↗ ↑ ⬇ ✉ ☎ 📍 × ▾ ⚠) per the handoff's "Assets" note.

const svg = (paths, viewBox = '0 0 24 24') =>
  `<svg class="icon" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
  share: svg('<path d="M18 8a3 3 0 1 0-2.83-4H15a3 3 0 0 0 .09 4.26L8.91 11.7a3 3 0 1 0 0 2.6l6.18 3.44A3 3 0 1 0 16.83 15l-6.18-3.44a3.06 3.06 0 0 0 0-2.12l6.18-3.44c.29.26.63.47 1 .6a3 3 0 0 0 0-.6Z"/>'),
  externalLink: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>'),
  upload: svg('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>'),
  uploadTray: svg('<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/>'),
  download: svg('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
  mail: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>'),
  phone: svg('<path d="M13.4 8.6a2 2 0 0 1 2 0l2.9 1.7a2 2 0 0 1 1 1.9l-.2 2.4a2 2 0 0 1-2.4 1.8A15.9 15.9 0 0 1 4.6 4.3a2 2 0 0 1 1.8-2.4l2.4-.2a2 2 0 0 1 1.9 1l1.7 2.9a2 2 0 0 1 0 2Z"/>'),
  mapPin: svg('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  chevronDown: svg('<path d="m6 9 6 6 6-6"/>'),
  alert: svg('<path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  checkCircle: svg('<path d="M21.8 10A10 10 0 1 1 17 3.3"/><path d="m9 11 3 3L22 4"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  edit: svg('<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>'),
  printer: svg('<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>'),
  qr: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M20 14v.01"/><path d="M14 20h.01"/><path d="M20 20v.01"/><path d="M17.5 20.5h.01"/>'),
};
