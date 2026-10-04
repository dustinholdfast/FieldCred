import { handleRequest } from './endpoints.js';

// Static files are served by Workers assets (see wrangler.jsonc). This script
// runs first for the URLs the browser actually calls:
//   GET  /tenant-lookup.php?tenant=<slug>          -> { name, authUrl, dataApiUrl }
//   GET  /tenant-lookup-by-domain.php?email=<email>
//   POST /signup-notify.php
//   GET  /file.php?tenant=&bucket=&path=  or  ?tenant=&token=
// client-error.php is only a comment in js/lib/errorReporting.js (endpoint is '').
// billing-service stays on Railway; the browser calls it cross-origin.

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
