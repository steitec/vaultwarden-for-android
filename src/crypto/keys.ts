import { parseEncString, decryptToBytes, EncStringParseError, type SymKey } from "./encstring";
import { stretchMasterKey } from "./kdf";
import { fromBase64, zero, type Bytes } from "./bytes";

/**
 * Distinct from MacMismatchError on purpose: MacMismatchError means "the
 * symmetric MAC didn't verify," which callers reasonably read as "wrong
 * master password" (e.g. on the unwrapUserKey path) and may react to by
 * re-prompting for it. An organization key failing to unwrap via RSA-OAEP
 * is a different failure — the master password may be entirely correct —
 * so it gets its own error rather than overloading MacMismatchError's
 * meaning.
 */
export class KeyUnwrapError extends Error {
  constructor() {
    super("Organization key unwrap failed");
    this.name = "KeyUnwrapError";
  }
}

export function splitSymKey(raw: Bytes): SymKey {
  if (raw.length !== 64) {
    throw new Error(`Expected a 64-byte symmetric key, got ${raw.length}`);
  }
  return { encKey: raw.slice(0, 32), macKey: raw.slice(32, 64) };
}

export async function unwrapUserKey(protectedKey: string, masterKey: Bytes): Promise<SymKey> {
  const stretched = await stretchMasterKey(masterKey);
  try {
    const raw = await decryptToBytes(parseEncString(protectedKey), stretched);
    try {
      return splitSymKey(raw);
    } finally {
      // raw is a second, now-redundant copy of the 64-byte key: splitSymKey
      // has already copied both halves out via .slice(). Zero it rather than
      // leaving a plaintext key-equivalent resident for the GC to collect on
      // its own schedule.
      zero(raw);
    }
  } finally {
    // The stretched master key is password-equivalent key material with no
    // further use after this call — same standard applied to the master key
    // itself in Task 3 (binary, not hex, Argon2id output specifically so it
    // stays wipeable).
    zero(stretched.encKey);
    zero(stretched.macKey);
  }
}

export async function unwrapPrivateKey(
  protectedPrivateKey: string,
  userKey: SymKey,
): Promise<CryptoKey> {
  const pkcs8 = await decryptToBytes(parseEncString(protectedPrivateKey), userKey);
  try {
    // crypto.subtle.importKey copies the key material into its own
    // (non-extractable) internal representation, so it is safe to zero our
    // copy once the returned promise settles.
    return await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "RSA-OAEP", hash: "SHA-1" },
      false,
      ["decrypt"],
    );
  } finally {
    zero(pkcs8);
  }
}

/**
 * Organization keys arrive as type-4 EncStrings: RSA-2048 OAEP-SHA1, ciphertext
 * only, no iv and no mac. This does NOT go through parseEncString — that
 * parser is exclusively for the symmetric (type-2) wire format, which
 * always carries an iv and a mac. Type 4 is asymmetric and ciphertext-only,
 * so it gets its own minimal parser here rather than forcing it through a
 * shape it doesn't have. That parser mirrors parseEncString's strictness:
 * exact-string prefix comparison (not Number(), which accepts spellings
 * like " 4", "+4", "4e0", "0x4", and non-ASCII digit forms), exactly one
 * part after the dot (a genuine type-4 string contains no "|"), base64
 * decoding failures reported as EncStringParseError rather than a raw
 * DOMException, and RSA unwrap failures reported as a distinct,
 * classifiable error (KeyUnwrapError) rather than escaping as a bare
 * platform OperationError.
 */
