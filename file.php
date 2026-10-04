<?php
// Streams a file stored in the tenant's Neon database (public.files).
//
// Public buckets (photos, badges, logos): anonymous Data API RPC
// get_public_file. Same exposure as the old public storage URL.
// Certificates: ?token= from create_file_grant(), redeemed by
// redeem_file_grant(). The token is the secret; it expires.
//
// No database password lives here. The Auth URL and Data API URL are the
// same public values tenant-lookup.php already returns.

header('X-Content-Type-Options: nosniff');
header('Cache-Control: private, max-age=60');

$tenant = isset($_GET['tenant']) ? (string) $_GET['tenant'] : '';
$bucket = isset($_GET['bucket']) ? (string) $_GET['bucket'] : '';
$path = isset($_GET['path']) ? (string) $_GET['path'] : '';
$token = isset($_GET['token']) ? (string) $_GET['token'] : '';

if (!preg_match('/^[a-z0-9-]{1,64}$/', $tenant)) {
    http_response_code(400);
    exit;
}

$endpoints = fieldcred_file_endpoints($tenant);
if ($endpoints === null) {
    http_response_code(404);
    exit;
}

if ($token !== '') {
    if (!preg_match('/^[a-f0-9]{16,128}$/', $token)) {
        http_response_code(400);
        exit;
    }
    $row = fieldcred_data_api($endpoints, 'redeem_file_grant', ['p_token' => $token]);
} else {
    if (!in_array($bucket, ['photos', 'badges', 'logos'], true)) {
        http_response_code(404);
        exit;
    }
    if (!preg_match('/^[A-Za-z0-9._-]{1,200}$/', $path)) {
        http_response_code(400);
        exit;
    }
    $row = fieldcred_data_api($endpoints, 'get_public_file', [
        'p_bucket' => $bucket,
        'p_path' => $path,
    ]);
}

if ($row === null) {
    http_response_code(404);
    exit;
}

$allowed = [
    'image/jpeg' => true,
    'image/png' => true,
    'image/webp' => true,
    'image/gif' => true,
    'application/pdf' => true,
];
$type = isset($row['content_type']) ? (string) $row['content_type'] : 'application/octet-stream';
if (!isset($allowed[$type])) {
    $type = 'application/octet-stream';
    header('Content-Disposition: attachment');
}
$bytes = base64_decode((string) ($row['data'] ?? ''), true);
if ($bytes === false) {
    http_response_code(502);
    exit;
}
header('Content-Type: ' . $type);
header('Content-Length: ' . strlen($bytes));
echo $bytes;

function fieldcred_file_endpoints($slug) {
    $cache = sys_get_temp_dir() . '/fc-file-tenant-' . $slug . '.json';
    if (is_file($cache) && (time() - filemtime($cache)) < 60) {
        $cached = json_decode((string) file_get_contents($cache), true);
        if (is_array($cached) && !empty($cached['authUrl']) && !empty($cached['dataApiUrl'])) {
            return $cached;
        }
    }

    $found = null;
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
        curl_close($ch);
        if ($httpCode === 200 && is_string($body) && $body !== '') {
            $data = json_decode($body, true);
            if (is_array($data) && !empty($data['authUrl']) && !empty($data['dataApiUrl'])) {
                $found = ['authUrl' => $data['authUrl'], 'dataApiUrl' => $data['dataApiUrl']];
            }
        }
    }

    if ($found === null) {
        $tenants = require __DIR__ . '/tenants.php';
        $entry = $tenants[$slug] ?? null;
        if (is_array($entry) && !empty($entry['authUrl']) && !empty($entry['dataApiUrl'])) {
            $found = ['authUrl' => $entry['authUrl'], 'dataApiUrl' => $entry['dataApiUrl']];
        }
    }

    if ($found !== null) {
        @file_put_contents($cache, json_encode($found));
    }
    return $found;
}

function fieldcred_data_api($endpoints, $fn, $args) {
    $token = fieldcred_anonymous_token($endpoints['authUrl']);
    if ($token === null) return null;
    $url = rtrim($endpoints['dataApiUrl'], '/') . '/rpc/' . $fn;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'Accept: application/json',
            'Authorization: Bearer ' . $token,
        ],
        CURLOPT_POSTFIELDS => json_encode($args),
    ]);
    $body = curl_exec($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($httpCode !== 200 || !is_string($body) || $body === '') return null;
    $data = json_decode($body, true);
    if (is_array($data) && array_is_list($data)) {
        $data = $data[0] ?? null;
    }
    if (!is_array($data) || !isset($data['data'])) return null;
    return $data;
}

function fieldcred_anonymous_token($authUrl) {
    $key = sys_get_temp_dir() . '/fc-anon-token-' . md5($authUrl) . '.json';
    if (is_file($key)) {
        $cached = json_decode((string) file_get_contents($key), true);
        if (is_array($cached) && !empty($cached['token']) && ($cached['exp'] ?? 0) > time() + 15) {
            return $cached['token'];
        }
    }
    $ch = curl_init(rtrim($authUrl, '/') . '/token/anonymous');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
    ]);
    $body = curl_exec($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($httpCode !== 200 || !is_string($body)) return null;
    $data = json_decode($body, true);
    $token = is_array($data) ? ($data['token'] ?? null) : null;
    if (!is_string($token) || $token === '') return null;
    @file_put_contents($key, json_encode(['token' => $token, 'exp' => time() + 240]));
    return $token;
}
