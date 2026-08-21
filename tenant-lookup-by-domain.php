<?php
// Resolves a tenant from an email's domain — ?email=jane@acmecorp.com
// returns { slug, name, url, anonKey } for whichever tenant claims that
// domain, or 404 if none does.
//
// Prefers the billing-service tenant_registry (written automatically on
// Stripe Checkout provisioning). Falls back to the flat tenants.php file
// so a Railway outage never becomes a total login outage.
//
// Same disclosure shape as tenant-lookup.php: only ever returns the one
// matched tenant's connection info, never the full registry.
//
// Rate-limited per IP: this is an unauthenticated existence-check across
// every known customer domain, so without a cap it's a free oracle for
// compiling the customer roster.

header('Content-Type: application/json');
header('Cache-Control: no-store');

$email = isset($_GET['email']) ? (string) $_GET['email'] : '';
$atPos = strrpos($email, '@');

if ($atPos === false || $atPos === strlen($email) - 1) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid email']);
    exit;
}

$domain = strtolower(trim(substr($email, $atPos + 1)));

if (!preg_match('/^[a-z0-9.-]{1,255}$/', $domain)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid email domain']);
    exit;
}

require __DIR__ . '/rate-limit.php';
fieldcred_rate_limit('tenant-domain-lookup', 30, 60); // 30 requests / minute / IP

// --- Primary: billing-service registry ------------------------------------
$config = @include __DIR__ . '/signup-config.php';
$billingUrl = (is_array($config) && !empty($config['billingServiceUrl']))
    ? rtrim((string) $config['billingServiceUrl'], '/')
    : '';

if ($billingUrl !== '') {
    $ch = curl_init($billingUrl . '/api/tenant-by-domain?domain=' . rawurlencode($domain));
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
            echo json_encode([
                'slug' => $data['slug'] ?? '',
                'name' => $data['name'] ?? ($data['slug'] ?? $domain),
                'url' => $data['url'],
                'anonKey' => $data['anonKey'],
            ]);
            exit;
        }
    }
    if ($curlError !== '' || $httpCode >= 500) {
        error_log('[tenant-lookup-by-domain] billing-service unreachable or errored'
            . ' — curl: ' . ($curlError !== '' ? $curlError : 'none')
            . ' — http: ' . $httpCode
            . ' — falling back to tenants.php');
    }
}

// --- Fallback: flat tenants.php -------------------------------------------
$tenants = require __DIR__ . '/tenants.php';

foreach ($tenants as $slug => $entry) {
    $domains = $entry['domains'] ?? [];
    if (in_array($domain, $domains, true)) {
        echo json_encode([
            'slug' => $slug,
            'name' => $entry['name'] ?? $slug,
            'url' => $entry['url'],
            'anonKey' => $entry['anonKey'],
        ]);
        exit;
    }
}

http_response_code(404);
echo json_encode(['error' => 'No tenant found for that email domain']);
