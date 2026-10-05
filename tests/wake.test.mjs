import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isTransientWakeError, isWakeStopped, withWakeRetry, WAKE_BUDGET_MS } from '../js/lib/wake.js';

function err(fields) {
  const error = new Error(fields.message || 'failed');
  Object.assign(error, fields);
  return error;
}

test('42501 and 401/403 are not retried', async () => {
  for (const failure of [
    err({ code: '42501', status: 403, message: 'permission denied for table workers' }),
    err({ code: '42501', status: 401, message: 'permission denied for table workers' }),
    err({ status: 401, message: 'Invalid email or password' }),
    err({ status: 403, message: 'forbidden' }),
  ]) {
    let calls = 0;
    let waiting = 0;
    await assert.rejects(
      () => withWakeRetry(() => {
        calls += 1;
        throw failure;
      }, { timeoutMs: 0, onWaiting() { waiting += 1; } }),
      (caught) => caught === failure,
    );
    assert.equal(calls, 1);
    assert.equal(waiting, 0);
    assert.equal(isTransientWakeError(failure), false);
  }
});

test('a 503 then a success shows one waiting callback and returns the value', async () => {
  const sleeps = [];
  let t = 0;
  let calls = 0;
  let waiting = 0;
  const value = await withWakeRetry(() => {
    calls += 1;
    if (calls === 1) throw err({ status: 503, code: 'PGRST000', message: 'Could not connect with the database' });
    return 'workers';
  }, {
    timeoutMs: 0,
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    onWaiting() { waiting += 1; },
  });
  assert.equal(value, 'workers');
  assert.equal(calls, 2);
  assert.equal(waiting, 1);
  assert.deepEqual(sleeps, [1000]);
});

test('Neon cold-start shapes are retried and a hard failure stops at the budget', async () => {
  const failures = [
    err({ status: 500, code: 'XX000', message: "Couldn't connect to compute node" }),
    err({ status: 500, code: '57P01', message: 'terminating connection due to administrator command' }),
    err({ status: 503, code: '08006', message: 'connection failure' }),
    err({ status: 0, message: 'TypeError: Failed to fetch' }),
    err({ status: 504, code: 'PGRST003', message: 'timeout' }),
    err({ message: 'the database system is starting up', code: '57P03' }),
  ];
  for (const failure of failures) assert.equal(isTransientWakeError(failure), true, failure.message);

  const sleeps = [];
  let t = 0;
  let calls = 0;
  await assert.rejects(
    () => withWakeRetry(() => {
      calls += 1;
      throw err({ status: 503, code: 'PGRST000', message: 'Could not connect with the database' });
    }, {
      timeoutMs: 0,
      budgetMs: WAKE_BUDGET_MS,
      now: () => t,
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
    }),
  );
  assert.ok(calls >= 3);
  assert.ok(sleeps.reduce((sum, ms) => sum + ms, 0) <= WAKE_BUDGET_MS);
  assert.ok(sleeps.reduce((sum, ms) => sum + ms, 0) >= 20000);
});

test('a roster rate limit is not treated as a cold start', () => {
  assert.equal(isTransientWakeError(err({
    status: 500,
    code: '55000',
    message: 'roster lookup rate limit exceeded for this site — try again shortly',
  })), false);
});

test('navigating away stops the retry loop', async () => {
  let current = true;
  await assert.rejects(
    () => withWakeRetry(() => {
      current = false;
      throw err({ status: 503, message: 'unavailable' });
    }, {
      timeoutMs: 0,
      isCurrent: () => current,
      sleep: async () => { throw new Error('should not sleep'); },
    }),
    (caught) => isWakeStopped(caught),
  );
});

test('directory, gate, and scan load through the shared helper', () => {
  const directory = readFileSync(new URL('../js/pages/directory.js', import.meta.url), 'utf8');
  const gate = readFileSync(new URL('../js/pages/gateConfig.js', import.meta.url), 'utf8');
  const scan = readFileSync(new URL('../js/pages/scan.js', import.meta.url), 'utf8');
  const gateApp = readFileSync(new URL('../js/pages/gateApp.js', import.meta.url), 'utf8');
  const record = readFileSync(new URL('../js/lib/gateVerdict.js', import.meta.url), 'utf8');
  for (const source of [directory, gate, scan, gateApp, record]) {
    assert.match(source, /withWakeRetry/);
  }
  assert.doesNotMatch(directory, /Couldn't load the directory: \$\{/);
  assert.match(directory, /You don't have access to the worker directory/);
});
