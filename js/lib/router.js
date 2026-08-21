// Minimal hash-based router — works on any static file host with no
// server-side rewrite config, which matters since this app ships as
// plain static files (no build/deploy pipeline in this environment).

const routes = [];
let notFoundHandler = () => {};

export function route(pattern, handler) {
  const paramNames = [];
  const regex = new RegExp(
    '^' +
      pattern
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            paramNames.push(seg.slice(1));
            return '([^/]+)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/') +
      '$'
  );
  routes.push({ regex, paramNames, handler });
}

export function notFound(handler) {
  notFoundHandler = handler;
}

function currentPath() {
  const hash = location.hash.slice(1);
  return hash ? hash.split('?')[0] : '/directory';
}

function currentQuery() {
  const hash = location.hash.slice(1);
  const qIndex = hash.indexOf('?');
  return new URLSearchParams(qIndex === -1 ? '' : hash.slice(qIndex + 1));
}

function dispatch() {
  const path = currentPath();
  for (const r of routes) {
    const match = path.match(r.regex);
    if (match) {
      const params = {};
      r.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(match[i + 1])));
      r.handler(params, currentQuery());
      return;
    }
  }
  notFoundHandler();
}

export function navigate(path) {
  if (location.hash.slice(1) === path) {
    dispatch();
  } else {
    location.hash = path;
  }
}

export function startRouter() {
  window.addEventListener('hashchange', dispatch);
  if (!location.hash) location.hash = '/directory';
  dispatch();
}

export function getPath() {
  return currentPath();
}

// Re-runs the handler for whatever route is currently active — used when
// auth state changes (sign in/out) so the current page re-evaluates
// whether it's still allowed to be shown, without a hash change.
export function redispatch() {
  dispatch();
}
