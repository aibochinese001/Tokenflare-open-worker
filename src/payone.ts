/**
 * 易支付 (PayOne-style) payment gateway — the "直接拼接" MD5 signature scheme.
 *
 *  下单:   GET <api_url>/submit.php?pid=..&type=..&out_trade_no=..&notify_url=..
 *          &return_url=..&name=..&money=..&sign=MD5&sign_type=MD5   → 302 支付页
 *  回调:   POST <api_url>/notify  (异步, 回 "success")  /  GET 同步跳转
 *  签名:   除 sign/sign_type 外全部参数, 参数名按 ASCII 排序,
 *         拼成 k1=v1&k2=v2&..., 末尾直接拼接商户密钥, MD5 小写。
 */

import type { Env } from "./types";

export interface PayConfig {
  api_url: string;
  pid: string;
  key: string;
  methods: string[];                     // enabled method keys (see PAY_METHODS)
  method_types: Record<string, string>;  // method key -> gateway `type` value
}

export interface PayMethod {
  key: string;
  label: string;
  type: string;
}

/** Built-in payment methods. Keys are stable identifiers used in the UI;
 *  `type` is the value sent to the 易支付 gateway (editable via config). */
export const PAY_METHODS: PayMethod[] = [
  { key: "usdt", label: "USDT", type: "usdt" },
  { key: "stripe", label: "Stripe", type: "fiatstripe" },
  { key: "paypal", label: "PayPal", type: "paypal" },
  { key: "wechat", label: "微信", type: "wxpay" },
  { key: "alipay", label: "支付宝", type: "alipay" },
  { key: "dcpay", label: "数字人民币", type: "ecny" },
];

const CONFIG_KEY = "payone_gateway_v1";
const CONFIG_TABLE = "keypool_gateway_pay_config";

function normalize(c: PayConfig): PayConfig {
  const types: Record<string, string> = {};
  for (const m of PAY_METHODS) {
    types[m.key] = c.method_types?.[m.key] || m.type;
  }
  return {
    api_url: String(c.api_url || "").replace(/\/+$/, ""),
    pid: String(c.pid || "").trim(),
    key: String(c.key || ""),
    methods: Array.isArray(c.methods) ? c.methods.filter((k) => PAY_METHODS.some((m) => m.key === k)) : [],
    method_types: types,
  };
}

export async function getPayConfig(env: Env): Promise<PayConfig | null> {
  const row = await env.DB.prepare(`SELECT v FROM ${CONFIG_TABLE} WHERE k = ?`)
    .bind(CONFIG_KEY)
    .first<{ v: string }>();
  if (!row) return null;
  try {
    const c = JSON.parse(row.v) as PayConfig;
    if (c && c.api_url && c.pid && c.key) return normalize(c);
  } catch {
    // fall through
  }
  return null;
}

export async function setPayConfig(env: Env, cfg: PayConfig): Promise<void> {
  const normalized = normalize(cfg);
  await env.DB.prepare(
    `INSERT INTO ${CONFIG_TABLE} (k, v, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`
  )
    .bind(CONFIG_KEY, JSON.stringify(normalized), Date.now())
    .run();
}

/** Enabled methods with their gateway type values. */
export function enabledMethods(cfg: PayConfig): PayMethod[] {
  const set = new Set(cfg.methods);
  return PAY_METHODS.filter((m) => set.has(m.key)).map((m) => ({
    ...m,
    type: cfg.method_types?.[m.key] || m.type,
  }));
}

// ---------------------------------------------------------------- MD5 (RFC 1321)
// WebCrypto has no MD5; 易支付 requires it. Compact pure-JS implementation,
// verified against RFC 1321 test vectors.

const MD5_K = new Int32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

const MD5_S = new Int32Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

export function md5(input: string): string {
  const utf8 = new TextEncoder().encode(input);
  const msgLen = utf8.length;
  const bitLenLow = (msgLen * 8) >>> 0;
  const bitLenHigh = Math.floor(msgLen / 536870912);

  const padded = new Uint8Array((Math.floor((msgLen + 8) / 64) + 1) * 64);
  padded.set(utf8);
  padded[msgLen] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLenLow, true);
  dv.setUint32(padded.length - 4, bitLenHigh, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Int32Array(16);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + MD5_K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new DataView(new ArrayBuffer(16));
  out.setUint32(0, a0 >>> 0, true);
  out.setUint32(4, b0 >>> 0, true);
  out.setUint32(8, c0 >>> 0, true);
  out.setUint32(12, d0 >>> 0, true);
  let hex = "";
  for (const b of new Uint8Array(out.buffer)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// ---------------------------------------------------------------- signing

/**
 * 直接拼接签名: 除 sign/sign_type 外的所有参数按参数名 ASCII 升序,
 * 拼成 k1=v1&k2=v2&..., 末尾直接拼接商户密钥, MD5 小写。
 */
export function payoneSign(params: Record<string, string>, key: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "" && params[k] != null)
    .sort();
  const str = keys.map((k) => `${k}=${params[k]}`).join("&") + key;
  return md5(str).toLowerCase();
}

/** Build the gateway submit URL for a new order. */
export function buildSubmitUrl(
  cfg: PayConfig,
  order: { out_trade_no: string; method_type: string; name: string; money: string; notify_url: string; return_url: string }
): string {
  const params: Record<string, string> = {
    pid: cfg.pid,
    type: order.method_type,
    out_trade_no: order.out_trade_no,
    notify_url: order.notify_url,
    return_url: order.return_url,
    name: order.name,
    money: order.money,
    sign_type: "MD5",
  };
  params.sign = payoneSign(params, cfg.key);
  return `${cfg.api_url}/submit.php?` + new URLSearchParams(params).toString();
}

/** Verify an incoming callback (POST body params or GET query). */
export function verifyCallback(cfg: PayConfig, params: Record<string, string>): boolean {
  const expected = payoneSign(params, cfg.key);
  const given = (params.sign || "").trim().toLowerCase();
  return given.length > 0 && given === expected;
}
