/**
 * Password hashing for local (email + password) accounts.
 *
 * PBKDF2-SHA256 via WebCrypto (available on Cloudflare Workers), per-user
 * random salt, 100k iterations, 32-byte derived key. Salt and hash are stored
 * base64url in the users table. Verification is constant-time.
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

/** Generate a fresh random salt (base64url). */
export function generateSalt(): string {
  const b = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(b);
  return b64url(b);
}

/** PBKDF2-SHA256 hash of a password with the given salt (base64url output). */
export async function hashPassword(password: string, saltB64: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: fromB64url(saltB64),
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    KEY_BYTES * 8
  );
  return b64url(new Uint8Array(bits));
}

/** Constant-time string comparison (no early exit on first mismatch). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i % y.length];
  for (let i = 0; i < y.length; i++) d |= y[i] ^ x[i % x.length];
  return d === 0;
}

/** Verify a password against a stored salt + hash. */
export async function verifyPassword(
  password: string,
  saltB64: string,
  expectedHash: string
): Promise<boolean> {
  const actual = await hashPassword(password, saltB64);
  return timingSafeEqual(actual, expectedHash);
}
