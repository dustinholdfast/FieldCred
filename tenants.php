<?php
// FieldCred tenant registry — maps a tenant slug to its own Supabase
// project (URL + anon key). Add one entry per tenant you provision; see
// supabase/PROVISIONING.md for the full checklist.
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
    //     'url' => 'https://xxxxxxxxxxxxxxxx.supabase.co',
    //     'anonKey' => 'eyJ...',
    //     'domains' => ['acmecorp.com'],
    // ],
    'demo' => [
        'name' => "FieldCred Demo",
        'url' => 'https://kaktjqbbijyjejulbpgy.supabase.co',
        'anonKey' => "sb_publishable_rdzQYMIOkkFvkcOCOqIW3Q_RV_DAJZo",
    ],

];
