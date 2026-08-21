// FieldCred billing service — Stripe Checkout -> auto-provisioning
// (Handoff 04). Deploy this on its own always-on Node host (Render/Fly/a
// VPS) — see README.md. It holds STRIPE_SECRET_KEY and
// SUPABASE_ACCESS_TOKEN; it must NEVER run on the shared fieldcred.co PHP
// host (same rule as admin-dashboard/server.mjs, see its own header
// comment and supabase/TENANCY-MODEL.md).

import express from 'express';
import Stripe from 'stripe';
import { pool, isEventProcessed, markEventProcessed, findResumableSignups } from './lib/db.mjs';
import { handleCheckoutSessionCompleted, handleSubscriptionChange, provisionInBackground } from './lib/webhookHandlers.mjs';
import { registerPortalRoute } from './routes/portal.mjs';
import { registerTenantRoutes } from './routes/tenants.mjs';

const required = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUPABASE_ACCESS_TOKEN', 'BILLING_DB_URL'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')} — see .env.example.`);
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// Railway terminates TLS at its edge and forwards with X-Forwarded-For, so
// without this every request looks like it came from the proxy's address.
// The tenant-lookup rate limiter in routes/tenants.mjs keys on req.ip —
// left unset, that would collapse into one shared bucket for the entire
// internet, and the first scripted caller would lock out every real user.
// '1' = trust exactly one proxy hop (Railway's), not an arbitrary chain a
// client could forge by sending its own X-Forwarded-For header.
app.set('trust proxy', 1);

// Stripe signature verification needs the RAW request body — this route
// must NOT go through express.json() (which would consume/reparse the
// body and break the signature check). Every other route uses JSON below.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  // Ack fast — Stripe times out and retries if this handler takes too
  // long, and checkout.session.completed's real work (provisioning) takes
  // minutes. handleCheckoutSessionCompleted only awaits the FAST synchronous
  // part (writing a signups row) before returning; provisioning itself runs
  // detached. See webhookHandlers.mjs for the exact split.
  try {
    if (await isEventProcessed(event.id)) {
      console.log(`[webhook] ${event.id} (${event.type}) already processed — no-op.`);
      return res.status(200).send('already processed');
    }

    switch (event.type) {
      case 'checkout.session.completed':
        // Marks the event processed itself, inside the same transaction as
        // the signups insert (that insert has a FK to processed_stripe_events).
        await handleCheckoutSessionCompleted(event, stripe);
        break;
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await handleSubscriptionChange(event);
        await markEventProcessed(event.id, event.type);
        break;
      default:
        // Unhandled event type — ack it so Stripe stops retrying, but don't
        // pretend anything happened.
        console.log(`[webhook] ignoring unhandled event type ${event.type}`);
        await markEventProcessed(event.id, event.type);
    }
    res.status(200).send('ok');
  } catch (err) {
    // Deliberately NOT marking processed here — an unexpected error means
    // Stripe should retry (its own retry schedule + `stripe events resend`
    // for manual replay are the safety net for this path; provisioning's
    // own failures are handled separately, see webhookHandlers.mjs).
    console.error(`[webhook] handler error for ${event.id} (${event.type}):`, err);
    res.status(500).send('internal error — will retry');
  }
});

app.use(express.json());
registerPortalRoute(app, stripe);

// Tenant registry lookup — GET /api/tenant/:slug and
// /api/tenant-by-domain. This is what replaces hand-editing tenants.php
// for every new customer: tenant-lookup.php on the PHP host proxies to
// these, falling back to the flat file if this service is unreachable.
// Unauthenticated by necessity (the app resolves a tenant before any
// session exists) and reads only from tenant_registry, which holds no
// secrets — see routes/tenants.mjs and migrations/002_tenant_registry.sql
// for the full rationale.
registerTenantRoutes(app, pool);

app.get('/healthz', (req, res) => res.status(200).send('ok'));

const port = process.env.PORT || 3000;
app.listen(port, async () => {
  console.log(`[server] listening on :${port}`);

  // Crash recovery: pick back up any signup that never reached a terminal
  // status (see db.mjs's findResumableSignups and README.md's "Crash
  // recovery" section for why this startup sweep exists instead of a real
  // job queue in v1). provision-tenant.mjs is itself resumable, so re-running
  // it against the same slug is safe even if the prior attempt got partway
  // through.
  try {
    const stuck = await findResumableSignups();
    if (stuck.length) {
      console.log(`[startup] resuming ${stuck.length} signup(s) that didn't reach a terminal state: ${stuck.map((s) => s.slug).join(', ')}`);
      for (const signup of stuck) {
        provisionInBackground(signup).catch((err) => console.error(`[startup] failed to resume ${signup.slug}:`, err));
      }
    }
  } catch (err) {
    console.error('[startup] crash-recovery sweep failed:', err);
  }
});
