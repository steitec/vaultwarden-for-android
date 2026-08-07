import { argon2id } from "hash-wasm";
import { utf8, toBase64, concat, type Bytes } from "./bytes";

export type KdfConfig = {
  /** 0 = PBKDF2-SHA256, 1 = Argon2id */
  kdf: 0 | 1;
  iterations: number;
  /** MiB, Argon2id only */
  memory: number | null;
  /** Argon2id only */
  parallelism: number | null;
  /** Server-supplied salt; overrides the email when non-null */
  salt: string | null;
};

function saltString(email: string, cfg: KdfConfig): string {
  return cfg.salt ?? email.trim().toLowerCase();
}

async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

async function pbkdf2(
  password: Bytes,
  salt: Bytes,
  iterations: number,
  bytes: number,
): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

export async function deriveMasterKey(
  password: string,
  email: string,
  cfg: KdfConfig,
): Promise<Bytes> {
  const salt = saltString(email, cfg);

  if (cfg.kdf === 0) {
    return pbkdf2(utf8(password), utf8(salt), cfg.iterations, 32);
  }

  if (cfg.kdf === 1) {
    if (cfg.memory === null) throw new Error("Argon2id requires kdfMemory");
    if (cfg.parallelism === null) throw new Error("Argon2id requires kdfParallelism");

    // hash-wasm's .d.ts declares the binary-output return as a bare
    // `Uint8Array`, which resolves to the widened `Uint8Array<ArrayBufferLike>`
    // (it also permits SharedArrayBuffer backing). Re-wrapping normalizes it
    // to the concrete `Bytes` (`Uint8Array<ArrayBuffer>`) this module uses
    // everywhere else — the same idiom as `sha256` and `pbkdf2` above.
    return new Uint8Array(
      await argon2id({
        password: utf8(password),
        salt: await sha256(utf8(salt)),
        iterations: cfg.iterations,
        memorySize: cfg.memory * 1024, // hash-wasm takes KiB; Bitwarden specifies MiB
        parallelism: cfg.parallelism,
        hashLength: 32,
        outputType: "binary",
      }),
    );
  }

  // KdfConfig.kdf is typed 0 | 1, but the real value arrives from
  // unvalidated server JSON (/identity/accounts/prelogin). Fail loudly
  // rather than silently falling through to the Argon2id branch.
  throw new Error(`Unknown KDF type: ${cfg.kdf}`);
}

export async function deriveMasterPasswordHash(
  masterKey: Bytes,
  password: string,
): Promise<string> {
  return toBase64(await pbkdf2(masterKey, utf8(password), 1, 32));
}

/**
 * HKDF-Expand only, with the master key used directly as the pseudorandom key.
 * There is no extract step; this is Bitwarden's scheme, not RFC 5869 in full.
 */
async function hkdfExpand(prk: Bytes, info: string, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const out = new Uint8Array(bytes);
  let previous: Bytes = new Uint8Array(0);
  let filled = 0;
  for (let counter = 1; filled < bytes; counter++) {
    const block = concat(previous, utf8(info), new Uint8Array([counter]));
    const t = new Uint8Array(await crypto.subtle.sign("HMAC", key, block));
    const take = Math.min(t.length, bytes - filled);
    out.set(t.subarray(0, take), filled);
    filled += take;
    previous = t;
  }
  return out;
}

export async function stretchMasterKey(
  masterKey: Bytes,
): Promise<{ encKey: Bytes; macKey: Bytes }> {
  return {
    encKey: await hkdfExpand(masterKey, "enc", 32),
    macKey: await hkdfExpand(masterKey, "mac", 32),
  };
}
