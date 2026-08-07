import { Bytes } from "./crypto/bytes";

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export type TotpConfig = {
  secret: Bytes;
  digits: number;
  period: number;
  algorithm: "SHA-1" | "SHA-256" | "SHA-512";
};

function base32Decode(input: string): Bytes {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (clean.length === 0) throw new Error("Empty base32 secret");

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function normalizeAlgorithm(a: string | null): TotpConfig["algorithm"] {
  switch ((a ?? "SHA1").toUpperCase()) {
    case "SHA1": return "SHA-1";
    case "SHA256": return "SHA-256";
    case "SHA512": return "SHA-512";
    default: throw new Error(`Unsupported TOTP algorithm: ${a}`);
  }
}

export function parseTotpSecret(input: string): TotpConfig {
  const trimmed = input.trim();

  if (trimmed.toLowerCase().startsWith("otpauth://")) {
    const url = new URL(trimmed);
    const secret = url.searchParams.get("secret");
    if (secret === null) throw new Error("otpauth URI has no secret parameter");
    return {
      secret: base32Decode(secret),
      digits: Number(url.searchParams.get("digits") ?? 6),
      period: Number(url.searchParams.get("period") ?? 30),
      algorithm: normalizeAlgorithm(url.searchParams.get("algorithm")),
    };
  }

  return { secret: base32Decode(trimmed), digits: 6, period: 30, algorithm: "SHA-1" };
}

export async function generateTotp(
  input: string,
  atMs: number,
): Promise<{ code: string; secondsRemaining: number }> {
  const cfg = parseTotpSecret(input);
  const seconds = Math.floor(atMs / 1000);
  const counter = Math.floor(seconds / cfg.period);

  const block = new Uint8Array(8);
  new DataView(block.buffer).setBigUint64(0, BigInt(counter), false);

  const key = await crypto.subtle.importKey(
    "raw",
    cfg.secret,
    { name: "HMAC", hash: cfg.algorithm },
    false,
    ["sign"],
  );
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, block));

  const offset = hmac[hmac.length - 1]! & 0x0f;
  const truncated =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;

  const code = String(truncated % 10 ** cfg.digits).padStart(cfg.digits, "0");
  return { code, secondsRemaining: cfg.period - (seconds % cfg.period) };
}
