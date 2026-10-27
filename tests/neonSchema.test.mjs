import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const schema = readFileSync(new URL('../neon/schema.sql', import.meta.url), 'utf8');

test('Neon schema does not depend on Supabase storage or JWT app_metadata', () => {
  assert.equal(schema.includes('storage.objects'), false);
  assert.equal(schema.includes('auth.jwt'), false);
  assert.equal(schema.includes('supabase'), false);
});

test('Neon schema grants the Data API anonymous role and stores staff roles in Postgres', () => {
  assert.match(schema, /staff_roles/);
  assert.match(schema, /auth\.user_id\(\)/);
  assert.match(schema, /to anonymous/);
  assert.match(schema, /upload_file/);
  assert.match(schema, /get_public_file/);
});
