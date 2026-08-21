<?php
// Per-IP rate limiter for the public PHP endpoints (signup-notify.php,
// tenant-lookup*.php). The signup honeypot stops naive bots, but nothing
// else caps how fast a determined caller can hit these endpoints. This adds
// a simple per-IP, sliding-window cap backed by the temp dir — no database,
// no dependencies. Wired into signup-notify.php, tenant-lookup.php, and
// tenant-lookup-by-domain.php — see each file's own call site.
//
// The whole read-prune-count-write sequence runs inside a single flock()
// critical section on one open file handle, so concurrent requests from the
// same IP can't all read the same pre-update hit count and all squeak
// through — previously this used separate file_get_contents/
// file_put_contents calls with no lock, which raced under concurrency.
//
// Usage: require this file, then call fieldcred_rate_limit($bucket, $max,
// $windowSeconds) — it sends a 429 (JSON) and exits when the caller is over
// the limit, or returns normally when under it.

function fieldcred_rate_limit($bucket, $max, $windowSeconds) {
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $dir = sys_get_temp_dir() . '/fieldcred-rl';
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }
    $file = $dir . '/' . preg_replace('/[^a-z0-9_-]/i', '', $bucket) . '-' . md5($ip) . '.json';
    $now = time();

    $fh = @fopen($file, 'c+');
    if ($fh === false) {
        // Can't open the counter file (e.g. permissions) — fail open rather
        // than blocking every request on a filesystem problem; this is a
        // best-effort throttle, not the only defense.
        return;
    }

    if (!flock($fh, LOCK_EX)) {
        fclose($fh);
        return;
    }

    $contents = stream_get_contents($fh);
    $decoded = json_decode($contents, true);
    $hits = is_array($decoded) ? $decoded : [];

    // Keep only timestamps inside the current window.
    $hits = array_values(array_filter($hits, function ($t) use ($now, $windowSeconds) {
        return is_int($t) && $t > $now - $windowSeconds;
    }));

    if (count($hits) >= $max) {
        flock($fh, LOCK_UN);
        fclose($fh);
        header('Content-Type: application/json');
        header('Retry-After: ' . $windowSeconds);
        http_response_code(429);
        echo json_encode(['error' => 'Too many requests — please try again later.']);
        exit;
    }

    $hits[] = $now;
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($hits));
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
}
