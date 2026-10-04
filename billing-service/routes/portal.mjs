// Customer Portal session endpoint — replaces the at-cap "Request more
// capacity" mailto link in the admin page (see HANDOFF-04's design section,
// point 4). Called from the FieldCred app itself, so it has to verify the
// caller is really an authenticated admin of the tenant they claim — this
// service has no user accounts of its own, so it verifies by asking the
// tenant's Neon Data API for current_fc_role(), reusing the same session
// the rest of the app already trusts rather than building a second auth
// system.

import { pool } from '../lib/db.mjs';

export function registerPortalRoute(app, stripe) {
  app.post('/api/portal-session', async (req, res) => {
    const { slug } = req.body || {};
    const authHeader = req.get('authorization'); // expects "Bearer <Neon Auth session token>"

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

    // Verify the token against the TENANT'S OWN Neon Data API. current_fc_role()
    // reads staff_roles for this session. A token from another tenant's
    // project fails the JWT check. Only admin may open the portal.
    if (!tenant.data_api_url) {
      return res.status(409).json({ error: 'This tenant is not pointed at Neon yet.' });
    }
    const roleRes = await fetch(`${tenant.data_api_url.replace(/\/$/, '')}/rpc/current_fc_role`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
    });
    if (!roleRes.ok) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    const raw = await roleRes.json();
    const role = Array.isArray(raw) ? raw[0] : raw;
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
