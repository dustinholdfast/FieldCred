<?php
// FieldCred signup notification config — where "Request access" form
// submissions get emailed. Separate from any tenant's Supabase project;
// this is purely for notifying you (the operator) of a new signup request
// so you can provision it by hand per supabase/PROVISIONING.md.
//
// Also holds billingServiceUrl, which tenant-lookup.php and
// tenant-lookup-by-domain.php use as the primary registry endpoint
// (with tenants.php as the resilient fallback).
//
// Same protection pattern as tenants.php: only ever read server-side via
// `require` / `include`; hitting it directly in a browser executes it as
// PHP with no output rather than leaking the array.
//
// Get a Resend API key the same way as supabase/functions/expiration-alerts/
// SETUP.md describes (resend.com, free tier). This can be the same key or
// a separate one — either works, Resend doesn't restrict what a key can
// send from as long as the "from" address/domain is verified (or you're
// using their onboarding@resend.dev test address).

return [
    'resendApiKey' => 're_7SP4mPAH_Pm9Y82WfM7PHL3gwSR7UCPoP', // TODO: rotate if this was ever committed publicly
    'resendFrom' => 'FieldCred <onboarding@fieldcred.co>', // verify domain in Resend dashboard
    'notifyEmail' => 'dustin@fieldcred.co',
    'billingServiceUrl' => 'https://billing-service-production-783a.up.railway.app',
];
