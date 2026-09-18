#!/usr/bin/env node
/**
 * setup.mjs — 一键准备 D1 数据库并把 database_id 写回 wrangler.toml。
 *
 * 用法：
 *   npm run setup            # 交互式逐步执行
 *   npm run setup -- --json  # 机器可读输出（agent 友好）
 *
 * 步骤：校验登录 → 建/复用 D1 `llm-gateway` → 回填 database_id →
 *       应用 schema.sql → 打印剩余步骤（secrets、deploy）。
 * 幂等：D1 已存在则直接复用。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TOML = join(root, "wrangler.toml");
const SCHEMA = join(root, "schema.sql");
const DB_NAME = "llm-gateway";
const json = process.argv.includes("--json");

function run(args, opts = {}) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: opts.silent ? "pipe" : "inherit",
    ...opts,
  });
}

function step(label) {
  if (!json) console.log(`\n==> ${label}`);
}

try {
  step("0/4 校验 Cloudflare 登录 (wrangler whoami)");
  run(["whoami"], { silent: true });

  step("1/4 确保 D1 数据库存在: " + DB_NAME);
  let dbId = "";
  try {
    const list = JSON.parse(run(["d1", "list", "--json"], { silent: true }));
    dbId = list.find((d) => d.name === DB_NAME)?.uuid ?? "";
  } catch {
    dbId = "";
  }
  if (!dbId) {
    run(["d1", "create", DB_NAME]);
    const list = JSON.parse(run(["d1", "list", "--json"], { silent: true }));
    dbId = list.find((d) => d.name === DB_NAME)?.uuid ?? "";
    if (!dbId) throw new Error("创建 D1 后仍取不到 database_id");
  }
  if (!json) console.log(`    database_id=${dbId}`);

  step("2/4 把 database_id 回填到 wrangler.toml");
  if (!existsSync(TOML)) throw new Error("缺少 wrangler.toml，请先 cp wrangler.toml.example wrangler.toml");
  const toml = readFileSync(TOML, "utf8").replace(
    /(database_id\s*=\s*")[^"]*(")/,
    `$1${dbId}$2`,
  );
  writeFileSync(TOML, toml);

  step("3/4 应用 schema.sql 到远程 D1");
  run(["d1", "execute", DB_NAME, "--remote", "--file=" + SCHEMA]);

  step("4/4 完成");
  const reminder = [
    "",
    "下一步（按顺序）：",
    "  1. npx wrangler secret put ADMIN_TOKEN        # 管理后台/API Bearer Token（必填）",
    "  2. npx wrangler secret put SESSION_SECRET     # 32+ 字节随机串（启用 SSO 时必填）",
    "  3. （可选）npx wrangler secret put STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET",
    "  4. npx wrangler deploy                        # 部署",
    "",
    "管理员控制台：打开部署后的 URL（workers.dev），用 ADMIN_TOKEN 登录并导入上游密钥。",
  ].join("\n");
  if (json) {
    console.log(JSON.stringify({ ok: true, database_id: dbId, database_name: DB_NAME }));
  } else {
    console.log(reminder);
  }
} catch (err) {
  if (json) console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
  else console.error("\n失败：" + (err?.message ?? err));
  process.exit(1);
}
