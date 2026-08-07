import { parseEncString, decryptToBytes, MacMismatchError, type SymKey } from "./encstring";
import { stretchMasterKey } from "./kdf";
import { fromBase64, type Bytes } from "./bytes";

export function splitSymKey(raw: Bytes): SymKey {
  if (raw.length !== 64) {
    throw new Error(`Expected a 64-byte symmetric key, got ${raw.length}`);
  }
  return { encKey: raw.slice(0, 32), macKey: raw.slice(32, 64) };
}

export async function unwrapUserKey(protectedKey: string, masterKey: Bytes): Promise<SymKey> {
  const stretched = await stretchMasterKey(masterKey);
  const raw = await decryptToBytes(parseEncString(protectedKey), stretched);
  return splitSymKey(raw);
}

export async function unwrapPrivateKey(
  protectedPrivateKey: string,
  userKey: SymKey,
): Promise<CryptoKey> {
  const pkcs8 = await decryptToBytes(parseEncString(protectedPrivateKey), userKey);
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSA-OAEP", hash: "SHA-1" },
    false,
    ["decrypt"],
  );
}

/**
 * Organization keys arrive as type-4 EncStrings: RSA-2048 OAEP-SHA1, ciphertext
 * only, no iv and no mac. This does NOT go through parseEncString — that
 * parser is exclusively for the symmetric (type-2) wire format, which
 * always carries an iv and a mac. Type 4 is asymmetric and ciphertext-only,
 * so it gets its own minimal parser here rather than forcing it through a
 * shape it doesn't have.
 */
export async function unwrapOrgKey(
  protectedOrgKey: string,
  privateKey: CryptoKey,
): Promise<SymKey> {
  const dot = protectedOrgKey.indexOf(".");
  if (dot < 0) throw new Error("Malformed organization key: no type prefix");

  // Strict string comparison, not Number(prefix) === 4: Number() accepts
  // " 4", "0x4", "+4", "4e0", etc. — see parseEncString's identical rationale.
  const prefix = protectedOrgKey.slice(0, dot);
  if (prefix !== "4") {
    throw new Error(`Expected a type-4 organization key, got type ${JSON.stringify(prefix)}`);
  }

  const ct = fromBase64(protectedOrgKey.slice(dot + 1).split("|")[0]!);
  let raw: Bytes;
  try {
    raw = new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, ct));
  } catch {
    throw new MacMismatchError();
  }
  return splitSymKey(raw);
}

/**
 * Newer items carry their own key, wrapped under the user key or, for
 * organization items, under that organization's key. Ignoring this field breaks
 * decryption of newer items only, so it must be handled from the start.
 */
export async function unwrapCipherKey(
  protectedCipherKey: string | null,
  parentKey: SymKey,
): Promise<SymKey> {
  if (protectedCipherKey === null) return parentKey;
  const raw = await decryptToBytes(parseEncString(protectedCipherKey), parentKey);
  return splitSymKey(raw);
}
