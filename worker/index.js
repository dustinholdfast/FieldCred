import { handleRequest } from './endpoints.js';

// Static files are served by Workers assets (see wrangler.jsonc). This script
// runs first for the PHP URLs the browser actually calls:
//   GET  /tenant-lookup.php?tenant=<slug>
//   GET  /tenant-lookup-by-domain.php?email=<email>
//   POST /signup-notify.php
// file.php is not in this docroot and nothing fetches it.
// client-error.php is only a comment in js/lib/errorReporting.js (endpoint is '').
// billing-service stays on Railway; the browser calls it cross-origin.

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
