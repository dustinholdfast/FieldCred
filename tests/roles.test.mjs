import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES,
  normalizeRole,
  roleFromSession,
  roleLabel,
  roleCan,
  isPermissionError,
} from '../js/lib/roles.js';

// --- normalizeRole: unknown/absent -> admin (the deploy-safe default) ---

test('normalizeRole passes through the three known roles', () => {
  for (const r of ROLES) assert.equal(normalizeRole(r), r);
});

test('normalizeRole falls back to admin for absent/unknown/empty values', () => {
  assert.equal(normalizeRole(undefined), 'admin');
  assert.equal(normalizeRole(null), 'admin');
  assert.equal(normalizeRole(''), 'admin');
  assert.equal(normalizeRole('superuser'), 'admin');
  assert.equal(normalizeRole('SAFETY'), 'admin'); // case-sensitive by design
});

// --- roleFromSession: reads app_metadata.fc_role, defaults to admin ---

test('roleFromSession reads fc_role from app_metadata', () => {
  const session = { user: { app_metadata: { fc_role: 'safety' } } };
  assert.equal(roleFromSession(session), 'safety');
});

test('roleFromSession defaults to admin for an existing user with no fc_role', () => {
  assert.equal(roleFromSession({ user: { app_metadata: {} } }), 'admin');
  assert.equal(roleFromSession({ user: {} }), 'admin');
});

test('roleFromSession defaults to admin for a null/undefined session', () => {
  assert.equal(roleFromSession(null), 'admin');
  assert.equal(roleFromSession(undefined), 'admin');
});

test('roleFromSession ignores an unknown fc_role and falls back to admin', () => {
  assert.equal(roleFromSession({ user: { app_metadata: { fc_role: 'root' } } }), 'admin');
});

// --- roleCan: the capability matrix (mirror of the RLS policies) ---

test('admin can do everything in the matrix', () => {
  for (const cap of [
    'viewDirectory', 'viewSites', 'viewAdmin',
    'editWorkers', 'deleteWorkers',
    'manageSites', 'manageCredentialTypes', 'editTenantSettings', 'manageUsers',
  ]) {
    assert.equal(roleCan('admin', cap), true, `admin should have ${cap}`);
  }
});

test('safety can edit workers but not delete them or manage the tenant', () => {
  assert.equal(roleCan('safety', 'editWorkers'), true);
  assert.equal(roleCan('safety', 'viewSites'), true);
  assert.equal(roleCan('safety', 'viewAdmin'), true);
  assert.equal(roleCan('safety', 'deleteWorkers'), false);
  assert.equal(roleCan('safety', 'manageSites'), false);
  assert.equal(roleCan('safety', 'manageCredentialTypes'), false);
  assert.equal(roleCan('safety', 'editTenantSettings'), false);
  assert.equal(roleCan('safety', 'manageUsers'), false);
});

test('gate is read-only: directory only, no edits, no sites/admin', () => {
  assert.equal(roleCan('gate', 'viewDirectory'), true);
  assert.equal(roleCan('gate', 'viewSites'), false);
  assert.equal(roleCan('gate', 'viewAdmin'), false);
  assert.equal(roleCan('gate', 'editWorkers'), false);
  assert.equal(roleCan('gate', 'deleteWorkers'), false);
});

test('an unknown role is treated as admin (normalized) — matches the DB default', () => {
  assert.equal(roleCan('mystery', 'deleteWorkers'), true);
  assert.equal(roleCan(undefined, 'editTenantSettings'), true);
});

test('an unknown capability is denied for every role', () => {
  for (const r of ROLES) assert.equal(roleCan(r, 'launchMissiles'), false);
});

test('roleLabel gives a human label, defaulting for unknowns', () => {
  assert.equal(roleLabel('admin'), 'Admin');
  assert.equal(roleLabel('safety'), 'Safety');
  assert.equal(roleLabel('gate'), 'Gate');
  assert.equal(roleLabel('nope'), 'Admin');
});

// --- isPermissionError: recognizing an RLS denial ---

test('isPermissionError recognizes a Postgres 42501 / 403 RLS denial', () => {
  assert.equal(isPermissionError({ code: '42501' }), true);
  assert.equal(isPermissionError({ status: 403 }), true);
  assert.equal(isPermissionError({ statusCode: 403 }), true);
  assert.equal(
    isPermissionError({ message: 'new row violates row-level security policy for table "workers"' }),
    true
  );
});

test('isPermissionError is false for unrelated errors and falsy input', () => {
  assert.equal(isPermissionError(null), false);
  assert.equal(isPermissionError(undefined), false);
  assert.equal(isPermissionError({ message: 'network timeout' }), false);
  assert.equal(isPermissionError({ code: '23505' }), false); // unique_violation
});

// Regression: a missing GRANT is a permission error too, not a network blip.
//
// Postgres raises 42501 with "permission denied for function …" when a role
// was never granted execute — distinct from a failing RLS policy, identical
// in consequence. Found against the demo tenant on 2026-07-20, where
// search_site_roster had no anon grant and the gate app reported it to guards
// as a connection failure they could retry their way out of. It could not.
test('a missing grant is recognized as a permission error', () => {
  assert.equal(isPermissionError({ code: '42501', message: 'permission denied for function search_site_roster' }), true);
  // Message alone must be enough — js/lib/state.js historically threw a bare
  // Error and dropped the code entirely.
  assert.equal(isPermissionError({ message: 'permission denied for function search_site_roster' }), true);
  assert.equal(isPermissionError({ message: 'permission denied for table gate_scans' }), true);
});

test('an ordinary network failure is not a permission error', () => {
  assert.equal(isPermissionError({ message: 'Failed to fetch' }), false);
  assert.equal(isPermissionError(new Error('NetworkError when attempting to fetch resource.')), false);
  assert.equal(isPermissionError(null), false);
});
