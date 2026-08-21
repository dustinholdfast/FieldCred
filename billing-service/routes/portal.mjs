// Customer Portal session endpoint — replaces the at-cap "Request more
// capacity" mailto link in the admin page (see HANDOFF-04's design section,
// point 4). Called from the FieldCred app itself, so it has to verify the
// caller is really an authenticated admin of the tenant they claim — this
// service has no user accounts of its own, so it verifies by asking the
// TENANT'S OWN Supabase project to validate the bearer token, reusing the
// same auth the rest of the app already trusts rather than building a
// second auth system.

import { pool } from '../lib/db.mjs';

export function registerPortalRoute(app, stripe) {
  app.post('/api/portal-session', async (req, res) => {
    const { slug } = req.body || {};
    const authHeader = req.get('authorization'); // expects "Bearer <supabase access token>"

    if (!slug || !authHeader?.startsWith('Bearer ')) {
      return res.status(400).json({ error: 'slug and Authorization: Bearer <token> are required' });
    }
    const accessToken = authHeader.slice('Bearer '.length);

    const { rows } = await pool.query(
      'select * from tenant_billing where slug = $1',
      [slug]
    );
    const tenant = rows[0];
    if (!tenant) {
      return res.status(404).json({ error: `No billing record for tenant "${slug}"` });
    }

    // Verify the token against the TENANT'S OWN Supabase Auth — confirms
    // it's a real, current session for this specific tenant (not another
    // tenant's token, not expired/forged), and that the role is admin
    // (matches current_fc_role()'s convention: only admin manages billing).
    const userRes = await fetch(`${tenant.supabase_url}/auth/v1/user`, {
      headers: { apikey: tenant.supabase_anon_key, Authorization: `Bearer ${accessToken}` },
    });
    if (!userRes.ok) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    const user = await userRes.json();
    const role = user.app_metadata?.fc_role || 'admin'; // unset defaults to admin — see current_fc_role()
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can manage billing' });
    }

    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: tenant.stripe_customer_id,
        return_url: process.env.PORTAL_RETURN_URL || `https://app.fieldcred.co/?tenant=${slug}#/admin`,
      });
      res.json({ url: session.url });
    } catch (err) {
      console.error(`[portal] failed to create portal session for ${slug}:`, err.message);
      res.status(502).json({ error: 'Could not reach Stripe — try again in a moment.' });
    }
  });
}
