// Ask Neon to keep this tenant's compute awake.
//
// Scale to zero suspends an idle compute after 5 minutes on the Free plan,
// and that suspension cannot be disabled there. Launch and Scale can set
// suspend_timeout_seconds to -1 (never suspend). This script requests -1
// and prints the API's answer. It does not pretend the change stuck.
//
// Env (names only — set them in the shell, never commit the values):
//   NEON_API_KEY
//   NEON_PROJECT_ID
//   NEON_ENDPOINT_ID
//
//   node neon/configure-compute.mjs

const apiKey = process.env.NEON_API_KEY;
const projectId = process.env.NEON_PROJECT_ID;
const endpointId = process.env.NEON_ENDPOINT_ID;

if (!apiKey || !projectId || !endpointId) {
  console.error('Set NEON_API_KEY, NEON_PROJECT_ID, and NEON_ENDPOINT_ID.');
  process.exit(1);
}

const url = `https://console.neon.tech/api/v2/projects/${projectId}/endpoints/${endpointId}`;
const res = await fetch(url, {
  method: 'PATCH',
  headers: {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: 'application/json',
  },
  body: JSON.stringify({ endpoint: { suspend_timeout_seconds: -1 } }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`Neon refused suspend_timeout_seconds=-1 (${res.status}).`);
  console.error(text);
  console.error('Free plan computes always scale to zero. Launch or Scale is required to keep this endpoint awake.');
  process.exit(2);
}
console.log('suspend_timeout_seconds is -1 (compute will not scale to zero).');
