import { handleRequest } from './endpoints.js';

// Static files in public/ are served by Workers assets (see wrangler.json).
// This script runs first for the URLs listed under run_worker_first:
//   GET  /tenant-lookup.php?tenant=<slug>          -> { name, authUrl, dataApiUrl }
//   GET  /tenant-lookup-by-domain.php?email=<email>
//   POST /signup-notify.php
//   GET  /file.php?tenant=&bucket=&path=  or  ?tenant=&token=
//   POST /directory-search.php
//   POST /api/client-error, GET /api/health, POST /api/health/email (monitoring.js)
// Wrangler bundles these modules at deploy time.

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
