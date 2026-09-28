#!/usr/bin/env node
/**
 * setup.mjs — deterministic one-shot bootstrap for a fresh Cloudflare account.
 *
 * Usage:  npm run setup            (interactive-ish, prints next steps)
 *         npm run setup -- --json  (machine-readable JSON on stdout)
 *
 * What it does, in order:
 *   1. Verifies `wrangler` is logged in (`wrangler whoami`).
 *   2. Creates the D1 database `llm-gateway` (or reuses it if it exists).
 *   3. Writes the real database_id back into `wrangler.toml`.
 *   4. Applies `schema.sql` to the remote D1 database.
 *   5. Prints the exact secret/deploy commands left to run.
 *
 * It never asks for secrets and never writes them anywhere.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const TOML = join(ROOT, "wrangler.toml");
const SCHEMA = join(ROOT, "schema.sql");
const DB_NAME = "llm-gateway";

const json = process.argv.includes("--json");
const out = {};
const log = (...a) => { if (!json) console.log(...a); };

function run(cmd) {
  log(`\n$ ${cmd}`);
  return execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

function fail(msg, code = 1) {
  if (json) {
    out.ok = false;
    out.error = msg;
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.error(`\n✗ ${msg}`);
  }
  process.exit(code);
}

try {
  // 1. whoami
  const who = run("npx wrangler whoami");
  const email = (who.match(/Email\s*[:]\s*(\S+)/i) || [])[1] || "unknown";
  log(`✓ logged in as ${email}`);
  out.account = email;

  // 2. D1 create (or reuse)
  let databaseId = "";
  try {
    const created = run(`npx wrangler d1 create ${DB_NAME}`);
    const m = created.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
    if (m) databaseId = m[1];
  } catch (e) {
    // Already exists — pull its id from the list output.
    const list = run("npx wrangler d1 list --json");
    try {
      const rows = JSON.parse(list);
      const hit = rows.find((r) => r.database_name === DB_NAME || r.name === DB_NAME);
      if (hit) databaseId = hit.database_id || hit.uuid || "";
    } catch {
      /* ignore parse errors; fail below if no id */
    }
  }
  if (!databaseId) fail("Could not determine the D1 database id. Run `npx wrangler d1 list` manually.");
  log(`✓ D1 database ready: ${DB_NAME} (${databaseId})`);
  out.database_id = databaseId;

  // 3. write id back into wrangler.toml
  if (!existsSync(TOML)) fail(`wrangler.toml not found (${TOML}). Copy wrangler.toml.example first.`);
  let toml = readFileSync(TOML, "utf8");
  if (toml.includes("REPLACE_WITH_YOUR_D1_DATABASE_ID")) {
    toml = toml.replace(/database_id\s*=\s*"REPLACE_WITH_YOUR_D1_DATABASE_ID"/, `database_id = "${databaseId}"`);
    writeFileSync(TOML, toml);
    log("✓ wrote database_id into wrangler.toml");
  } else {
    log("• wrangler.toml already has a database_id — left as-is");
  }

  // 4. apply schema
  if (!existsSync(SCHEMA)) fail(`schema.sql not found (${SCHEMA}).`);
  run(`npx wrangler d1 execute ${DB_NAME} --remote --file=${SCHEMA}`);
  log("✓ schema.sql applied to remote D1");
  out.schema_applied = true;

  // 5. next steps
  log("\nNext steps (copy-paste):");
  log(`  npx wrangler secret put ADMIN_TOKEN         # required — admin/API bearer token`);
  log(`  npx wrangler secret put SESSION_SECRET      # only if you enable OIDC SSO`);
  log(`  npx wrangler deploy`);
  log(`\nOpen the printed *.workers.dev URL for the admin console.`);

  if (json) {
    out.ok = true;
    out.next = ["secret put ADMIN_TOKEN", "secret put SESSION_SECRET (optional)", "wrangler deploy"];
    console.log(JSON.stringify(out, null, 2));
  }
} catch (e) {
  fail(String(e.message || e));
}
