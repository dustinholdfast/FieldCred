<?php
// Returns { name, url, anonKey } for a given ?tenant=slug, looked up from
// tenants.php. Never returns the full registry — only the one tenant
// that was asked for, and only if the slug matches a known entry. Response
// fields are an explicit whitelist (not the raw stored record) so a future
// field added to a tenants.php entry (internal notes, contact info) doesn't
// automatically become public through this endpoint with no code change
// here — same shape as tenant-lookup-by-domain.php's response.
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
