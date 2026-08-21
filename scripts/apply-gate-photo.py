#!/usr/bin/env python3
"""Apply gate photo + direction client patches. Run from FieldCred repo root."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def patch_gate_app():
    path = ROOT / "js/pages/gateApp.js"
    text = path.read_text(encoding="utf-8")
    if "v.worker?.photoUrl" in text:
        print("gateApp.js already has photoUrl on verdict")
        return

    needle = "import { buildVerdict, resolveSite, shortExpiry, VERDICT } from '../lib/gateVerdict.js';"
    if "from '../components/avatar.js'" not in text:
        if needle not in text:
            raise SystemExit("import needle not found in gateApp.js")
        text = text.replace(
            needle,
            needle + "\nimport { avatarHtml } from '../components/avatar.js';",
            1,
        )

    old_fn = (
        "function initialsSquareHtml(name, className) {\n"
        "  return `<div class=\"${className}\">${escapeHtml(initials(name || '') || '—')}</div>`;\n"
        "}"
    )
    new_fn = (
        "function initialsSquareHtml(name, className, photoUrl = null) {\n"
        "  // Prefer photo when present (verdict posters). Falls back to tinted initials.\n"
        "  return avatarHtml(name, photoUrl, { className });\n"
        "}"
    )
    if old_fn not in text:
        raise SystemExit("initialsSquareHtml block not found")
    text = text.replace(old_fn, new_fn, 1)

    for a, b in [
        ("${initialsSquareHtml(v.worker?.name, 'gate-avatar')}", "${initialsSquareHtml(v.worker?.name, 'gate-avatar', v.worker?.photoUrl)}"),
        ("${initialsSquareHtml(v.worker?.name, 'gate-avatar gate-avatar-invert')}", "${initialsSquareHtml(v.worker?.name, 'gate-avatar gate-avatar-invert', v.worker?.photoUrl)}"),
        ("${initialsSquareHtml(v.worker.name, 'gate-avatar')}", "${initialsSquareHtml(v.worker.name, 'gate-avatar', v.worker.photoUrl)}"),
    ]:
        if a in text:
            text = text.replace(a, b)

    if "direction: 'in'" not in text:
        text = text.replace(
            "    needsSignIn: true,\n  };",
            "    needsSignIn: true,\n    direction: 'in',\n    onSite: [],\n  };",
            1,
        )

    old_run = "const verdict = await buildVerdict(ctx.pairedSlug, workerSlug, { via });"
    new_run = "const verdict = await buildVerdict(ctx.pairedSlug, workerSlug, { via, direction: ctx.direction || 'in' });"
    if old_run in text:
        text = text.replace(old_run, new_run, 1)

    if "gate-direction-toggle" not in text:
        old_home = (
            "      ${offlineBannerHtml(ctx)}\n"
            "      ${\n"
            "        ctx.pairedSlug\n"
            "          ? ''\n"
            "          : `<div class=\"gate-unpaired-note\">This device isn't paired to a site yet. Scan the QR posted at the gate — verdicts can't be issued until it is.</div>`\n"
            "      }\n"
            "      <div class=\"gate-body gate-body-guard\">"
        )
        new_home = (
            "      ${offlineBannerHtml(ctx)}\n"
            "      ${\n"
            "        ctx.pairedSlug\n"
            "          ? ''\n"
            "          : `<div class=\"gate-unpaired-note\">This device isn't paired to a site yet. Scan the QR posted at the gate — verdicts can't be issued until it is.</div>`\n"
            "      }\n"
            "      <div class=\"gate-direction-toggle\" role=\"group\" aria-label=\"Scan direction\">\n"
            "        <button type=\"button\" class=\"gate-dir-btn ${ctx.direction !== 'out' ? 'is-active' : ''}\" data-action=\"direction\" data-direction=\"in\">IN</button>\n"
            "        <button type=\"button\" class=\"gate-dir-btn ${ctx.direction === 'out' ? 'is-active' : ''}\" data-action=\"direction\" data-direction=\"out\">OUT</button>\n"
            "      </div>\n"
            "      <div class=\"gate-body gate-body-guard\">"
        )
        if old_home in text:
            text = text.replace(old_home, new_home, 1)

    if "case 'direction':" not in text:
        text = text.replace(
            "      case 'scanner':\n",
            "      case 'direction':\n"
            "        ctx.direction = el.dataset.direction === 'out' ? 'out' : 'in';\n"
            "        render();\n"
            "        break;\n\n"
            "      case 'scanner':\n",
            1,
        )

    if 'data-tab="onsite"' not in text:
        text = text.replace(
            "data-tab=\"log\">LOG</button>\n        <button class=\"gate-tab ${tab === 'site' ? 'is-active' : ''}\" type=\"button\" data-action=\"tab\" data-tab=\"site\">SITE</button>",
            "data-tab=\"log\">LOG</button>\n        <button class=\"gate-tab ${tab === 'onsite' ? 'is-active' : ''}\" type=\"button\" data-action=\"tab\" data-tab=\"onsite\">ON SITE</button>\n        <button class=\"gate-tab ${tab === 'site' ? 'is-active' : ''}\" type=\"button\" data-action=\"tab\" data-tab=\"site\">SITE</button>",
            1,
        )

    insert_before = "  } else {\n    const reqs = ctx.site?.requiredTypes || [];"
    if "tab === 'onsite'" not in text and insert_before in text:
        onsite_block = (
            "  } else if (tab === 'onsite') {\n"
            "    const people = ctx.onSite || [];\n"
            "    body = `\n"
            "      <div class=\"gate-sup-title\">On site now</div>\n"
            "      <div class=\"gate-sup-sub\">Workers whose latest scan today at this gate was IN. Scan OUT when they leave so this list stays accurate.</div>\n"
            "      <div class=\"gate-log-list\">\n"
            "        ${\n"
            "          people.length\n"
            "            ? people.map((p) => `<div class=\"gate-log-row\">\n"
            "                <div class=\"gate-log-line\">\n"
            "                  <span class=\"gate-log-who\">${escapeHtml(p.workerName || p.workerSlug || '—')}</span>\n"
            "                  <span class=\"gate-log-tag is-cleared\">IN · ${escapeHtml(formatTime(p.lastInAt))}</span>\n"
            "                </div>\n"
            "              </div>`).join('')\n"
            "            : '<div class=\"gate-lookup-empty\">No one is marked on site right now.</div>'\n"
            "        }\n"
            "      </div>`;\n"
            "  } else {\n"
            "    const reqs = ctx.site?.requiredTypes || [];"
        )
        text = text.replace(insert_before, onsite_block, 1)

    if "async function loadOnSite" not in text:
        text = text.replace(
            "  async function loadScanLog() {",
            "  async function loadOnSite() {\n"
            "    ctx.onSite = [];\n"
            "    if (!ctx.site?.id || !ctx.session) return;\n"
            "    try {\n"
            "      ctx.onSite = await store.siteOnSiteNow(ctx.site.id);\n"
            "    } catch {\n"
            "      ctx.onSite = [];\n"
            "    }\n"
            "  }\n\n"
            "  async function loadScanLog() {",
            1,
        )

    text = text.replace(
        "        if (ctx.supTab === 'home' || ctx.supTab === 'log') {\n"
        "          await loadScanLog();\n"
        "          render();\n"
        "        }",
        "        if (ctx.supTab === 'home' || ctx.supTab === 'log') {\n"
        "          await loadScanLog();\n"
        "          render();\n"
        "        }\n"
        "        if (ctx.supTab === 'onsite') {\n"
        "          await loadOnSite();\n"
        "          render();\n"
        "        }",
        1,
    )

    old_log = "  const who = scan.workerName || scan.workerSlug || 'unknown badge';"
    if old_log in text and "dirTag" not in text:
        text = text.replace(
            old_log,
            "  const who = scan.workerName || scan.workerSlug || 'unknown badge';\n"
            "  const dir = scan.direction === 'out' ? 'OUT' : (scan.direction === 'in' ? 'IN' : '');\n"
            "  const dirTag = dir ? ` · ${dir}` : '';",
            1,
        )
        text = text.replace(
            '<span class="gate-log-tag ${meta.className}">${escapeHtml(meta.label)}</span>',
            '<span class="gate-log-tag ${meta.className}">${escapeHtml(meta.label)}${escapeHtml(dirTag)}</span>',
            1,
        )

    path.write_text(text, encoding="utf-8")
    print("patched", path)


def patch_css():
    path = ROOT / "css/styles.css"
    text = path.read_text(encoding="utf-8")
    if ".gate-avatar img" in text and "gate-direction-toggle" in text:
        print("styles.css already patched")
        return
    marker = ".gate-avatar-sm { width: 40px; height: 40px; font-size: 14px; }"
    if marker not in text:
        raise SystemExit("CSS marker not found")
    if ".gate-avatar img" not in text:
        text = text.replace(
            marker,
            marker
            + "\n.gate-avatar { overflow: hidden; }\n"
            + ".gate-avatar img,\n.gate-avatar .avatar-initials {\n"
            + "  width: 100%;\n  height: 100%;\n  object-fit: cover;\n  display: block;\n}\n",
            1,
        )
    if "gate-direction-toggle" not in text:
        text += """

