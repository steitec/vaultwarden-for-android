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
    // The offending character is not quoted back. It comes from a vault entry
    // — for a shared organization item, from whatever an org admin typed —
    // and this message is rendered in the popup. The alphabet is what the user
    // needs to be told; the character they got wrong tells them nothing they
    // cannot see in their own secret.
    if (idx < 0) throw new Error("TOTP secret is not valid base32 (A-Z and 2-7 only)");
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
    // Same rule as base32Decode above, and this one mattered more: it
    // interpolated the WHOLE parameter, so an entry could put an arbitrary
    // string of its own choosing into a popup message. Naming the three
    // values that are accepted says everything the message needs to.
    default:
      throw new Error(
        "otpauth URI names an unsupported algorithm (expected SHA1, SHA256 or SHA512)",
      );
  }
}

/**
 * Reads a whole-number otpauth parameter, or refuses the URI.
 *
 * Bare `Number()` was the defect this replaces, and each of its answers for a
 * malformed parameter is bad in its own way. `Number("")` is 0: a `digits` of
 * 0 makes `truncated % 10 ** 0` zero and `padStart(0)` a no-op, so every
 * account at every timestep gets the single character "0" — a TOTP field that
 * looks filled in and can never authenticate. `Number("abc")` is NaN, which
 * padStart turns into an empty code. A `period` of 0 divides the timestep by
 * zero, and `BigInt(Infinity)` throws a RangeError from the middle of the
 * counter setup, naming neither the URI nor the parameter.
 *
 * Substituting the default for garbage was considered and rejected. A code
 * generated under parameters the issuer did not choose is refused by the
 * server, and from the user's side that is indistinguishable from a wrong
 * clock, a revoked token, or a bug here. Refusing at the parse points at the
 * one thing they can actually fix: the entry.
 *
 * The offending value is deliberately NOT quoted back in the message. This
 * URI arrives as vault ciphertext from the server and the rejection is
 * rendered in the popup, so echoing its contents would put server-controlled
 * text on screen for no diagnostic benefit — the parameter name is what
 * identifies the problem.
 */
function wholeNumberParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = params.get(name);
  // Absent is not malformed: an otpauth URI without digits/period is the
  // common case and means the RFC 6238 defaults.
  if (raw === null) return fallback;
  // Decimal digits and nothing else. Number() would also take " 30", "1e2",
  // "0x1e" and "+30"; none of those is something an issuer emits, so treating
  // them as valid input would only widen what has to be reasoned about below.
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`otpauth URI has a non-numeric ${name} parameter (expected ${min}-${max})`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`otpauth URI has an out-of-range ${name} parameter (expected ${min}-${max})`);
  }
  return value;
}

/**
 * Bounds for `digits`.
 *
 * The otpauth Key Uri Format names 6 and 8, and RFC 6238's test vectors are
 * 8; 7 exists in the wild. Below 6 is refused because a shortened code is a
 * silent downgrade — the entry, not the user, would be deciding that a
 * 4-digit one-time password is enough. Above 10 is refused because RFC 4226
 * dynamic truncation produces a 31-bit integer: 10 digits already spans the
 * entire range it can emit, so an 11th digit is a leading zero on every code
 * ever generated and can only mean the parameter is wrong.
 */
const MIN_DIGITS = 6;
const MAX_DIGITS = 10;

/**
 * Bounds for `period`.
 *
 * One second is the smallest timestep that is still a timestep. The hour cap
 * is not in any RFC; it is there because a period is a rotation interval, and
 * a value beyond an hour describes something that does not rotate. Every
 * issuer in practice uses 30, occasionally 60.
 */
const MIN_PERIOD = 1;
const MAX_PERIOD = 3600;

export function parseTotpSecret(input: string): TotpConfig {
  const trimmed = input.trim();

  if (trimmed.toLowerCase().startsWith("otpauth://")) {
    const url = new URL(trimmed);
    const secret = url.searchParams.get("secret");
    if (secret === null) throw new Error("otpauth URI has no secret parameter");
    return {
      secret: base32Decode(secret),
      digits: wholeNumberParam(url.searchParams, "digits", 6, MIN_DIGITS, MAX_DIGITS),
      period: wholeNumberParam(url.searchParams, "period", 30, MIN_PERIOD, MAX_PERIOD),
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
