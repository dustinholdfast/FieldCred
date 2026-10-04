# FieldCred on Neon

The app reads and writes through Neon Auth and the Neon Data API (Postgres with row-level security). It does not use the Supabase client.

Nothing in this folder copies an existing Supabase database. Passwords cannot be imported: Neon Auth and Supabase hash them differently. Existing staff set a new password (or you create them again) after cutover.

## Env vars (names only)

Set these in the host that needs them. Do not commit the values.

| Name | Where | What it is |
| --- | --- | --- |
| `NEON_AUTH_URL` | `js/lib/config.js` fallback, or `tenants.php` `authUrl` | Public Neon Auth base URL for one tenant |
| `NEON_DATA_API_URL` | `js/lib/config.js` fallback, or `tenants.php` `dataApiUrl` | Public Data API URL ending in `/rest/v1` |
| `NEON_API_KEY` | shell / billing service | Neon API key. Creates projects and changes compute settings |
| `NEON_ORG_ID` | shell / billing service | Org id, when the key can see more than one org |
| `NEON_PROJECT_ID` | `neon/configure-compute.mjs` | Project whose compute you are keeping awake |
| `NEON_ENDPOINT_ID` | `neon/configure-compute.mjs` | Compute endpoint id |
| `NEON_REGION_ID` | optional, default `aws-us-east-2` | Region for new projects |
| `DATABASE_URL` | schema apply, `neon/expiration-alerts.mjs` | Direct Postgres URL for one tenant. Not the pooler. Never in the browser or in git |
| `BILLING_DB_URL` | billing service | Unchanged. After migration `003_neon_endpoints.sql`, this database also stores each tenant's `auth_url` and `data_api_url` |
| `RESEND_API_KEY` | expiration digest | Already used to send mail |
| `RESEND_FROM_EMAIL` | expiration digest | From address |

`tenants.php` and the billing registry hold `authUrl` and `dataApiUrl` only. Those are public. A database password does not belong in either place.

## Scale to zero

A free Neon compute suspends after about 5 idle minutes. The next request wakes it, and that cold start is what broke page loads in another app. This account cannot turn that off: creating a project with `suspend_timeout_seconds = -1` returns HTTP 412, `modifying the suspend interval is not permitted on this account`.

Launch and Scale can disable it. After the project is on one of those plans:

```sh
node neon/configure-compute.mjs
```

That PATCHes the endpoint to `suspend_timeout_seconds = -1` (never suspend). If the plan still refuses, the script exits non-zero and prints the API body. Do not treat a Free project as safe for the gate.

The browser uses the Data API over HTTPS. It does not hold a Postgres connection open, so it cannot keep a Free compute awake by itself.

## Point a tenant at Neon

1. Create a Neon project (console, or `node neon/provision-tenant.mjs manifest.json` with `NEON_API_KEY` set). Prefer a paid plan and run `configure-compute.mjs` so the compute does not sleep.
2. On the default branch, enable **Neon Auth** (Managed Better Auth) and the **Data API** authenticated by Neon Auth. Copy the Auth base URL and the Data API URL (`.../rest/v1`).
3. Add the app origin to Neon Auth trusted domains (for production, `https://app.fieldcred.co`, plus any tenant subdomain you actually serve).
4. With `DATABASE_URL` set to the **direct** connection string, apply `neon/schema.sql`.
5. Create the first admin in Neon Auth (console → Auth → Users). Copy that user's id and run:

   ```sql
   insert into public.staff_roles (user_id, fc_role, email)
   values ('<user id>', 'admin', 'you@example.com');
   ```

   A user with no `staff_roles` row is `unassigned` and cannot read staff tables. The UI still treats a missing claim as admin; the database does not.
6. Put the two public URLs on the tenant:
   - `tenants.php`: `authUrl` and `dataApiUrl`
   - billing database, after `billing-service/migrations/003_neon_endpoints.sql`:

     ```sql
     update tenant_registry
        set auth_url = '<NEON_AUTH_URL>', data_api_url = '<NEON_DATA_API_URL>'
      where slug = '<slug>';
     update tenant_billing
        set auth_url = '<NEON_AUTH_URL>', data_api_url = '<NEON_DATA_API_URL>'
      where slug = '<slug>';
     ```

7. Deploy the Cloudflare Worker (`npx wrangler deploy`, workers.dev only, no custom domain). `file.php` is a Worker route. The billing service stays on Railway; deploy that separately after `003_neon_endpoints.sql`.

## Confirm reads and writes

Against the Data API, not the SQL editor alone:

1. Sign in as the admin. Directory loads (read `workers`). Create a worker (write). Reload and confirm the row is still there.
2. Signed out, open `#/r/<public slug>`. The public page loads from `public_workers` and does not show phone or email.
3. Upload a photo. The profile image URL is `file.php?tenant=...&bucket=photos&path=...` and the image renders.
4. Open a certificate. The app calls `create_file_grant` and `file.php?token=...` returns the file. A second request after the token expires returns 404.
5. As a user with no `staff_roles` row, staff pages fail closed (the API returns a permission error).
6. Billing portal: from Admin, the capacity button returns a Stripe URL only for an admin session. A non-admin token gets 403.

## Data cutover (not done in this change)

`pg_dump` the Supabase database (direct connection, data only for `public` tables) and restore into the Neon database **after** `neon/schema.sql`. Skip Supabase-only schemas (`auth`, `storage`, `vault`, `supabase_migrations`).

Then:

- Rewrite `photo_url`, `logo_url`, and badge image URLs that still point at `*.supabase.co`. New uploads already store `file.php` URLs. Old certificate paths that are full Supabase URLs are left as-is and will not open until the bytes are loaded into `public.files`.
- Re-create every staff user in Neon Auth and insert matching `staff_roles` rows. Send each of them a password reset. Do not expect the old password hashes to work.
- Schedule `neon/expiration-alerts.mjs` hourly with `DATABASE_URL` and `RESEND_API_KEY`. `FORCE=1` skips the cadence gate. The Supabase edge function is not part of this path.

## What stayed on purpose

`supabase/` is the historical schema and the old provisioner. New tenants go through `neon/`. The billing service calls `neon/provision-tenant.mjs`.
