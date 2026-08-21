import { supabase, tenantSlug } from './supabaseClient.js';
import { roleFromSession } from './roles.js';

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// The current user's role (admin | safety | gate), read from the session
// JWT's app_metadata. Defaults to 'admin' for existing users with no
// fc_role claim — see js/lib/roles.js. Note (JWT staleness): a role change
// made in the Supabase dashboard only reaches the client after the token
// refreshes (~1h) or the user signs out and back in.
export async function currentRole() {
  const session = await getSession();
  return roleFromSession(session);
}

// Sends Supabase's built-in password-reset email. redirectTo is where the
// link in that email lands the user — back at the app, where the resulting
// PASSWORD_RECOVERY auth event (handled in main.js) shows the set-new-password
// screen. Uses the path without any hash so it doesn't collide with the app's
// hash router; Supabase appends its own recovery token to the URL as a hash
// fragment, so a ?tenant= query param here doesn't interfere with it.
//
// The ?tenant= is required, not cosmetic: the recovery token Supabase
// appends is only valid against THIS tenant's own Supabase project. If the
// link is opened on a device with no matching localStorage override (the
// normal case — a recovery email is often opened on a different device
// than the one that requested it), resolveTenantSlug() would otherwise
// silently fall back to 'default' and initialize the wrong project's
// client, breaking recovery for every tenant except 'default' itself. Same
// bug class as the QR/share links in badgeCards.js and shareDialog.js,
// found via a real broken QR scan on the demo tenant, 2026-07-14.
export async function requestPasswordReset(email) {
  const redirectTo = `${location.origin}${location.pathname}?tenant=${encodeURIComponent(tenantSlug)}`;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}

// Sets a new password for the user in the (recovery) session.
export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

export function onAuthStateChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => callback(session, event));
  return () => data.subscription.unsubscribe();
}
