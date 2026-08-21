// Roles: admin / safety / gate.
//
// The three roles the marketing site advertises. Each signed-in user carries
// one in their Supabase auth **app_metadata** under the key `fc_role`
// (app_metadata is not user-editable — that's the whole point; user_metadata
// would let a user promote themselves). See supabase/migrations/010_roles.sql
// for the server-side half.
//
// IMPORTANT: everything here is UX only. The real boundary is RLS in the
// database (migration 010) — the anon/authenticated key plus row-level
// policies. This module decides which controls to *show*; the DB decides
// what a request can actually *do*, and rejects anything the hidden UI still
// manages to reach. Keep the capability map below in sync with 010's policies.
//
// Pure and deterministic — see tests/roles.test.mjs.

export const ROLES = ['admin', 'safety', 'gate'];

// Existing production users have no fc_role at all. They must keep behaving
// exactly as today (full admin), so an absent/unknown role resolves to admin.
// This mirrors the coalesce(..., 'admin') default in 010's current_fc_role().
const DEFAULT_ROLE = 'admin';

const ROLE_LABELS = { admin: 'Admin', safety: 'Safety', gate: 'Gate' };

export function normalizeRole(raw) {
  return ROLES.includes(raw) ? raw : DEFAULT_ROLE;
}

// Reads the role off a Supabase session. app_metadata is surfaced on the
// session user; a missing session (or missing claim) falls back to the
// default via normalizeRole.
export function roleFromSession(session) {
  return normalizeRole(session?.user?.app_metadata?.fc_role);
}

export function roleLabel(role) {
  return ROLE_LABELS[normalizeRole(role)];
}

// capability -> which roles hold it. This table IS the frontend contract;
// it must mirror the RLS policies in 010_roles.sql (and schema.sql for new
// tenants). If a policy changes there, change the matching line here.
const CAPABILITIES = {
  // Nav / page reach
  viewDirectory: ['admin', 'safety', 'gate'],
  viewSites: ['admin', 'safety'],
  viewAdmin: ['admin', 'safety'],

  // Worker records
  editWorkers: ['admin', 'safety'], // create + edit workers/certs
  deleteWorkers: ['admin'],

  // Tenant-level management (all admin-only)
  manageSites: ['admin'],
  manageCredentialTypes: ['admin'],
  editTenantSettings: ['admin'],
  manageUsers: ['admin'],
};

export function roleCan(role, capability) {
  const allowed = CAPABILITIES[capability];
  return allowed ? allowed.includes(normalizeRole(role)) : false;
}

// Was a failed request rejected because the user's role isn't allowed to do
// it? Supabase/PostgREST surface an RLS denial as a 403 with Postgres code
// 42501 (insufficient_privilege), or a "row-level security policy" message
// on a write that no policy permits. Used to turn a raw DB error into a
// plain "your role can't do this" toast when a hidden control is somehow
// still reached (e.g. a stale tab open since before a role change).
// Also covers a missing GRANT, not just a failing RLS policy: Postgres raises
// the same 42501 with "permission denied for function/table …" when a role
// simply was never granted execute/select. That's a real configuration a
// tenant can be in — supabase/migrations/011 documents revoking the gate
// roster search from anon as a supported opt-out — and it must not be
// mistaken for a network failure.
export function isPermissionError(err) {
  if (!err) return false;
  if (err.code === '42501' || err.status === 403 || err.statusCode === 403) return true;
  const msg = (err.message || '').toLowerCase();
  return (
    msg.includes('row-level security') ||
    msg.includes('violates row-level security policy') ||
    msg.includes('permission denied for')
  );
}
