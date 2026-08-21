<?php
// Resolves a tenant from an email's domain — ?email=jane@acmecorp.com
// returns { slug, name, url, anonKey } for whichever tenant in
// tenants.php lists "acmecorp.com" in its domains array, or 404 if no
// tenant claims that domain. Used by the login page so a client can type
// their work email instead of needing to know a Company ID slug.
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
