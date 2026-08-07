import { argon2id } from "hash-wasm";
import { utf8, toBase64, concat } from "./bytes";

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

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

async function pbkdf2(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  bytes: number,
): Promise<Uint8Array> {
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
): Promise<Uint8Array> {
  const salt = saltString(email, cfg);

  if (cfg.kdf === 0) {
    return pbkdf2(utf8(password), utf8(salt), cfg.iterations, 32);
  }

  if (cfg.memory === null) throw new Error("Argon2id requires kdfMemory");
  if (cfg.parallelism === null) throw new Error("Argon2id requires kdfParallelism");

  const hex = await argon2id({
    password: utf8(password),
    salt: await sha256(utf8(salt)),
    iterations: cfg.iterations,
    memorySize: cfg.memory * 1024, // hash-wasm takes KiB; Bitwarden specifies MiB
    parallelism: cfg.parallelism,
    hashLength: 32,
    outputType: "hex",
  });

  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function deriveMasterPasswordHash(
  masterKey: Uint8Array,
  password: string,
): Promise<string> {
  return toBase64(await pbkdf2(masterKey, utf8(password), 1, 32));
}

/**
 * HKDF-Expand only, with the master key used directly as the pseudorandom key.
 * There is no extract step; this is Bitwarden's scheme, not RFC 5869 in full.
 */
async function hkdfExpand(prk: Uint8Array, info: string, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const out = new Uint8Array(bytes);
  let previous = new Uint8Array(0);
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
  masterKey: Uint8Array,
): Promise<{ encKey: Uint8Array; macKey: Uint8Array }> {
  return {
    encKey: await hkdfExpand(masterKey, "enc", 32),
    macKey: await hkdfExpand(masterKey, "mac", 32),
  };
}
