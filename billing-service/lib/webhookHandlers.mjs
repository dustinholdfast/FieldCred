import { Client } from 'pg';
import { pool, markEventProcessed } from './db.mjs';
import { buildManifestFromSession, ManifestValidationError } from './manifest.mjs';
import { resolvePlanForPrice } from './priceMap.mjs';
import { runProvisioning } from './provision.mjs';
import { sendTenantLiveAlert, sendDeployNeededAlert, sendProvisioningFailedAlert } from './email.mjs';

/**
 * checkout.session.completed — the core of Handoff 04. Does the FAST,
 * durable part synchronously (build + validate manifest, write a `signups`
 * row) so the caller can ack Stripe immediately, then kicks off the slow
 * part (actual provisioning, which takes minutes) without making Stripe
 * wait for it. See provision.mjs and README.md's "Crash recovery" section
 * for how a mid-provisioning crash gets picked back up.
 */
export async function handleCheckoutSessionCompleted(event, stripe) {
  const sessionSummary = event.data.object;

  // The webhook payload's session object doesn't include line items by
  // default — re-fetch with the expansion so manifest.mjs can read the
  // purchased price.
  const session = await stripe.checkout.sessions.retrieve(sessionSummary.id, {
    expand: ['line_items', 'customer'],
  });

  let built;
  try {
    built = buildManifestFromSession(session, resolvePlanForPrice);
  } catch (err) {
    if (err instanceof ManifestValidationError) {
      // A misconfigured Checkout Session/Price, not a customer error and
      // not something retrying will fix. Mark the event processed (so
      // Stripe doesn't keep redelivering something we can't act on) and
      // surface it loudly — this needs a human, now, since the customer
      // already paid.
      await markEventProcessed(event.id, event.type);
      console.error(`[checkout] manifest build failed for session ${session.id}: ${err.message}`);
      // Best-effort alert even without a signups row to attach to.
      await sendProvisioningFailedAlert(
        { slug: '(unknown — bad checkout config)', company_name: '?', admin_email: session.customer_details?.email || '?', id: session.id, status: 'failed' },
        err
      );
      return;
    }
    throw err;
  }

  const { manifest, priceId, planTier, maxWorkers } = built;

  // Slug-collision guard: refuse to provision into a slug that already
  // belongs to a DIFFERENT paying customer. Without this, a Checkout buyer
  // can type an existing customer's slug as their own `slug` custom field;
  // provision-tenant.mjs's findExistingProject() then matches that existing
  // project and (pre-fix) would invite this session's own email as admin
  // into it. tenant_billing.slug is the source of truth for "who owns this
  // slug today" — see schema.sql's SECURITY NOTE on that table.
  const { rows: existingBilling } = await pool.query(
    `select stripe_customer_id from tenant_billing where slug = $1`,
    [manifest.slug]
  );
  if (existingBilling[0] && existingBilling[0].stripe_customer_id !== session.customer.id) {
    await markEventProcessed(event.id, event.type);
    console.error(
      `[checkout] slug collision: session ${session.id} (customer ${session.customer.id}) targeted ` +
      `slug "${manifest.slug}", already owned by customer ${existingBilling[0].stripe_customer_id}. ` +
      `Refusing to provision — this is the shape of a takeover attempt, not a legitimate resume.`
    );
    await sendProvisioningFailedAlert(
      { slug: manifest.slug, company_name: manifest.name, admin_email: manifest.adminEmail, id: session.id, status: 'failed' },
      new Error(
        `Slug "${manifest.slug}" already belongs to Stripe customer ${existingBilling[0].stripe_customer_id}. ` +
        `This session's customer (${session.customer.id}) is a different customer. Do NOT run ` +
        `provision-tenant.mjs for this signup — investigate manually before doing anything with it.`
      )
    );
    return;
  }

  // Second half of the same guard, against tenant_registry. A slug can
  // exist there without a tenant_billing row — anything provisioned by
  // hand, `demo` included (source = 'manual'). Without this check a
  // Checkout buyer could type "demo" and have provisioning overwrite that
  // registry entry's credentials, pointing every existing user of that
  // slug at a different Supabase project.
  const { rows: existingRegistry } = await pool.query(
    `select source from tenant_registry where slug = $1`,
    [manifest.slug]
  );
  if (existingRegistry[0] && !existingBilling[0]) {
    await markEventProcessed(event.id, event.type);
    console.error(
      `[checkout] slug "${manifest.slug}" already exists in tenant_registry ` +
      `(source: ${existingRegistry[0].source}) with no matching tenant_billing row. ` +
      `Refusing to provision over a manually-created tenant.`
    );
    await sendProvisioningFailedAlert(
      { slug: manifest.slug, company_name: manifest.name, admin_email: manifest.adminEmail, id: session.id, status: 'failed' },
      new Error(
        `Slug "${manifest.slug}" is already in the tenant registry as a ` +
        `${existingRegistry[0].source} tenant. Pick a different slug for this customer, ` +
        `refund them, or investigate before running provision-tenant.mjs by hand.`
      )
    );
    return;
  }

  const client = await pool.connect();
  let signup;
  try {
    await client.query('begin');
    await client.query(
      `insert into processed_stripe_events (event_id, event_type) values ($1, $2)
       on conflict (event_id) do nothing`,
      [event.id, event.type]
    );
    const { rows } = await client.query(
      `insert into signups
         (stripe_event_id, stripe_session_id, stripe_customer_id, slug, company_name,
          admin_email, price_id, plan_tier, max_workers, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
       on conflict (stripe_session_id) do nothing
       returning *`,
      [event.id, session.id, session.customer.id, manifest.slug, manifest.name,
       manifest.adminEmail, priceId, planTier, maxWorkers]
    );
    await client.query('commit');
    signup = rows[0];
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }

  if (!signup) {
    // Already had a signup row for this exact session (e.g. Stripe fired
    // two different event ids for the same session, or a manual replay) —
    // the event itself is now marked processed either way; nothing new to do.
    console.log(`[checkout] session ${session.id} already had a signup row — skipping duplicate.`);
    return;
  }

  // Deliberately not awaited by the webhook handler's caller — provisioning
  // takes minutes and Stripe needs a fast ack. Errors inside are caught and
  // recorded on the signup row / emailed, not thrown into the void.
  provisionInBackground(signup).catch((err) => {
    console.error(`[checkout] unexpected error provisioning ${signup.slug}:`, err);
  });
}

