import { db, tenantSlug, authUrl } from './backendClient.js';
import { roleFromSession } from './roles.js';

// Neon Auth does not put fc_role on the session. The database does, in
// staff_roles, via current_fc_role(). Stamp it onto app_metadata so the
// rest of the app (roleFromSession) keeps reading one place.
async function withRole(session) {
  if (!session?.user || !db) return session;
  try {
    const { data, error } = await db.rpc('current_fc_role');
    if (error || data == null) return session;
    const role = Array.isArray(data) ? data[0] : data;
    if (typeof role === 'string' && role) {
      session.user.app_metadata = { ...(session.user.app_metadata || {}), fc_role: role };
    }
  } catch {
    // Schema not applied yet — leave the session unchanged. The UI then
    // treats a missing claim as admin (js/lib/roles.js); the database
    // still defaults to unassigned and refuses staff queries.
  }
  return session;
}

export async function signIn(email, password) {
  const { data, error } = await db.auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (data?.session) await withRole(data.session);
  return data.session;
}

export async function signOut() {
  await db.auth.signOut();
}

export async function getSession() {
  const { data } = await db.auth.getSession();
  if (data?.session) await withRole(data.session);
  return data.session;
}

// The current user's role (admin | safety | gate), read from the session
// after withRole() has copied current_fc_role() onto app_metadata. A missing
// claim still resolves to admin in the UI (js/lib/roles.js). The database
// default is unassigned — see neon/schema.sql.
export async function currentRole() {
  const session = await getSession();
  return roleFromSession(session);
}

// Sends Neon Auth's password-reset email. redirectTo is where the link
// lands. Neon appends ?token= (preserving an existing ?tenant=). main.js
// sees that token and opens the set-password screen. The ?tenant= is
// required: the token is only valid against THIS tenant's Neon Auth, and
// a reset email is often opened on a different device than the one that
// requested it.
export async function requestPasswordReset(email) {
  const redirectTo = `${location.origin}${location.pathname}?tenant=${encodeURIComponent(tenantSlug)}`;
  const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}

// Sets a new password from the token on the reset link. Neon Auth's
// Supabase-compatible updateUser() does not accept a password.
export async function updatePassword(newPassword) {
  const token = new URLSearchParams(location.search).get('token');
  if (!token || !authUrl) {
    throw new Error('This reset link is missing its token. Request a new one from the sign-in page.');
  }
  const res = await fetch(`${authUrl.replace(/\/$/, '')}/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword, token }),
  });
  if (!res.ok) {
    let message = 'Could not update your password.';
    try {
      const body = await res.json();
      message = body?.message || body?.error || message;
    } catch {
      // non-JSON error body
    }
    throw new Error(typeof message === 'string' ? message : 'Could not update your password.');
  }
  const url = new URL(location.href);
  url.searchParams.delete('token');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export function onAuthStateChange(callback) {
  const { data } = db.auth.onAuthStateChange((event, session) => {
    if (!session) {
      callback(null, event);
      return;
    }
    withRole(session).then((enriched) => callback(enriched, event));
  });
  return () => data.subscription.unsubscribe();
}
