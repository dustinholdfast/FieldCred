<?php
// Returns { name, url, anonKey } for a given ?tenant=slug.
//
// Prefers the billing-service tenant_registry (written automatically on
// Stripe Checkout provisioning). Falls back to the flat tenants.php file
// so a Railway outage never becomes a total login outage for every tenant.
// That fallback is deliberate and load-bearing — see billing-service/README.md
// and routes/tenants.mjs.
//
// Never returns the full registry — only the one tenant that was asked for.
// Response fields are an explicit whitelist so a future field added to a
// registry entry doesn't automatically become public.
//
// Rate-limited per IP: this is an unauthenticated slug lookup, so without a
// cap it's a free oracle for brute-forcing which tenant slugs exist.

header('Content-Type: application/json');
header('Cache-Control: no-store');

$slug = isset($_GET['tenant']) ? (string) $_GET['tenant'] : '';

if (!preg_match('/^[a-z0-9-]{1,64}$/', $slug)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid tenant slug']);
    exit;
}

require __DIR__ . '/rate-limit.php';
fieldcred_rate_limit('tenant-lookup', 30, 60); // 30 requests / minute / IP

// --- Primary: billing-service registry ------------------------------------
$config = @include __DIR__ . '/signup-config.php';
$billingUrl = (is_array($config) && !empty($config['billingServiceUrl']))
    ? rtrim((string) $config['billingServiceUrl'], '/')
    : '';

if ($billingUrl !== '') {
    $ch = curl_init($billingUrl . '/api/tenant/' . rawurlencode($slug));
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 3,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
    ]);
    $body = curl_exec($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($curlError === '' && $httpCode === 200 && is_string($body) && $body !== '') {
        $data = json_decode($body, true);
        if (is_array($data) && !empty($data['url']) && !empty($data['anonKey'])) {
            // Key names match what js/lib/supabaseClient.js already expects.
            // Billing service returns { url, anonKey, slug }; name is optional.
            echo json_encode([
                'name' => $data['name'] ?? ($data['slug'] ?? $slug),
                'url' => $data['url'],
                'anonKey' => $data['anonKey'],
            ]);
            exit;
        }
    }
    // Non-200, network error, or malformed body → fall through to flat file.
    // Do not log the full response body (could contain unexpected fields).
    if ($curlError !== '' || $httpCode >= 500) {
        error_log('[tenant-lookup] billing-service unreachable or errored'
            . ' — curl: ' . ($curlError !== '' ? $curlError : 'none')
            . ' — http: ' . $httpCode
            . ' — falling back to tenants.php');
    }
}

// --- Fallback: flat tenants.php -------------------------------------------
$tenants = require __DIR__ . '/tenants.php';

if (!isset($tenants[$slug])) {
    http_response_code(404);
    echo json_encode(['error' => 'Unknown tenant']);
    exit;
}

$entry = $tenants[$slug];
echo json_encode([
    'name' => $entry['name'] ?? $slug,
    'url' => $entry['url'],
    'anonKey' => $entry['anonKey'],
]);
