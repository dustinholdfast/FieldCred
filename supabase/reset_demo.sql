-- FieldCred — reset the demo tenant back to a clean slate.
-- Run in the SQL Editor of the fieldcred-demo project (NEVER a real
-- tenant), THEN run seed_demo.sql as a separate query right after (SQL
-- Editor doesn't support psql's \i, so this can't chain to it directly).
--
-- seed_demo.sql alone is not a reset: it uses "on conflict do nothing" so
-- pre-existing rows survive untouched, meaning anything an admin
-- edited/added/deleted through the app since the last reset stays that
-- way. This clears the table first so the re-seed actually starts clean.

delete from public.workers;
