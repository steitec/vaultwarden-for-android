import { argon2id } from "hash-wasm";
import { utf8, toBase64, fromBase64, concat, type Bytes } from "../crypto/bytes";
import { splitSymKey } from "../crypto/keys";
import type { SymKey } from "../crypto/encstring";

export type PinWrapped = {
  salt: string;
  iv: string;
  ct: string;
  iterations: number;
  /** MiB */
  memory: number;
  parallelism: number;
};

/**
 * A six-digit PIN carries roughly 20 bits of entropy, so the wrapping KDF is the
 * only thing standing between an extracted storage blob and the vault key.
 * Argon2id is used rather than PBKDF2 specifically because it is memory-hard.
 */
const PARAMS = { iterations: 4, memory: 64, parallelism: 4 } as const;
export const MIN_PIN_LENGTH = 6;

/**
 * Plain-`number` shape (not `typeof PARAMS`, whose `as const` fields are the
 * literal types 4/64/4): `unwrapKeyWithPin` reconstructs these from a stored
 * `PinWrapped`, whose fields are ordinary `number`, so the parameter type
 * must accept that rather than only the literal defaults.
 */
type PinParams = { iterations: number; memory: number; parallelism: number };

async function pinKey(pin: string, salt: Uint8Array, p: PinParams): Promise<CryptoKey> {
  // hash-wasm's binary-output return widens to Uint8Array<ArrayBufferLike>
  // (permits SharedArrayBuffer backing); re-wrap to the concrete Bytes this
  // module uses everywhere else, matching kdf.ts's identical idiom.
  const raw: Bytes = new Uint8Array(
    await argon2id({
      password: utf8(pin),
      salt,
      iterations: p.iterations,
      memorySize: p.memory * 1024,
      parallelism: p.parallelism,
      hashLength: 32,
      outputType: "binary",
    }),
  );
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function wrapKeyWithPin(key: SymKey, pin: string): Promise<PinWrapped> {
  if (pin.length < MIN_PIN_LENGTH) {
    throw new Error(`PIN must be at least six characters`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await pinKey(pin, salt, PARAMS);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, concat(key.encKey, key.macKey)),
  );
  return { salt: toBase64(salt), iv: toBase64(iv), ct: toBase64(ct), ...PARAMS };
}

export async function unwrapKeyWithPin(wrapped: PinWrapped, pin: string): Promise<SymKey> {
  const aes = await pinKey(pin, fromBase64(wrapped.salt), {
    iterations: wrapped.iterations,
    memory: wrapped.memory,
    parallelism: wrapped.parallelism,
  });
  const raw = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(wrapped.iv) },
      aes,
      fromBase64(wrapped.ct),
    ),
  );
  return splitSymKey(raw);
}
