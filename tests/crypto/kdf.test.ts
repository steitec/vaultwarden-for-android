import { describe, it, expect } from "vitest";
import { deriveMasterKey, deriveMasterPasswordHash, stretchMasterKey, type KdfConfig } from "../../src/crypto/kdf";
import { toBase64 } from "../../src/crypto/bytes";

const pbkdf2Cfg: KdfConfig = { kdf: 0, iterations: 600000, memory: null, parallelism: null, salt: null };

describe("deriveMasterKey", () => {
  it("derives a 32-byte key with PBKDF2", async () => {
    const k = await deriveMasterKey("p4ssw0rd", "user@example.com", { ...pbkdf2Cfg, iterations: 100 });
    expect(k.length).toBe(32);
  });

  it("lowercases and trims the email used as salt", async () => {
    const a = await deriveMasterKey("p4ssw0rd", "  User@Example.COM ", { ...pbkdf2Cfg, iterations: 100 });
    const b = await deriveMasterKey("p4ssw0rd", "user@example.com", { ...pbkdf2Cfg, iterations: 100 });
    expect(toBase64(a)).toBe(toBase64(b));
  });

  it("prefers a server-supplied salt over the email", async () => {
    const withSalt = await deriveMasterKey("p4ssw0rd", "user@example.com", {
      ...pbkdf2Cfg, iterations: 100, salt: "server-salt",
    });
    const withEmail = await deriveMasterKey("p4ssw0rd", "user@example.com", { ...pbkdf2Cfg, iterations: 100 });
    expect(toBase64(withSalt)).not.toBe(toBase64(withEmail));
  });

  it("derives a 32-byte key with Argon2id", async () => {
    const k = await deriveMasterKey("p4ssw0rd", "user@example.com", {
      kdf: 1, iterations: 3, memory: 64, parallelism: 4, salt: null,
    });
    expect(k.length).toBe(32);
  });

  it("produces different keys for the two KDF types", async () => {
    const a = await deriveMasterKey("p4ssw0rd", "user@example.com", { ...pbkdf2Cfg, iterations: 3 });
    const b = await deriveMasterKey("p4ssw0rd", "user@example.com", {
      kdf: 1, iterations: 3, memory: 64, parallelism: 4, salt: null,
    });
    expect(toBase64(a)).not.toBe(toBase64(b));
  });

  it("rejects an Argon2id config missing memory or parallelism", async () => {
    await expect(
      deriveMasterKey("p4ssw0rd", "user@example.com", { kdf: 1, iterations: 3, memory: null, parallelism: 4, salt: null }),
    ).rejects.toThrow(/memory/i);
  });
});

describe("deriveMasterPasswordHash", () => {
  it("is a single-iteration PBKDF2 of the master key salted by the password", async () => {
    const mk = new Uint8Array(32).fill(7);
    const h = await deriveMasterPasswordHash(mk, "p4ssw0rd");
    // Independently computed with Node's crypto.pbkdf2Sync — see Step 2.
    expect(h).toBe("A9/I8NctQ2B/f1Eb8hElwi9Gj6Qn/ma+eF5MJ60X3FA=");
  });

  it("changes when the password changes", async () => {
    const mk = new Uint8Array(32).fill(7);
    expect(await deriveMasterPasswordHash(mk, "a")).not.toBe(await deriveMasterPasswordHash(mk, "b"));
  });
});

describe("stretchMasterKey", () => {
  it("expands to two distinct 32-byte halves", async () => {
    const mk = new Uint8Array(32).fill(7);
    const { encKey, macKey } = await stretchMasterKey(mk);
    expect(encKey.length).toBe(32);
    expect(macKey.length).toBe(32);
    expect(toBase64(encKey)).not.toBe(toBase64(macKey));
  });

  it("is deterministic", async () => {
    const mk = new Uint8Array(32).fill(7);
    const a = await stretchMasterKey(mk);
    const b = await stretchMasterKey(mk);
    expect(toBase64(a.encKey)).toBe(toBase64(b.encKey));
  });
});
