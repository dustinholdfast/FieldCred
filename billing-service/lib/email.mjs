// Thin Resend wrapper — same provider already used by signup-notify.php /
// expiration-alerts, per the codebase's existing convention. Uses fetch
// directly rather than pulling in the Resend SDK for one endpoint.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_EMAIL = process.env.OPERATOR_ALERT_EMAIL; // Dustin's inbox for failures/deploy-needed notices
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'FieldCred <onboarding@fieldcred.co>';

async function send({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.error(`RESEND_API_KEY not set — would have sent "${subject}" to ${to}. Skipping.`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend send failed (${res.status}): ${body}`);
  }
}

/** The happy path, as of the DB-backed tenant registry: a signup
 * provisioned cleanly AND got its tenant_registry entry, so the customer
 * can sign in immediately with no action from us. This is a notification,
 * not a task — the only reason it exists is that you want to know a
 * customer signed up.
 *
 * `billing_tracked === false` is the one case that still needs a human:
 * the tenant resolves and the customer is fine, but tenant_billing has no
 * db_url, so plan-limit sync and the Customer Portal button won't work
 * until it's backfilled. */
export async function sendTenantLiveAlert(signup) {
  if (!ALERT_EMAIL) {
    console.error('OPERATOR_ALERT_EMAIL not set — cannot send tenant-live alert.');
    return;
  }

  const billingWarning = signup.billing_tracked === false
    ? `
      <p style="padding:12px;border-left:4px solid #c99a00;background:#fff8e1">
        <strong>One thing needs you.</strong> No <code>tenant_billing</code> row was written for this
        tenant, because the DB connection string wasn't recoverable from the provisioning output
        (Supabase prints it exactly once, on fresh project creation only). The customer is unaffected
        and can sign in normally, but <em>plan-limit changes and the Customer Portal button will fail
        for them</em> until <code>tenant_billing.db_url</code> is backfilled by hand.
      </p>`
    : '';

  await send({
    to: ALERT_EMAIL,
    subject: `[FieldCred] New paying tenant: ${signup.company_name} (${signup.slug})`,
    html: `
      <p><strong>${escapeHtml(signup.company_name)}</strong> (${escapeHtml(signup.admin_email)})
      just paid and provisioned as <code>${escapeHtml(signup.slug)}</code>.</p>
      <p>They are <strong>live now</strong> — the tenant registry entry was written automatically,
      and their Supabase admin invite has already gone out. No deploy step, nothing to paste,
      nothing for you to do.</p>
      ${billingWarning}
      <p style="color:#666;font-size:13px">Registry entry, for reference — this is what used to
      require a manual <code>tenants.php</code> edit:</p>
      <pre style="color:#666;font-size:12px">${escapeHtml(signup.tenants_php_entry)}</pre>
      <p style="color:#666;font-size:13px">Signup row: <code>${escapeHtml(signup.id)}</code></p>
    `,
  });
}

/** The degraded path. Provisioning succeeded, but the Supabase URL/anon key
 * couldn't be recovered from its output, so no tenant_registry entry was
 * written and the tenant will only resolve via the flat tenants.php
 * fallback. Deploying that entry by hand is the escape hatch.
 *
 * The real fix is upstream: provision-tenant.mjs should print its
 * "tenants.php entry" block on every run, not only when it creates a
 * project from scratch. Until it does, a RESUMED provision lands here. */
export async function sendDeployNeededAlert(signup) {
  if (!ALERT_EMAIL) {
    console.error('OPERATOR_ALERT_EMAIL not set — cannot send deploy-needed alert.');
    return;
  }
  await send({
    to: ALERT_EMAIL,
    subject: `[FieldCred] "${signup.slug}" provisioned but is NOT reachable — needs manual registry deploy`,
    html: `
      <p><strong>${escapeHtml(signup.company_name)}</strong> (${escapeHtml(signup.admin_email)})
      paid and provisioned cleanly as <code>${escapeHtml(signup.slug)}</code>. Their Supabase admin
      invite has gone out.</p>
      <p style="padding:12px;border-left:4px solid #c0392b;background:#fdecea">
        <strong>They cannot sign in yet.</strong> The automatic registry entry could not be written,
        because provisioning didn't report the Supabase URL and anon key — which is what happens on a
        <em>resumed</em> run, since those are only printed on fresh project creation.
      </p>
      <p>Escape hatch: add this to <code>tenants.php</code> and deploy it, which the tenant lookup
      still falls back to.</p>
      <pre>${escapeHtml(signup.tenants_php_entry)}</pre>
      <p>Better: insert it into the registry directly, and no deploy is needed at all —</p>
      <pre>insert into tenant_registry (slug, supabase_url, supabase_anon_key, source)
values ('${escapeHtml(signup.slug)}', '&lt;url from above&gt;', '&lt;anonKey from above&gt;', 'stripe')
on conflict (slug) do update set
  supabase_url = excluded.supabase_url,
  supabase_anon_key = excluded.supabase_anon_key,
  updated_at = now();</pre>
      <p>Then mark the signup live:
      <code>update signups set status = 'live' where id = '${escapeHtml(signup.id)}';</code></p>
    `,
  });
}

/** Sent to Dustin when provisioning fails partway through — includes the
 * resume command since provision-tenant.mjs supports resuming a
 * partial run (see its own header comment). */
export async function sendProvisioningFailedAlert(signup, error) {
  if (!ALERT_EMAIL) {
    console.error('OPERATOR_ALERT_EMAIL not set — cannot send failure alert.');
    return;
  }
  await send({
    to: ALERT_EMAIL,
    subject: `[FieldCred] Provisioning FAILED for "${signup.slug}" — customer already charged`,
    html: `
      <p><strong>${escapeHtml(signup.company_name)}</strong> (${escapeHtml(signup.admin_email)}) paid, but provisioning
      failed part way through:</p>
      <pre>${escapeHtml(error.message || String(error))}</pre>
      <p>provision-tenant.mjs is resumable — re-run it against the same manifest (slug
      <code>${escapeHtml(signup.slug)}</code>) once the underlying issue is fixed; it checks current state
      before redoing any step.</p>
      <p>Signup row: <code>${escapeHtml(signup.id)}</code> (status: <code>${escapeHtml(signup.status)}</code>)</p>
    `,
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