export async function provisionInBackground(signup) {
  await pool.query(`update signups set status = 'provisioning', updated_at = now() where id = $1`, [signup.id]);

  const manifest = {
    slug: signup.slug,
    name: signup.company_name,
    organizationId: process.env.SUPABASE_ORG_ID,
    region: process.env.SUPABASE_REGION || 'us-east-2',
    adminEmail: signup.admin_email,
    domains: [],
    planTier: signup.plan_tier,
    maxWorkers: signup.max_workers,
    billingPlan: 'free',
  };

  const result = await runProvisioning(manifest);

  if (!result.ok) {
    await pool.query(
      `update signups set status = 'failed', last_error = $2, updated_at = now() where id = $1`,
      [signup.id, result.error]
    );
    await sendProvisioningFailedAlert(signup, new Error(result.error));
    return;
  }

  // Extract the DB connection string (only ever printed this once — see
  // provision-tenant.mjs's printDbUrl comment) plus the Supabase project
  // URL/anon key embedded in the tenants.php entry text, and store them so
  // the subscription webhook and Customer Portal endpoint can reach this
  // tenant later. See schema.sql's security note on tenant_billing.
  const dbUrl = result.dbUrlLine ? result.dbUrlLine.split('=').slice(1).join('=').trim() : null;
  const supabaseUrl = result.tenantsPhpEntry?.match(/'url'\s*=>\s*'([^']+)'/)?.[1] || null;
  const anonKey = result.tenantsPhpEntry?.match(/'anonKey'\s*=>\s*"([^"]+)"/)?.[1] || null;

  // These two capabilities are deliberately kept separate, because they
  // fail independently and one is far more urgent than the other:
  //
  //   canServeTenant  — url + anon key. Without it the tenant cannot be
  //                     resolved at all, so the customer literally cannot
  //                     reach their own login screen. This is the one that
  //                     must not silently fail.
  //   canTrackBilling — additionally needs db_url (NOT NULL on
  //                     tenant_billing). Without it, plan-limit sync and
  //                     the Customer Portal button break, but the customer
  //                     can still sign in and use the product.
  //
  // Treating them as one condition (as this did before the registry
  // existed) means a missing db_url — the value Supabase prints exactly
  // once and never again — would also block login. It shouldn't.
  const canServeTenant = Boolean(supabaseUrl && anonKey);
  const canTrackBilling = Boolean(canServeTenant && dbUrl);

  if (canServeTenant) {
    // The registry entry IS the thing that used to require a manual
    // tenants.php edit and FTP deploy. Writing it here is what closes that
    // gap — see migrations/002_tenant_registry.sql.
    await pool.query(
      `insert into tenant_registry (slug, supabase_url, supabase_anon_key, source, status, grace_period_ends_at)
       values ($1, $2, $3, 'stripe', 'active', null)
       on conflict (slug) do update set
         supabase_url         = excluded.supabase_url,
         supabase_anon_key    = excluded.supabase_anon_key,
         status               = 'active',
         grace_period_ends_at = null,
         updated_at           = now()`,
      [signup.slug, supabaseUrl, anonKey]
    );
  }

  if (canTrackBilling) {
    await pool.query(
      `insert into tenant_billing (slug, stripe_customer_id, price_id, plan_tier, db_url, supabase_url, supabase_anon_key)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (slug) do update set
         db_url = excluded.db_url, supabase_url = excluded.supabase_url, supabase_anon_key = excluded.supabase_anon_key`,
      [signup.slug, signup.stripe_customer_id, signup.price_id, signup.plan_tier, dbUrl, supabaseUrl, anonKey]
    );
  } else {
    console.error(
      `[provision] no tenant_billing row for ${signup.slug} (dbUrl=${!!dbUrl}, supabaseUrl=${!!supabaseUrl}, anonKey=${!!anonKey}) — ` +
      `this happens when resuming an already-existing project, since those fields are only printed on fresh creation. ` +
      `Subscription plan updates and the Customer Portal link will fail for this tenant until tenant_billing.db_url is backfilled by hand.`
    );
  }

  const projectRef = dbUrl ? extractRefFromDbUrl(dbUrl) : null;

  if (canServeTenant) {
    // 'live' — the customer can sign in right now, with no action from us.
    await pool.query(
      `update signups set status = 'live', tenants_php_entry = $2, supabase_project_ref = $3, updated_at = now() where id = $1`,
      [signup.id, result.tenantsPhpEntry, projectRef]
    );
    console.log(`[provision] "${signup.slug}" is LIVE — registry entry written, no manual step required.`);
    await sendTenantLiveAlert({ ...signup, tenants_php_entry: result.tenantsPhpEntry, billing_tracked: canTrackBilling });
  } else {
    // Couldn't recover the URL/anon key from provisioning output, so the
    // registry has no entry and tenant lookup will fall through to the
    // flat tenants.php file. That file is the fallback path, so the manual
    // deploy is still a working escape hatch — hence the original alert.
    await pool.query(
      `update signups set status = 'awaiting_deploy', tenants_php_entry = $2, supabase_project_ref = $3, updated_at = now() where id = $1`,
      [signup.id, result.tenantsPhpEntry, projectRef]
    );
    console.error(
      `[provision] "${signup.slug}" provisioned but could NOT be added to tenant_registry — ` +
      `falling back to the manual tenants.php deploy. Fix upstream: provision-tenant.mjs should print ` +
      `the tenants.php entry on every run, not only on fresh project creation.`
    );
    await sendDeployNeededAlert({ ...signup, tenants_php_entry: result.tenantsPhpEntry });
  }
}

