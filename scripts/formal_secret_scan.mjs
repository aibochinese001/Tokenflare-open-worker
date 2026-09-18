#!/usr/bin/env node
/**
 * formal_secret_scan.mjs — 开源前正式敏感信息扫描
 *
 * 覆盖模式：sk- token、CLOUDFLARE_API_TOKEN、api_key/secret、password、
 * Bearer、access_token、邮箱+密码组合等。
 * 排除目录：node_modules、.wrangler、.git、.workbuddy、dist
 * 白名单：example.com 等夹具域名与 REPLACE_WITH_* 占位符。
 *
 * 用法：node scripts/formal_secret_scan.mjs [rootDir]
 * 退出码：0 = 无命中；1 = 有命中（打印明细）
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const EXCLUDE_DIRS = ["node_modules", ".wrangler", ".git", ".workbuddy", "dist", ".next", ".open-next"];
const EXCLUDE_FILES = new Set([".dev.vars", "package-lock.json", "tsconfig.tsbuildinfo"]);

const FAKE_EMAIL_DOMAINS = /(^|@)(example|acme|northwind|contoso|globex|initech|umbrella|vendor|customer|partner|invalid|fake-bank|unknown-sender)\.(com|net|test|org)$/i;
const PLACEHOLDER = /REPLACE_WITH|your-|xxx|XXXX|example\.com/i;

const PATTERNS = [
	{ name: "sk- token", re: /\bsk-(?:live|test|or|kp|ant)?[-_][A-Za-z0-9_-]{12,}\b|\bsk-[A-Za-z0-9_-]{20,}\b/i },
	{ name: "CLOUDFLARE_API_TOKEN", re: /(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CF_TOKEN)\s*[=:]\s*["']?[A-Za-z0-9_-]{30,}/i },
	{ name: "api_key/secret", re: /(?:api[_-]?key|apikey|api[_-]?secret|client[_-]?secret|secret[_-]?key|access[_-]?key[_-]?id)\s*[=:]\s*["'][A-Za-z0-9_\-\.]{16,}["']/i },
	{ name: "password", re: /(?:password|passwd|pwd)\s*[=:]\s*["'][^"']{6,}["']/i },
	{ name: "Bearer token", re: /\bBearer\s+[A-Za-z0-9_\-\.]{20,}/i },
	{ name: "auth/access token", re: /(?:authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key)\s*[=:]\s*["'][A-Za-z0-9_\-\.]{16,}["']/i },
	{ name: "email+password combo", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}[^\n]{0,50}(?:password|passwd|pwd)\s*[=:]/i },
];

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".dev.vars.example") continue;
		if (EXCLUDE_DIRS.includes(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (!EXCLUDE_FILES.has(entry.name)) out.push(full);
	}
	return out;
}

function isAllowed(line) {
	if (PLACEHOLDER.test(line)) return true;
	const emails = line.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
	if (emails.length && emails.every((e) => FAKE_EMAIL_DOMAINS.test(e))) return true;
	return false;
}

const files = walk(root);
let hits = 0;
const details = [];
for (const file of files) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	if (text.includes("\u0000")) continue;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		for (const { name, re } of PATTERNS) {
			if (re.test(line) && !isAllowed(line)) {
				hits++;
				details.push(`${file.replace(root + "\\", "").replace(root + "/", "")}:${i + 1} [${name}] ${line.trim().slice(0, 160)}`);
			}
		}
	}
}

console.log(`Scanned ${files.length} files in ${root}`);
if (hits > 0) {
	console.log(`FOUND ${hits} potential secret(s):`);
	for (const d of details) console.log("  " + d);
	process.exit(1);
} else {
	console.log("OK: 0 secrets found.");
	process.exit(0);
}
