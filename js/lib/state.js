// Supabase-backed data access. Methods are async (network calls) — every
// call site awaits them. See supabase/schema.sql for the table/RLS/storage
// setup this expects: `workers` (contact info, authenticated-only) and the
// `public_workers` view (safe subset, public) that getBySlug() reads from.

import { supabase } from './supabaseClient.js';

export function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function slugify(name) {
  const parts = (name || 'worker').trim().toLowerCase().split(/\s+/);
  const last = parts[parts.length - 1] || 'worker';
  const initial = parts.length > 1 ? parts[0][0] : '';
  return `${initial}${last}`.replace(/[^a-z0-9]/g, '') || 'worker';
}

function makeSlug(name) {
  return `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyCert() {
  return {
    id: makeId(),
    name: '',
    issuer: '',
    typeId: null, // -> credential_types.id; how a free-text cert matches a site's required types (see migration 007)
    badgeImageUrl: null,
    certificateFileUrl: null,
    earnedDate: '',
    expiryDate: '',
    // ---- Verification (see js/lib/verification.js) ----
    verificationUrl: '', // legacy free-text link; still used when verificationSource is '' or not NCCER/OSHA
    verificationSource: '', // '' | 'NCCER' | 'OSHA' — picks a fixed canonical portal over the free-text URL above
    cardNumber: '', // card/cert # staff type into that portal by hand to check it
    verified: false, // an admin actually checked the portal above and confirmed it — never inferred, always a deliberate action
    verifiedBy: null, // signed-in admin's email at the moment they checked the box
    verifiedAt: null, // ISO timestamp; cleared automatically if source or card # changes after verifying (see editProfile.js)
  };
}

function rowToWorker(row) {
  return {
    id: row.id,
    name: row.name || '',
    title: row.title || '',
    department: row.department || '',
    location: row.location || '',
    phone: row.phone || '',
    email: row.email || '',
    photoUrl: row.photo_url || null,
    skills: row.skills || [],
    certifications: row.certifications || [],
    publicViewEnabled: row.public_view_enabled ?? true,
    publicSlug: row.public_slug,
    linkExpires: row.link_expires || 'never',
    // Only present on the public_workers view (getBySlug) — used for the
    // "record updated <date>" freshness stamp on the public page.
    updatedAt: row.updated_at || null,
  };
}

const FIELD_MAP = {
  name: 'name',
  title: 'title',
  department: 'department',
  location: 'location',
  phone: 'phone',
  email: 'email',
  photoUrl: 'photo_url',
  skills: 'skills',
  certifications: 'certifications',
  publicViewEnabled: 'public_view_enabled',
  linkExpires: 'link_expires',
};

function workerToRow(data) {
  const row = {};
  for (const [jsKey, column] of Object.entries(FIELD_MAP)) {
    if (jsKey in data) row[column] = data[jsKey];
  }
  return row;
}

function siteRow(r) {
  return {
    id: r.id,
    name: r.name || '',
    location: r.location || '',
    active: r.active ?? true,
    publicSlug: r.public_slug,
  };
}

// Rethrows a Supabase/PostgREST error as a real Error, PRESERVING the
// diagnostic fields. Dropping them (as this used to) meant
// js/lib/roles.js's isPermissionError() could never match code 42501 —
// every permission denial reached call sites as an anonymous failure
// indistinguishable from "no signal", so a revoked grant showed up in the UI
// as a connection problem. Found 2026-07-20 against the demo tenant, where
// search_site_roster's anon grant was missing and the gate app blamed the
// network for it.
function throwIfError(error) {
  if (!error) return;
  const err = new Error(error.message || 'Request failed');
  if (error.code) err.code = error.code;
  if (error.details) err.details = error.details;
  if (error.hint) err.hint = error.hint;
  if (error.status ?? error.statusCode) err.status = error.status ?? error.statusCode;
  throw err;
}

export const store = {
  async getAll() {
    const { data, error } = await supabase.from('workers').select('*').order('name');
    throwIfError(error);
    return (data || []).map(rowToWorker);
  },

  // Count-only — for the plan-cap pre-check, which needs a number, not the
  // whole table (getAll pulls every worker with every column). `head: true`
  // fetches no rows, just the count, so this stays cheap as a tenant grows.
  async countWorkers() {
    const { count, error } = await supabase.from('workers').select('id', { count: 'exact', head: true });
    throwIfError(error);
    return count ?? 0;
  },

  async getById(id) {
    const { data, error } = await supabase.from('workers').select('*').eq('id', id).maybeSingle();
    throwIfError(error);
    return data ? rowToWorker(data) : null;
  },

  // Public, unauthenticated-safe lookup — reads the `public_workers` view,
  // which omits phone/email and only returns rows with public sharing on.
  async getBySlug(slug) {
    const { data, error } = await supabase.from('public_workers').select('*').eq('public_slug', slug).maybeSingle();
    throwIfError(error);
    return data ? rowToWorker(data) : null;
  },

  // Public, unauthenticated-safe site lookup for the gate — calls the
  // get_public_site SECURITY DEFINER function (migration 008), the only anon
  // path to site data (there's no site list to enumerate). Returns null for an
  // unknown or inactive slug (fail-closed: the gate can't clear against it).
  async getPublicSite(slug) {
    const { data, error } = await supabase.rpc('get_public_site', { slug });
    throwIfError(error);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return { id: row.id, name: row.name, publicSlug: row.public_slug, requiredTypes: row.required_types || [] };
  },

  // Public, unauthenticated-safe roster search for the gate companion app's
  // "look up by name" screen (js/pages/gateApp.js) — the fallback when a
  // badge is damaged or left in the truck. Calls search_site_roster
  // (migration 011), which is scoped to ONE active site's assigned workers
  // and returns name/title/department/slug only.
  //
  // This is the only anon-reachable roster enumeration in the app; the
  // exposure trade is written up in full in migration 011. Note the server
  // requires >= 2 characters — the short-circuit below just saves a round
  // trip on every keystroke, it is not the enforcement.
  async searchSiteRoster(siteSlug, query) {
    const term = (query || '').trim();
    if (!siteSlug || term.length < 2) return [];
    const { data, error } = await supabase.rpc('search_site_roster', { p_site_slug: siteSlug, p_query: term });
    throwIfError(error);
    return (data || []).map((r) => ({
      publicSlug: r.public_slug,
      name: r.name || '',
      title: r.title || '',
      department: r.department || '',
    }));
  },

  // Distinct department names for the profile-form dropdown. Selects only
  // the one column rather than pulling every worker row in full (skills,
  // certifications jsonb, etc.) just to derive a short list.
  async departments() {
    const { data, error } = await supabase.from('workers').select('department').order('department');
    throwIfError(error);
    return [...new Set((data || []).map((r) => r.department).filter(Boolean))].sort();
  },

  async createWorker(data) {
    const row = workerToRow(data);
    row.public_slug = makeSlug(data.name);
    const { data: inserted, error } = await supabase.from('workers').insert(row).select().single();
    throwIfError(error);
    return rowToWorker(inserted);
  },

  // Bulk create from CSV import — one insert request for the whole batch
  // rather than N round trips. Each entry is a plain worker-shaped object
  // (name/title/department/location/phone/email/skills); dedup against
  // existing workers is the caller's job (the import dialog does it before
  // calling this, so it can report back which rows were skipped and why).
  async bulkCreateWorkers(entries) {
    if (!entries.length) return [];
    const rows = entries.map((data) => {
      const row = workerToRow(data);
      row.public_slug = makeSlug(data.name);
      return row;
    });
    const { data: inserted, error } = await supabase.from('workers').insert(rows).select();
    throwIfError(error);
    return (inserted || []).map(rowToWorker);
  },

  async updateWorker(id, data) {
    const row = workerToRow(data);
    const { data: updated, error } = await supabase.from('workers').update(row).eq('id', id).select().single();
    throwIfError(error);
    return rowToWorker(updated);
  },

  async deleteWorker(id) {
    const { error } = await supabase.from('workers').delete().eq('id', id);
    throwIfError(error);
  },

  async setPublicView(id, enabled) {
    return this.updateWorker(id, { publicViewEnabled: enabled });
  },

  // Uploads a file to Storage. bucket: 'photos' | 'badges' | 'certificates'.
  // photos/badges are public buckets — returns a public URL, usable directly
  // as an <img>/<a> src forever. certificates is a private bucket (see
  // supabase/migrations/002_public_record_freshness_and_link_expiry.sql) —
  // getPublicUrl() would return a URL that always 401s regardless of who's
  // asking, so this returns the bare storage path instead; callers must
  // exchange it for a signed URL via getCertificateSignedUrl() at open-time.
  async uploadImage(bucket, file) {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${makeId()}.${ext}`;
    const { error } = await supabase.storage.from(bucket).upload(path, file, { upsert: true, cacheControl: '3600' });
    throwIfError(error);
    if (bucket === 'certificates') return path;
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  },

  // Short-lived signed URL for a private certificate object. Requires an
  // authenticated session — RLS on storage.objects only grants the
  // 'authenticated' role read access to the certificates bucket.
  //
  // certificateFileUrl values saved before this fix are full (broken)
  // public-bucket URLs rather than a bare object path — unwrap those back
  // to the real path so existing records keep working without a re-upload.
  async getCertificateSignedUrl(path) {
    const marker = '/object/public/certificates/';
    const normalizedPath = path.includes(marker) ? path.split(marker)[1] : path;
    const { data, error } = await supabase.storage.from('certificates').createSignedUrl(normalizedPath, 300);
    throwIfError(error);
    return data.signedUrl;
  },

  // Tenant display name — anon-readable (shown pre-login), authenticated-
  // writable (Admin screen). Single row (id = 1); see supabase/schema.sql.
  async getTenantName() {
    const { data, error } = await supabase.from('settings').select('tenant_name').eq('id', 1).maybeSingle();
    throwIfError(error);
    return data?.tenant_name || null;
  },

  async setTenantName(name) {
    const { data, error } = await supabase.from('settings').update({ tenant_name: name }).eq('id', 1).select('tenant_name').single();
    throwIfError(error);
    return data.tenant_name;
  },

  // Where expiration-alert emails are sent (see supabase/functions/expiration-alerts).
  // Blank/null means alerts are off for this tenant.
  async getNotificationEmail() {
    const { data, error } = await supabase.from('settings').select('notification_email').eq('id', 1).maybeSingle();
    throwIfError(error);
    return data?.notification_email || '';
  },

  async setNotificationEmail(email) {
    const { data, error } = await supabase.from('settings').update({ notification_email: email || null }).eq('id', 1).select('notification_email').single();
    throwIfError(error);
    return data.notification_email || '';
  },

  // Tenant logo + digest cadence/timezone settings (Phase 3). Grouped into
  // one get/update pair rather than per-field getters like getTenantName —
  // this is a growing settings form, and one round trip beats five.
  // Best-effort at the call site (admin.js) for tenants that haven't run
  // migrations 005/006 yet, same pattern as getNotificationEmail.
  async getExtendedSettings() {
    const { data, error } = await supabase
      .from('settings')
      .select('logo_url, timezone, digest_cadence, digest_day_of_week, digest_hour')
      .eq('id', 1)
      .maybeSingle();
    throwIfError(error);
    return {
      logoUrl: data?.logo_url || null,
      timezone: data?.timezone || 'UTC',
      digestCadence: data?.digest_cadence || 'daily',
      digestDayOfWeek: data?.digest_day_of_week ?? 1,
      digestHour: data?.digest_hour ?? 13,
    };
  },

  async updateExtendedSettings({ logoUrl, timezone, digestCadence, digestDayOfWeek, digestHour }) {
    const { error } = await supabase
      .from('settings')
      .update({
        logo_url: logoUrl,
        timezone,
        digest_cadence: digestCadence,
        digest_day_of_week: digestDayOfWeek,
        digest_hour: digestHour,
      })
      .eq('id', 1);
    throwIfError(error);
  },

  // Read-only from the app — see supabase/schema.sql's plan_limits table.
  // maxWorkers is null when the tenant has no cap (default). The actual
  // enforcement is a DB trigger on `workers` insert; this is just for
  // showing usage in the UI and pre-checking before a save/import attempt.
  async getPlanLimits() {
    const { data, error } = await supabase.from('plan_limits').select('plan_tier, max_workers').eq('id', 1).maybeSingle();
    if (error) return { planTier: 'unlimited', maxWorkers: null }; // table not migrated yet on this tenant
    return { planTier: data?.plan_tier || 'unlimited', maxWorkers: data?.max_workers ?? null };
  },

  // ---- Credential-type catalog (see supabase/migrations/007) --------------
  // The tenant-wide vocabulary that makes free-text cert names matchable: each
  // cert can carry a typeId pointing here, and a site requires entries from
  // here. Authenticated CRUD, single shared admin role like everything else.

  async credentialTypes() {
    const { data, error } = await supabase.from('credential_types').select('id, name, issuer').order('name');
    throwIfError(error);
    return (data || []).map((r) => ({ id: r.id, name: r.name, issuer: r.issuer || '' }));
  },

  async createCredentialType(name, issuer = '') {
    const { data, error } = await supabase
      .from('credential_types')
      .insert({ name: name.trim(), issuer: issuer.trim() })
      .select('id, name, issuer')
      .single();
    throwIfError(error);
    return { id: data.id, name: data.name, issuer: data.issuer || '' };
  },

  async updateCredentialType(id, { name, issuer }) {
    const patch = {};
    if (name !== undefined) patch.name = name.trim();
    if (issuer !== undefined) patch.issuer = issuer.trim();
    const { data, error } = await supabase.from('credential_types').update(patch).eq('id', id).select('id, name, issuer').single();
    throwIfError(error);
    return { id: data.id, name: data.name, issuer: data.issuer || '' };
  },

  // Removing a type cascades to any site_required_types rows (FK on delete
  // cascade). Certs tagged with it keep a now-dangling typeId — harmless and
  // fail-closed: a cert pointing at a missing type matches no requirement.
  async deleteCredentialType(id) {
    const { error } = await supabase.from('credential_types').delete().eq('id', id);
    throwIfError(error);
  },

  // One-time backfill: seed the catalog from the distinct cert names already
  // on workers, then tag each cert (cert.typeId) with the matching type. Only
  // touches certs that have no typeId yet, and only on an exact normalized
  // (case/whitespace-insensitive) name match — anything ambiguous is left
  // untagged, which is fail-closed (an untagged cert counts toward no site
  // requirement until an admin maps it). Returns a summary for the UI.
  //
  // O(workers) update round trips (one per worker whose certs changed); fine
  // for a one-off admin action at this scale. Callers MUST have the profile
  // save path preserving typeId first, or a later edit would drop the tag.
  async backfillCredentialTypesFromCerts() {
    const norm = (s) => (s || '').trim().toLowerCase();
    const workers = await this.getAll();
    const byName = new Map((await this.credentialTypes()).map((t) => [norm(t.name), t]));

    // 1. Create any cert names not already in the catalog.
    const missing = new Set();
    for (const w of workers) {
      for (const c of w.certifications || []) {
        if (norm(c.name) && !byName.has(norm(c.name))) missing.add(c.name.trim());
      }
    }
    let typesCreated = 0;
    for (const name of missing) {
      try {
        byName.set(norm(name), await this.createCredentialType(name));
        typesCreated++;
      } catch {
        // unique-collision / race — leave it; matching certs stay untagged
      }
    }

    // 2. Tag untagged certs whose name matches a type.
    let certsTagged = 0, certsUntagged = 0, workersUpdated = 0;
    for (const w of workers) {
      let changed = false;
      const certs = (w.certifications || []).map((c) => {
        if (c.typeId || !norm(c.name)) return c;
        const t = byName.get(norm(c.name));
        if (t) { certsTagged++; changed = true; return { ...c, typeId: t.id }; }
        certsUntagged++;
        return c;
      });
      if (changed) {
        await this.updateWorker(w.id, { certifications: certs });
        workersUpdated++;
      }
    }
    return { typesCreated, certsTagged, certsUntagged, workersUpdated };
  },

  // ---- Sites, requirements, rosters (see supabase/migrations/007) ---------

  async sites() {
    const { data, error } = await supabase.from('sites').select('id, name, location, active, public_slug').order('name');
    throwIfError(error);
    return (data || []).map(siteRow);
  },

  async getSite(id) {
    const { data, error } = await supabase.from('sites').select('id, name, location, active, public_slug').eq('id', id).maybeSingle();
    throwIfError(error);
    return data ? siteRow(data) : null;
  },

  async createSite({ name, location = '' }) {
    const row = { name: name.trim(), location: location.trim(), public_slug: makeSlug(name) };
    const { data, error } = await supabase.from('sites').insert(row).select('id, name, location, active, public_slug').single();
    throwIfError(error);
    return siteRow(data);
  },

  async updateSite(id, { name, location, active }) {
    const patch = {};
    if (name !== undefined) patch.name = name.trim();
    if (location !== undefined) patch.location = location.trim();
    if (active !== undefined) patch.active = active;
    const { data, error } = await supabase.from('sites').update(patch).eq('id', id).select('id, name, location, active, public_slug').single();
    throwIfError(error);
    return siteRow(data);
  },

  async deleteSite(id) {
    const { error } = await supabase.from('sites').delete().eq('id', id);
    throwIfError(error);
  },

  // A site's required credential-type ids.
  async siteRequiredTypeIds(siteId) {
    const { data, error } = await supabase.from('site_required_types').select('type_id').eq('site_id', siteId);
    throwIfError(error);
    return (data || []).map((r) => r.type_id);
  },

  // Replace a site's required set wholesale — simplest to reason about behind a
  // multi-select. delete-then-insert; the pair isn't a transaction, but the
  // readiness view recomputes from whatever's actually stored, so a partial
  // failure is visible rather than silently wrong.
  async setSiteRequiredTypes(siteId, typeIds) {
    const del = await supabase.from('site_required_types').delete().eq('site_id', siteId);
    throwIfError(del.error);
    if (typeIds.length) {
      const rows = typeIds.map((type_id) => ({ site_id: siteId, type_id }));
      const ins = await supabase.from('site_required_types').insert(rows);
      throwIfError(ins.error);
    }
  },

  // A site's assigned worker ids (the roster).
  async siteWorkerIds(siteId) {
    const { data, error } = await supabase.from('site_assignments').select('worker_id').eq('site_id', siteId);
    throwIfError(error);
    return (data || []).map((r) => r.worker_id);
  },

  async setSiteAssignments(siteId, workerIds) {
    const del = await supabase.from('site_assignments').delete().eq('site_id', siteId);
    throwIfError(del.error);
    if (workerIds.length) {
      const rows = workerIds.map((worker_id) => ({ site_id: siteId, worker_id }));
      const ins = await supabase.from('site_assignments').insert(rows);
      throwIfError(ins.error);
    }
  },

  // Bulk maps for the sites LIST page, so it can show a readiness summary per
  // site without a per-site round trip. Two queries instead of 2N.
  async allSiteRequiredTypes() {
    const { data, error } = await supabase.from('site_required_types').select('site_id, type_id');
    throwIfError(error);
    return data || [];
  },

  async allSiteAssignments() {
    const { data, error } = await supabase.from('site_assignments').select('site_id, worker_id');
    throwIfError(error);
    return data || [];
  },

  // ---- Gate scan audit log (see supabase/migrations/009) ------------------
  // Roadmap point 4, "The moat": log every gate scan with timestamp, result,
  // and who scanned.

  // Calls the SECURITY DEFINER RPC (anon-reachable — this runs from the
  // unauthenticated /r/:slug gate page) which computes clearance itself and
  // writes the row server-side; the return value here is just an echo for the
  // caller's own use, not something to trust for security decisions on its
  // own (the banner on publicRecord.js already computed the same thing
  // client-side via evaluateClearance for what it shows). Best-effort by
  // design — callers should not let a logging failure block the gate UI.
  async recordGateScan(siteSlug, workerSlug) {
    const { data, error } = await supabase.rpc('record_gate_scan', { p_site_slug: siteSlug, p_worker_slug: workerSlug });
    throwIfError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return row ? { result: row.result, workerName: row.worker_name, missingTypeNames: row.missing_type_names || [] } : null;
  },

  // Authenticated-only read of the log, newest first. siteId is required —
  // the admin scan-log page is reached from a specific site, and RLS makes
  // this authenticated-only anyway (anon can write via the RPC above but
  // never read).
  //
  // from/to are optional ISO timestamps (inclusive) filtering `scanned_at` —
  // added for the audit pack export (js/lib/auditPack.js), which needs a real
  // date range rather than "the most recent 200 scans." The plain scan-log
  // page (js/pages/siteScanLog.js) still calls this with no options and gets
  // the old newest-200 behavior unchanged.
  async siteScanLog(siteId, { from, to, limit = 200 } = {}) {
    let query = supabase
      .from('gate_scans')
      .select('id, worker_id, worker_slug, worker_name, result, missing_types, scanned_at')
      .eq('site_id', siteId)
      .order('scanned_at', { ascending: false })
      .limit(limit);
    if (from) query = query.gte('scanned_at', from);
    if (to) query = query.lte('scanned_at', to);
    const { data, error } = await query;
    throwIfError(error);
    return (data || []).map((r) => ({
      id: r.id,
      workerId: r.worker_id,
      workerSlug: r.worker_slug,
      workerName: r.worker_name,
      result: r.result,
      missingTypes: r.missing_types || [],
      scannedAt: r.scanned_at,
    }));
  },
};
