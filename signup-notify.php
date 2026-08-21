<?php
// Handles "Request access" form submissions (js/pages/signup.js) — emails
// you (via Resend) with what a prospective client entered, so you can
// provision them by hand per supabase/PROVISIONING.md. Doesn't create
// anything itself; this is Phase 1 (manual-provisioning) self-serve, not
// automated onboarding.

header('Content-Type: application/json');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

// Rate-limited per IP: the honeypot below only stops bots that render and
// fill the HTML form; calling this endpoint directly skips it entirely.
// Without a cap, a direct POST loop can flood Resend/your inbox with no
// other limit in the way.
require __DIR__ . '/rate-limit.php';
fieldcred_rate_limit('signup', 5, 3600); // 5 requests / hour / IP

$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid request body']);
    exit;
}

// Honeypot — a real visitor never fills this in (it's hidden via CSS on
// the form); a bot filling every field usually does. Pretend success
// without sending anything, so it doesn't learn the field is a trap.
if (!empty($body['website'])) {
    echo json_encode(['ok' => true]);
    exit;
}

function cleanField($value, $maxLen) {
    $value = is_string($value) ? trim($value) : '';
    // Strip control/newline characters before anything downstream (the
    // Resend API payload, the email subject) ever sees this value. JSON
    // encoding already prevents these fields from injecting a literal
    // header break in the request we send, but stripping them here removes
    // the risk regardless of how Resend's own backend parses the subject.
    $value = preg_replace('/[\x00-\x1F\x7F]/', '', $value);
    return mb_substr($value, 0, $maxLen);
}

$companyName = cleanField($body['companyName'] ?? '', 200);
$adminEmail = cleanField($body['adminEmail'] ?? '', 200);
$domain = cleanField($body['domain'] ?? '', 255);
$note = cleanField($body['note'] ?? '', 2000);

if ($companyName === '') {
    http_response_code(400);
    echo json_encode(['error' => 'Company name is required']);
    exit;
}
if (!preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $adminEmail)) {
    http_response_code(400);
    echo json_encode(['error' => 'A valid admin email is required']);
    exit;
}
if ($domain !== '' && !preg_match('/^[a-z0-9.-]{1,255}$/i', $domain)) {
    http_response_code(400);
    echo json_encode(['error' => 'That domain doesn\'t look right']);
    exit;
}

$config = require __DIR__ . '/signup-config.php';

if (empty($config['resendApiKey']) || $config['resendApiKey'] === 'YOUR_RESEND_API_KEY') {
    // Not configured yet — fail clearly server-side (visible in logs) but
    // give the visitor a generic message rather than leaking setup state.
    http_response_code(500);
    echo json_encode(['error' => 'Signup notifications are not configured yet']);
    exit;
}

function escapeHtml($s) {
    return htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
}

$html = '<div style="font-family:sans-serif;color:#1c2430;max-width:560px;">'
    . '<h2 style="color:#0f2148;">New FieldCred signup request</h2>'
    . '<table style="width:100%;border-collapse:collapse;font-size:14px;">'
    . '<tr><td style="padding:6px 0;color:#5b6472;">Company</td><td style="padding:6px 0;font-weight:600;">' . escapeHtml($companyName) . '</td></tr>'
    . '<tr><td style="padding:6px 0;color:#5b6472;">Admin email</td><td style="padding:6px 0;font-weight:600;">' . escapeHtml($adminEmail) . '</td></tr>'
    . '<tr><td style="padding:6px 0;color:#5b6472;">Domain</td><td style="padding:6px 0;font-weight:600;">' . ($domain !== '' ? escapeHtml($domain) : '<em>not given</em>') . '</td></tr>'
    . '</table>'
    . ($note !== '' ? '<p style="color:#5b6472;"><strong>Note:</strong><br>' . nl2br(escapeHtml($note)) . '</p>' : '')
    . '<p style="margin-top:20px;font-size:11px;color:#8a919e;">Provision this in Supabase, then add an entry to tenants.php — see supabase/PROVISIONING.md.</p>'
    . '</div>';

$ch = curl_init('https://api.resend.com/emails');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => [
        // trim() is defensive, not cosmetic: a stray newline pasted into
        // signup-config.php's key ends up inside the header value, which
        // cURL rejects or Resend 401s on — and the failure looks like a
        // bad key rather than a bad paste. Cost: nothing.
        'Authorization: Bearer ' . trim((string) $config['resendApiKey']),
        'Content-Type: application/json',
    ],
    CURLOPT_POSTFIELDS => json_encode([
        'from' => $config['resendFrom'],
        'to' => $config['notifyEmail'],
        'reply_to' => $adminEmail,
        'subject' => 'FieldCred signup request: ' . $companyName,
        'html' => $html,
    ]),
    CURLOPT_TIMEOUT => 15,
]);
$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlError = curl_error($ch);
curl_close($ch);

if ($curlError || $httpCode >= 300) {
    // Log what Resend actually said. Without this the caller sees only
    // "Could not send notification email", which is the same message for a
    // bad API key (401), an unverified sending domain (403), a malformed
    // payload (422) and a network failure — four different fixes behind one
    // indistinguishable string. The response body names which. The API key
    // is never logged; it isn't in $response.
    error_log(
        '[signup-notify] Resend send failed'
        . ' — curl: ' . ($curlError !== '' ? $curlError : 'none')
        . ' — http: ' . $httpCode
        . ' — from: ' . $config['resendFrom']
        . ' — body: ' . substr((string) $response, 0, 500)
    );
    http_response_code(502);
    echo json_encode(['error' => 'Could not send notification email']);
    exit;
}

echo json_encode(['ok' => true]);