function extractRefFromDbUrl(dbUrl) {
  // postgresql://postgres.<ref>:...@aws-1-<region>.pooler.supabase.com:5432/postgres
  const m = dbUrl.match(/postgres\.([a-z0-9]+):/);
  return m?.[1] || null;
}

/**
 * Maps a Stripe subscription status onto the three states tenant_billing
 * and tenant_registry share. Anything not clearly delinquent or dead maps
 * to 'active': the cost of wrongly marking a good customer past_due is a
 * confusing UI, while the cost of wrongly marking a delinquent one active
 * is just a slightly late dunning flow. Err toward not disrupting someone
 * who is paying.
 */
function mapSubscriptionStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'active'; // active, trialing, incomplete, paused
  }
}

/**
 * customer.subscription.updated / customer.subscription.deleted — keeps a
 * tenant's plan_limits in sync with what they're actually paying for.
 * Downgrades lower the cap but never touch existing worker rows (the
 * DB trigger in schema.sql blocks new inserts past the cap, which is the
 * correct enforcement point — see HANDOFF-04's design section).
 */
export async function handleSubscriptionChange(event) {
  const subscription = event.data.object;
  const customerId = subscription.customer;

  const { rows } = await pool.query(
    `select * from tenant_billing where stripe_customer_id = $1`,
    [customerId]
  );
  const tenant = rows[0];
  if (!tenant) {
    console.error(`[subscription] no tenant_billing row for Stripe customer ${customerId} — subscription event ${event.id} (${event.type}) not applied to any tenant. Likely a race with checkout provisioning, or a customer with no FieldCred tenant.`);
    return;
  }

  if (event.type === 'customer.subscription.deleted') {
    // Grace period, then the tenant stops resolving. Never drop the
    // Supabase project automatically — the customer's data outlives their
    // subscription, and a billing event is not a delete authorization.
    //
    // No scheduled job is needed to enforce the cutoff: routes/tenants.mjs
    // evaluates grace_period_ends_at against now() on every lookup, so the
    // tenant simply stops resolving the moment it passes. (This used to
    // require hand-removing their tenants.php entry.)
    const graceDays = Number(process.env.CANCELLATION_GRACE_DAYS || 7);

    await pool.query(
      `update tenant_billing set status = 'canceled',
         grace_period_ends_at = now() + ($2 || ' days')::interval, updated_at = now()
       where slug = $1`,
      [tenant.slug, graceDays]
    );

    await pool.query(
      `update tenant_registry set status = 'canceled',
         grace_period_ends_at = now() + ($2 || ' days')::interval, updated_at = now()
       where slug = $1`,
      [tenant.slug, graceDays]
    );

    console.log(`[subscription] "${tenant.slug}" canceled — resolves for ${graceDays} more days, then stops automatically.`);
    return;
  }

  const priceId = subscription.items.data[0]?.price?.id;
  const { planTier, maxWorkers } = resolvePlanForPrice(priceId);
  const status = mapSubscriptionStatus(subscription.status);

  // Registry status first, and unconditionally. It governs whether the
  // customer can reach their login screen at all, and it does not depend
  // on db_url — so a tenant with a missing db_url still gets un-canceled
  // correctly when they resume paying.
  await pool.query(
    `update tenant_registry set status = $2,
       grace_period_ends_at = case when $2 = 'canceled' then grace_period_ends_at else null end,
       updated_at = now()
     where slug = $1`,
    [tenant.slug, status]
  );

  if (!tenant.db_url) {
    console.error(`[subscription] "${tenant.slug}" has no db_url on file — cannot update plan_limits. Backfill tenant_billing.db_url by hand (see provision.mjs's dbUrlLine capture). Registry status was still updated to "${status}".`);
    return;
  }

  const client = new Client({ connectionString: tenant.db_url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(
      'update public.plan_limits set plan_tier = $1, max_workers = $2, updated_at = now() where id = 1',
      [planTier, maxWorkers]
    );
  } finally {
    await client.end();
  }

  await pool.query(
    `update tenant_billing set price_id = $2, plan_tier = $3, status = $4,
       grace_period_ends_at = case when $4 = 'canceled' then grace_period_ends_at else null end,
       updated_at = now()
     where slug = $1`,
    [tenant.slug, priceId, planTier, status]
  );
  console.log(`[subscription] "${tenant.slug}" plan updated -> ${planTier} (maxWorkers=${maxWorkers ?? 'unlimited'}, status=${status})`);
}
