import { fromBase64, toBase64, concat, constantTimeEqual, type Bytes } from "./bytes";

export type SymKey = { encKey: Bytes; macKey: Bytes };

export type EncString = {
  /**
   * 2 = AES-256-CBC + HMAC-SHA256. This is the only type this module
   * accepts. Type 0 (MAC-less AES-256-CBC) is intentionally NOT supported:
   * splitSymKey (the sole producer of SymKey in this client) requires
   * exactly 64-byte keys (32 enc + 32 mac) and throws otherwise, so this
   * client can never legitimately hold a MAC-less key — accepting type 0
   * would only ever create a decryption oracle for an attacker who can
   * rewrite the type prefix on a captured type-2 string. See the parse-time
   * rejection in parseEncString and the fix-round-1 report.
   */
  type: 2;
  iv: Bytes;
  ct: Bytes;
  mac: Bytes;
};

export class MacMismatchError extends Error {
  constructor() {
    super("EncString MAC verification failed");
    this.name = "MacMismatchError";
  }
}

/**
 * Thrown for any structurally invalid EncString: bad type prefix, wrong
 * part count, non-base64 payloads, or wrong-length iv/ct/mac. Kept distinct
 * from MacMismatchError (a cryptographic failure on an otherwise
 * well-formed string) so callers can tell "this isn't an EncString" apart
 * from "this EncString was tampered with," and so raw DOMExceptions from
 * atob never escape this module to logs or UI.
 */
export class EncStringParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncStringParseError";
  }
}

function decodeBase64Part(s: string, label: string): Bytes {
  try {
    return fromBase64(s);
  } catch {
    throw new EncStringParseError(`Malformed EncString: invalid base64 in ${label}`);
  }
}

export function parseEncString(s: string): EncString {
  const dot = s.indexOf(".");
  if (dot < 0) throw new EncStringParseError("Malformed EncString: no type prefix");

  // Strict string comparison on the prefix, not Number(prefix) === 2: Number()
  // accepts " 2", "0x2", "+2", "2e0", and Number("") === 0, all of which would
  // otherwise slip past a numeric-equality check with a spelling other than
  // the exact wire format.
  const prefix = s.slice(0, dot);
  const parts = s.slice(dot + 1).split("|");

  // Type 0 (MAC-less) is rejected here, on the same footing as every other
  // unsupported type (3, 4, 5, 6, ...) — not specially handled and not
  // decrypted. See the EncString.type doc comment for why.
  if (prefix !== "2") {
    throw new EncStringParseError(`Unsupported EncString type ${JSON.stringify(prefix)}`);
  }

  if (parts.length !== 3) throw new EncStringParseError("Malformed type-2 EncString: missing mac");

  const iv = decodeBase64Part(parts[0]!, "iv");
  const ct = decodeBase64Part(parts[1]!, "ct");
  const mac = decodeBase64Part(parts[2]!, "mac");

  if (iv.length !== 16) {
    throw new EncStringParseError(`Malformed EncString: iv must be 16 bytes, got ${iv.length}`);
  }
  if (mac.length !== 32) {
    throw new EncStringParseError(`Malformed EncString: mac must be 32 bytes, got ${mac.length}`);
  }
  if (ct.length === 0 || ct.length % 16 !== 0) {
    throw new EncStringParseError(`Malformed EncString: ct must be a non-empty multiple of 16 bytes, got ${ct.length}`);
  }

  return { type: 2, iv, ct, mac };
}

export async function decryptToBytes(enc: EncString, key: SymKey): Promise<Bytes> {
  // MAC verification MUST happen before AES decryption. Reversing this order
  // turns the scheme into a padding oracle. EncString.type is always 2 here
  // (parseEncString rejects everything else), so this check is unconditional
  // — there is no MAC-less branch to accidentally fall through into.
  const mk = await crypto.subtle.importKey("raw", key.macKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", mk, concat(enc.iv, enc.ct)));
  if (!constantTimeEqual(expected, enc.mac)) throw new MacMismatchError();

  const ck = await crypto.subtle.importKey("raw", key.encKey, "AES-CBC", false, ["decrypt"]);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: enc.iv }, ck, enc.ct));
  } catch {
    throw new MacMismatchError();
  }
}

export async function decryptToString(enc: EncString, key: SymKey): Promise<string> {
  // fatal: true — a MAC-valid decrypt under the wrong encKey (or any other
  // path that yields non-UTF-8 plaintext) must fail loudly. The default
  // non-fatal TextDecoder silently substitutes U+FFFD, which would let bad
  // plaintext pass as a valid (garbled) string instead of erroring.
  return new TextDecoder("utf-8", { fatal: true }).decode(await decryptToBytes(enc, key));
}

/**
 * Produces a type-2 EncString. Encrypt-then-MAC: the HMAC covers iv || ciphertext,
 * matching what decryptToBytes verifies.
 */
export async function encryptToString(data: Bytes, key: SymKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ck = await crypto.subtle.importKey("raw", key.encKey, "AES-CBC", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ck, data));
  const mk = await crypto.subtle.importKey("raw", key.macKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", mk, concat(iv, ct)));
  return `2.${toBase64(iv)}|${toBase64(ct)}|${toBase64(mac)}`;
}
