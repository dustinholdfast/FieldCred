#!/usr/bin/env bash
# Synthetic checks against the live app. Run by .github/workflows/monitor.yml on
# a schedule, and runnable by hand:
#
#   bash scripts/monitor.sh
#   BASE_URL=https://app.fieldcred.co MONITOR_TOKEN=... DEEP=1 bash scripts/monitor.sh
#
# Nothing here sends a real email or touches tenant data. The signup check
# posts an empty form, which the Worker rejects before calling Resend. The deep
# check (DEEP=1 plus MONITOR_TOKEN) asks the Worker to send one message to
# Resend's test inbox, which proves the API key and sending domain still work.
#
# Exits non-zero if any check fails, so a scheduled run fails and GitHub emails
# the repo owner.

set -u

BASE_URL="${BASE_URL:-https://app.fieldcred.co}"
DEEP="${DEEP:-0}"
MONITOR_TOKEN="${MONITOR_TOKEN:-}"

failures=0
body_file="$(mktemp)"
headers_file="$(mktemp)"
trap 'rm -f "$body_file" "$headers_file"' EXIT

pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  [ -n "${GITHUB_ACTIONS:-}" ] && printf '::error title=Monitor::%s\n' "$1"
  failures=$((failures + 1))
}
warn() {
  printf 'warn  %s\n' "$1"
  [ -n "${GITHUB_ACTIONS:-}" ] && printf '::warning title=Monitor::%s\n' "$1"
}

# request METHOD PATH [JSON_BODY] [AUTH_HEADER] -> prints the HTTP status
request() {
  local args=(-s -m 30 -o "$body_file" -D "$headers_file" -w '%{http_code}' -X "$1")
  [ -n "${3:-}" ] && args+=(-H 'Content-Type: application/json' --data "$3")
  [ -n "${4:-}" ] && args+=(-H "$4")
  curl "${args[@]}" "$BASE_URL$2" || printf '000'
}

expect() { # expect NAME WANT_STATUS GOT_STATUS [BODY_REGEX]
  if [ "$3" != "$2" ]; then
    fail "$1: expected HTTP $2, got $3 ($(head -c 200 "$body_file"))"
  elif [ -n "${4:-}" ] && ! grep -qE "$4" "$body_file"; then
    fail "$1: HTTP $2 but body did not match /$4/ ($(head -c 200 "$body_file"))"
  else
    pass "$1"
  fi
}

status=$(request GET /)
expect "app shell loads" 200 "$status" '<div id="app">'

if grep -qi '^permissions-policy:.*camera=(self)' "$headers_file"; then
  pass "camera allowed for the gate scanner"
else
  fail "Permissions-Policy does not allow camera=(self); the gate scanner is disabled"
fi

status=$(request GET /js/main.js)
expect "app bundle loads" 200 "$status"

status=$(request GET '/tenant-lookup.php?tenant=demo')
expect "tenant lookup answers" 200 "$status" '"dataApiUrl"'

status=$(request POST /directory-search.php '{"tenant":"demo","question":"monitor"}')
expect "directory search requires sign-in" 401 "$status" 'Sign in required'

status=$(request POST /signup-notify.php '{}')
expect "signup endpoint validates input" 400 "$status" 'Company name is required'

status=$(request GET /api/health)
if [ "$status" = 404 ]; then
  warn "/api/health is not deployed yet"
else
  expect "Worker health checks pass" 200 "$status" '"ok":true'
fi

if [ "$DEEP" = 1 ]; then
  if [ -z "$MONITOR_TOKEN" ]; then
    warn "deep check skipped: MONITOR_TOKEN is not set"
  else
    status=$(request POST /api/health/email '' "Authorization: Bearer $MONITOR_TOKEN")
    if [ "$status" = 404 ]; then
      warn "email check skipped: MONITOR_TOKEN is not set on the Worker, or the route is not deployed"
    else
      expect "Resend accepts mail from the sending domain" 200 "$status" '"ok":true'
    fi
  fi
fi

if [ "$failures" -gt 0 ]; then
  printf '\n%d check(s) failed against %s\n' "$failures" "$BASE_URL"
  exit 1
fi
printf '\nall checks passed against %s\n' "$BASE_URL"
