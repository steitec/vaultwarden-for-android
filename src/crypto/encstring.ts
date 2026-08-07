import { fromBase64, toBase64, concat, constantTimeEqual, type Bytes } from "./bytes";

export type SymKey = { encKey: Bytes; macKey: Bytes };

export type EncString = {
  /** 0 = AES-256-CBC without MAC (legacy, accepted never produced), 2 = AES-256-CBC + HMAC-SHA256 */
  type: 0 | 2;
  iv: Bytes;
  ct: Bytes;
  mac: Bytes | null;
};

export class MacMismatchError extends Error {
  constructor() {
    super("EncString MAC verification failed");
    this.name = "MacMismatchError";
  }
}

export function parseEncString(s: string): EncString {
  const dot = s.indexOf(".");
  if (dot < 0) throw new Error(`Malformed EncString: no type prefix`);

  const type = Number(s.slice(0, dot));
  const parts = s.slice(dot + 1).split("|");

  if (type === 0) {
    if (parts.length !== 2) throw new Error("Malformed type-0 EncString");
    return { type: 0, iv: fromBase64(parts[0]!), ct: fromBase64(parts[1]!), mac: null };
  }

  if (type === 2) {
    if (parts.length !== 3) throw new Error("Malformed type-2 EncString: missing mac");
    return { type: 2, iv: fromBase64(parts[0]!), ct: fromBase64(parts[1]!), mac: fromBase64(parts[2]!) };
  }

  throw new Error(`Unsupported EncString type ${type}`);
}

export async function decryptToBytes(enc: EncString, key: SymKey): Promise<Bytes> {
  // MAC verification MUST happen before AES decryption. Reversing this order
  // turns the scheme into a padding oracle.
  if (enc.type === 2) {
    if (enc.mac === null) throw new MacMismatchError();
    const mk = await crypto.subtle.importKey("raw", key.macKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", mk, concat(enc.iv, enc.ct)));
    if (!constantTimeEqual(expected, enc.mac)) throw new MacMismatchError();
  }

  const ck = await crypto.subtle.importKey("raw", key.encKey, "AES-CBC", false, ["decrypt"]);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: enc.iv }, ck, enc.ct));
  } catch {
    throw new MacMismatchError();
  }
}

export async function decryptToString(enc: EncString, key: SymKey): Promise<string> {
  return new TextDecoder().decode(await decryptToBytes(enc, key));
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
