// Per-IP sliding window, same buckets and limits as rate-limit.php.
// Workers have no shared temp directory, so this lives in the isolate.
// A burst can exceed the cap by spreading across isolates; the PHP limiter
// was already best-effort (it fails open when the temp file cannot be locked).

const buckets = new Map();

export function resetRateLimits() {
  buckets.clear();
}

export function enforceRateLimit(ip, bucket, max, windowSeconds, now) {
  const key = `${bucket}:${ip}`;
  const prev = buckets.get(key) || [];
  const hits = prev.filter((t) => Number.isInteger(t) && t > now - windowSeconds);
  if (hits.length >= max) {
    buckets.set(key, hits);
    return { limited: true, retryAfter: windowSeconds };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { limited: false };
}