export async function unwrapOrgKey(
  protectedOrgKey: string,
  privateKey: CryptoKey,
): Promise<SymKey> {
  const dot = protectedOrgKey.indexOf(".");
  if (dot < 0) throw new EncStringParseError("Malformed organization key: no type prefix");

  // Strict string comparison, not Number(prefix) === 4: Number() accepts
  // " 4", "0x4", "+4", "4e0", full-width and other non-ASCII digit forms,
  // etc. — see parseEncString's identical rationale.
  const prefix = protectedOrgKey.slice(0, dot);
  if (prefix !== "4") {
    throw new EncStringParseError(`Expected a type-4 organization key, got type ${JSON.stringify(prefix)}`);
  }

  // A genuine type-4 string is ciphertext-only: no "|"-separated iv or mac
  // parts. Reject anything with extra parts instead of silently discarding
  // them, matching parseEncString's exact part-count strictness.
  const parts = protectedOrgKey.slice(dot + 1).split("|");
  if (parts.length !== 1) {
    throw new EncStringParseError("Malformed type-4 organization key: unexpected extra parts");
  }

  let ct: Bytes;
  try {
    ct = fromBase64(parts[0]!);
  } catch {
    // atob throws a raw DOMException on invalid base64. Never let that
    // escape this module uncategorized — same invariant encstring.ts
    // enforces via decodeBase64Part.
    throw new EncStringParseError("Malformed organization key: invalid base64 ciphertext");
  }

  let raw: Bytes;
  try {
    raw = new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, ct));
  } catch {
    throw new KeyUnwrapError();
  }
  try {
    return splitSymKey(raw);
  } finally {
    zero(raw);
  }
}

/**
 * Unwraps every organization key an account holds, in one step: the RSA
 * private key comes out from under the user key, and each organization key
 * comes out from under that.
 *
 * Shared by the two places that have to do this — the master-password login
 * and the offline-cache load after a PIN unlock — because they must agree on
 * the failure behaviour, not merely on the happy path:
 *
 *  - No organizations means no private-key unwrap at all. An account in no
 *    organization is the common case, and it must not be able to fail on a
 *    `protectedPrivateKey` it never needs.
 *  - One unreadable organization is skipped rather than fatal: its items
 *    surface as undecryptable and the rest of the vault still loads.
 *  - A private key that will not unwrap DOES throw. It is not per-org
 *    damage, and the two callers want different things from it (the login
 *    fails; the cache load treats every org item as undecryptable), so this
 *    decides nothing on their behalf. That throw happens before any
 *    organization key has been unwrapped, so it never orphans key material
 *    the caller would have had to zero.
 *
 * `organizations` is structurally typed rather than imported from api/types:
 * this module stays free of the API layer.
 */
export async function unwrapOrgKeyMap(
  protectedPrivateKey: string,
  organizations: readonly { id: string; key: string }[],
  userKey: SymKey,
): Promise<Map<string, SymKey>> {
  const orgKeys = new Map<string, SymKey>();
  if (organizations.length === 0) return orgKeys;

  const privateKey = await unwrapPrivateKey(protectedPrivateKey, userKey);
  for (const org of organizations) {
    try {
      orgKeys.set(org.id, await unwrapOrgKey(org.key, privateKey));
    } catch {
      // One unreadable organization must not prevent the rest of the vault
      // from loading; its items surface as undecryptable.
    }
  }
  return orgKeys;
}

/**
 * Newer items carry their own key, wrapped under the user key or, for
 * organization items, under that organization's key. Ignoring this field breaks
 * decryption of newer items only, so it must be handled from the start.
 *
 * `protectedCipherKey` accepts `undefined` as well as `null`: the field
 * arrives from unvalidated server JSON, where an omitted key is `undefined`
 * rather than `null`.
 *
 * When the cipher carries no key of its own, this returns `parentKey`
 * itself — not a copy. The returned SymKey's `encKey`/`macKey` buffers are
 * the exact same ArrayBuffers backing the caller's user/org key. Do not
 * zero a SymKey returned from this branch believing it is a standalone
 * per-cipher key: doing so would zero the parent key it is aliasing (e.g.
 * a future session.lock() that zeroes key buffers in place). A defensive
 * copy here was deliberately not added — it would silently break that
 * identity relationship, and the parent key's own lifetime already governs
 * this case correctly.
 */
export async function unwrapCipherKey(
  protectedCipherKey: string | null | undefined,
  parentKey: SymKey,
): Promise<SymKey> {
  if (protectedCipherKey == null) return parentKey;
  const raw = await decryptToBytes(parseEncString(protectedCipherKey), parentKey);
  try {
    return splitSymKey(raw);
  } finally {
    zero(raw);
  }
}