/* Gate IN/OUT direction toggle */
.gate-direction-toggle {
  display: flex;
  flex: none;
  border-bottom: 2px solid var(--brand);
}
.gate-dir-btn {
  flex: 1;
  padding: 12px 0;
  border: 0;
  border-left: 2px solid var(--brand);
  background: transparent;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--brand);
}
.gate-dir-btn:first-child { border-left: 0; }
.gate-app .gate-dir-btn.is-active {
  background: var(--brand);
  color: #fff;
}
"""
    path.write_text(text, encoding="utf-8")
    print("patched", path)


def patch_state():
    path = ROOT / "js/lib/state.js"
    text = path.read_text(encoding="utf-8")
    if "siteOnSiteNow" in text:
        print("state.js already has siteOnSiteNow")
        return
    old = (
        "  async recordGateScan(siteSlug, workerSlug) {\n"
        "    const { data, error } = await supabase.rpc('record_gate_scan', { p_site_slug: siteSlug, p_worker_slug: workerSlug });\n"
    )
    new = (
        "  async recordGateScan(siteSlug, workerSlug, { direction = 'in', deviceId = null, guardLabel = null } = {}) {\n"
        "    const { data, error } = await supabase.rpc('record_gate_scan', {\n"
        "      p_site_slug: siteSlug,\n"
        "      p_worker_slug: workerSlug,\n"
        "      p_direction: direction === 'out' ? 'out' : 'in',\n"
        "      p_device_id: deviceId,\n"
        "      p_guard_label: guardLabel,\n"
        "    });\n"
    )
    if old not in text:
        raise SystemExit("recordGateScan not found")
    text = text.replace(old, new, 1)
    text = text.replace(
        ".select('id, worker_id, worker_slug, worker_name, result, missing_types, scanned_at')",
        ".select('id, worker_id, worker_slug, worker_name, result, missing_types, scanned_at, direction, device_id, guard_label')",
        1,
    )
    old_map = (
        "      scannedAt: r.scanned_at,\n"
        "    }));\n"
        "  },\n"
        "};\n"
    )
    new_map = (
        "      scannedAt: r.scanned_at,\n"
        "      direction: r.direction || 'in',\n"
        "      deviceId: r.device_id || null,\n"
        "      guardLabel: r.guard_label || null,\n"
        "    }));\n"
        "  },\n"
        "\n"
        "  // Presence: workers whose latest scan today is direction=in (migration 014).\n"
        "  async siteOnSiteNow(siteId) {\n"
        "    const { data, error } = await supabase.rpc('site_on_site_now', { p_site_id: siteId });\n"
        "    throwIfError(error);\n"
        "    return (data || []).map((r) => ({\n"
        "      workerId: r.worker_id,\n"
        "      workerName: r.worker_name,\n"
        "      workerSlug: r.worker_slug,\n"
        "      lastInAt: r.last_in_at,\n"
        "    }));\n"
        "  },\n"
        "};\n"
    )
    if old_map not in text:
        raise SystemExit("siteScanLog map tail not found")
    text = text.replace(old_map, new_map, 1)
    path.write_text(text, encoding="utf-8")
    print("patched", path)


if __name__ == "__main__":
    patch_gate_app()
    patch_css()
    patch_state()
    print("done — pull, run this script, apply migration 014 on each tenant DB")
