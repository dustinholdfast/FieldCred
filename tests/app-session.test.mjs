import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setAppSession, subscribeAppSession } from '../js/lib/auth.js';

test('app session listeners hear sign-in and sign-out on this tab', () => {
  const seen = [];
  const stop = subscribeAppSession((session) => seen.push(session));
  setAppSession({ user: { id: 'user-1' } });
  setAppSession(null);
  stop();
  setAppSession({ user: { id: 'ignored' } });
  assert.deepEqual(seen, [{ user: { id: 'user-1' } }, null]);
});
