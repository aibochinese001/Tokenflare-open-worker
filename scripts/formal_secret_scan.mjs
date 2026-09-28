#!/usr/bin/env node
/**
 * formal_secret_scan.mjs — deterministic, repo-wide secret scan.
 *
 * Usage:  node scripts/formal_secret_scan.mjs   (or `npm run scan:secrets`)
 * Exit:   0 = no hits (clean), 1 = hits found, 2 = fatal error.
 *
 * Rules:
 *   - Scans every file under the project root except excluded dirs/files.
 *   - Binary files are skipped (first 8k bytes checked for NUL).
 *   - A small whitelist of clearly-fake values (example.com, REPLACE_WITH,
 *     YOUR_WORKER, sk-x, demo@example.com, ...) is applied per hit.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".wrangler",
  ".git",
  ".workbuddy",
  "dist",
  ".dev.vars",
]);
const EXCLUDE_FILES = new Set([
  ".admin-token.txt",
  ".session-secret.txt",
  "wrangler.toml", // real local config — never committed, never scanned
  "formal_secret_scan.mjs", // the scanner itself contains pattern literals
]);

const MAX_FILE_BYTES = 4 * 1024 * 1024; // skip anything larger than 4MB

// Regex pairs: [name, regex]. Case-insensitive unless noted.
const PATTERNS = [
  ["CLOUDFLARE_API_TOKEN", /\bCLOUDFLARE_API_TOKEN\b\s*[:=]\s*["']?[A-Za-z0-9_\-]{20,}/i],
  ["generic API key", /\b(?:api[_-]?key|apikey)\b\s*[:=]\s*["']?[A-Za-z0-9_\-\.]{16,}/i],
  ["secret", /\b(?:secret|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9_\-\.]{16,}/i],
  ["password", /\b(?:password|passwd|pwd)\b\s*[:=]\s*["']?[^\s"']{8,}/i],
  ["token", /\b(?:token|auth[_-]?token|access[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9_\-\.]{16,}/i],
  ["sk- key", /\bsk-[A-Za-z0-9]{20,}/i],
  ["sk-kp- key", /\bsk-kp-[A-Za-z0-9]{20,}/i],
  ["sk_live", /\bsk_live_[A-Za-z0-9]{20,}/i],
  ["sk_test", /\bsk_test_[A-Za-z0-9]{20,}/i],
  ["Bearer token", /\bBearer\s+[A-Za-z0-9_\-\.]{20,}/i],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["email:password", /\b[\w.+-]+@[\w-]+(\.[\w-]+)+\s*[:;,]\s*[^\s@]{6,}/],
  ["wrangler token", /\bWRANGLER_[A-Z0-9_]+/],
  ["D1 database id", /\bdatabase_id\s*=\s*["']?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
];

// Values that are clearly placeholders / fake test data → always allow.
const WHITELIST = [
  "example.com",
  "example.org",
  "your-idp.example.com",
  "your-worker.example.com",
  "YOUR_WORKER",
  "YOUR_WORKER_URL",
  "REPLACE_WITH",
  "sk-x",
  "sk-test",
  "sk-your",
  "demo@example.com",
  "paytest@example.com",
  "you@example.com",
  "api.example.com",
  "llm.example.com",
  "open.bigmodel.cn",
  "api.z.ai",
  "res.openai.azure.com",
  "generativelanguage.googleapis.com",
  "api.anthropic.com",
  "api.deepseek.com",
  "keypool",
  "llm-gateway",
  "admin-token",
  "SESSION_SECRET", // variable *name* is fine; a literal value is not
];

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function isWhitelisted(text) {
  const low = text.toLowerCase();
  for (const w of WHITELIST) if (low.includes(w.toLowerCase())) return true;
  return false;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(name) || EXCLUDE_FILES.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

let hits = 0;
let files = 0;

for (const file of walk(ROOT)) {
  const size = statSync(file).size;
  if (size === 0 || size > MAX_FILE_BYTES) continue;
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    continue;
  }
  if (isBinary(buf)) continue;
  files++;
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  for (const [name, re] of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (!m) continue;
      // Field-access on a variable (e.g. `password: str(b.password)` from a
      // parsed request body) is code, not a hardcoded credential — skip it.
      if (name === "password" && /password:\s*(str\(|b\s*&&|\(|\{)/i.test(lines[i])) continue;
      const snippet = m[0].length > 60 ? m[0].slice(0, 60) + "…" : m[0];
      if (isWhitelisted(snippet)) continue;
      hits++;
      console.log(
        `HIT [${name}] ${relative(ROOT, file).split(sep).join("/")}:${i + 1}  ${snippet}`
      );
    }
  }
}

console.log(`\nScanned ${files} files.`);
if (hits > 0) {
  console.log(`Found ${hits} potential secret(s).`);
  process.exit(1);
}
console.log("No secrets found. Clean ✓");
process.exit(0);
