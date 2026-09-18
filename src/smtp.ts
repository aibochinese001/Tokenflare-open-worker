/**
 * Minimal SMTP client over Workers TCP sockets (cloudflare:sockets).
 * Used for transactional mail: recharge invoices, password-reset codes.
 * Compatible with QQ SMTP (smtp.qq.com:465 SMTPS or :587 STARTTLS, app
 * password / 授权码) and most standard SMTP servers.
 */

import { connect } from "cloudflare:sockets";

export interface SmtpSettings {
  host: string;
  port: number;
  user: string; // account (for QQ: the mailbox itself)
  pass: string; // QQ: 16-char app password (授权码), NOT the login password
  from: string; // sender address (QQ requires it to equal `user`)
  fromName: string;
}

/** Parse the stored JSON blob (settings key `smtp_json`). Null if unset/broken. */
export function parseSmtp(raw: string | undefined | null): SmtpSettings | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (typeof j.host !== "string" || !j.host) return null;
    if (typeof j.user !== "string" || !j.user) return null;
    if (typeof j.pass !== "string" || !j.pass) return null;
    const port = typeof j.port === "number" ? j.port : 465;
    const from = typeof j.from === "string" && j.from ? j.from : j.user;
    const fromName = typeof j.fromName === "string" ? j.fromName : "";
    return { host: j.host, port, user: j.user, pass: j.pass, from, fromName };
  } catch {
    return null;
  }
}

/** UTF-8 → base64 without Node Buffer (works on Workers runtime). */
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** RFC 2047 encoded subject so CJK subjects survive non-UTF8 relays. */
function mimeSubject(subject: string): string {
  return `=?UTF-8?B?${utf8ToBase64(subject)}?=`;
}

interface Buf {
  acc: string;
}

/** Read one SMTP line (ends with \r\n) from the socket. Returns line without CRLF. */
async function readLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buf: Buf,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const dec = new TextDecoder();
  while (true) {
    const idx = buf.acc.indexOf("\r\n");
    if (idx >= 0) {
      const line = buf.acc.slice(0, idx);
      buf.acc = buf.acc.slice(idx + 2);
      return line;
    }
    if (Date.now() > deadline) throw new Error("SMTP read timeout");
    const { value, done } = await reader.read();
    if (done) throw new Error("SMTP connection closed by server");
    buf.acc += dec.decode(value, { stream: true });
  }
}

/** Read (and skip) multiline replies; returns the final status code. */
async function readStatus(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buf: Buf,
  timeoutMs: number
): Promise<number> {
  for (;;) {
    const line = await readLine(reader, buf, timeoutMs);
    const code = Number(line.slice(0, 3));
    if (!line.startsWith(" ")) {
      // "250-" continuation → keep reading; "250 " final
      if (line.length >= 4 && line[3] === " ") return code;
    } else {
      return code;
    }
  }
}

/** Send an HTML email through the configured SMTP gateway. Throws on failure. */
export async function sendMail(
  cfg: SmtpSettings,
  to: string,
  subject: string,
  html: string
): Promise<void> {
  const secure = cfg.port === 465;
  const socket = (
    connect as unknown as (opts: {
      hostname: string;
      port: number;
      secureTransport: "on" | "starttls";
    }) => ReturnType<typeof connect>
  )({
    hostname: cfg.host,
    port: cfg.port,
    secureTransport: secure ? "on" : "starttls",
  });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const buf: Buf = { acc: "" };
  const T = 20000;

  const cmd = async (line: string): Promise<void> => {
    await writer.write(new TextEncoder().encode(line + "\r\n"));
  };

  try {
    await readStatus(reader, buf, T); // greeting 220
    await cmd(`EHLO gateway.local`);
    await readStatus(reader, buf, T); // EHLO 250
    await cmd(`AUTH LOGIN`);
    await readStatus(reader, buf, T); // 334 Username:
    await cmd(utf8ToBase64(cfg.user));
    await readStatus(reader, buf, T); // 334 Password:
    await cmd(utf8ToBase64(cfg.pass));
    const auth = await readStatus(reader, buf, T); // 235
    if (auth !== 235) throw new Error(`SMTP auth failed (${auth})`);

    await cmd(`MAIL FROM:<${cfg.from}>`);
    const mf = await readStatus(reader, buf, T);
    if (mf !== 250) throw new Error(`MAIL FROM rejected (${mf})`);
    await cmd(`RCPT TO:<${to}>`);
    const rc = await readStatus(reader, buf, T);
    if (rc !== 250) throw new Error(`RCPT TO rejected (${rc})`);

    await cmd(`DATA`);
    const d = await readStatus(reader, buf, T);
    if (d !== 354) throw new Error(`DATA rejected (${d})`);

    const fromHeader = cfg.fromName
      ? `${cfg.fromName.replace(/[<>]/g, "")} <${cfg.from}>`
      : cfg.from;
    const bodyB64 = utf8ToBase64(html);
    const head =
      `From: ${fromHeader}\r\n` +
      `To: <${to}>\r\n` +
      `Subject: ${mimeSubject(subject)}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n`;
    await writer.write(new TextEncoder().encode(head));
    // chunk base64 to keep lines under ~76 chars
    for (let i = 0; i < bodyB64.length; i += 76) {
      await writer.write(new TextEncoder().encode(bodyB64.slice(i, i + 76) + "\r\n"));
    }
    await writer.write(new TextEncoder().encode(".\r\n"));
    const fin = await readStatus(reader, buf, T);
    if (fin !== 250) throw new Error(`DATA rejected after body (${fin})`);

    await cmd(`QUIT`);
    await readStatus(reader, buf, T);
  } finally {
    try {
      await writer.close();
    } catch {
      /* ignore */
    }
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }
}
