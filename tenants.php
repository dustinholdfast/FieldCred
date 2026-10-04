<?php
// FieldCred tenant registry — maps a tenant slug to its own Neon project
// (Auth URL + Data API URL). Add one entry per tenant you provision; see
// neon/README.md. These URLs are public. Never put a database password here.
//
// `domains` (optional) lists the email domains that should auto-resolve to
// this tenant — a client typing jane@acmecorp.com on the login screen
// gets switched to this tenant automatically. This is the only way to
// reach a non-default tenant now (no manual Company ID field), so set
// this for every real tenant unless you're only ever handing out a direct
// `?tenant=` link.
//
// This file is only ever read server-side by tenant-lookup.php /
// tenant-lookup-by-domain.php via `require`. Hitting it directly in a
// browser executes it as PHP with no output, so it returns an empty 200
// response rather than leaking the array — but don't rely on that alone;
// keep this file's contents to public/anon-safe values only (never a
// service_role key).

return [
    // NOTE: the fallback tenant is 'demo' (see DEFAULT_TENANT in js/lib/tenant.js).
    // A bare visit with no ?tenant= and no domain match resolves there. The old
    // 'default' tenant (Supabase project qiozckjlojvhdtrsjzfp) was retired
    // 2026-07-17.

    // 'acme' => [
    //     'name' => 'Acme Corp',
    //     'authUrl' => 'https://ep-example.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth',
    //     'dataApiUrl' => 'https://ep-example.apirest.c-6.us-east-2.aws.neon.tech/neondb/rest/v1',
    //     'domains' => ['acmecorp.com'],
    // ],
    // Demo stays unconfigured until NEON_AUTH_URL / NEON_DATA_API_URL for that
    // branch are filled in. Empty strings make the app report "not configured"
    // instead of talking to the retired Supabase project.
    'demo' => [
        'name' => "FieldCred Demo",
        'authUrl' => '',
        'dataApiUrl' => '',
    ],

];
