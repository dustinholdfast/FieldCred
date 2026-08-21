-- Migration 003 — fix mutable search_path on public functions
-- Apply to tenants provisioned before this change. Safe to re-run.
-- Fresh projects get this automatically via schema.sql (kept in sync).
--
-- Supabase's security advisor flags a function with no fixed search_path
-- as a risk: without one, the function resolves unqualified names against
-- whatever search_path the calling session has, which a sufficiently
-- privileged caller could manipulate. All three functions already only
-- reference explicitly schema-qualified (public.*) tables, so this is
-- defense-in-depth rather than a fix for an active bug — but it's what
-- clears the advisor warning and is one line per function to add.

create or replace function public.set_updated_at()
returns trigger language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.enforce_worker_limit()
returns trigger language plpgsql
set search_path = public
as $$
declare
  cap int;
  current_count int;
begin
  select max_workers into cap from public.plan_limits where id = 1;
  if cap is null then
    return new;
  end if;

  select count(*) into current_count from public.workers;
  if current_count >= cap then
    raise exception 'Worker limit reached — this plan allows up to % active workers.', cap;
  end if;

  return new;
end;
$$;

create or replace function public.safe_to_date(txt text)
returns date language plpgsql immutable
set search_path = public
as $$
begin
  return txt::date;
exception when others then
  return null;
end;
$$;
