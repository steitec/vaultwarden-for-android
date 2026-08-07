import { describe, it, expect } from "vitest";
import { argon2id } from "hash-wasm";
import { wrapKeyWithPin, unwrapKeyWithPin } from "../../src/session/pin";
import type { PinWrapped } from "../../src/session/pin";
import type { SymKey } from "../../src/crypto/encstring";
import { toBase64, concat } from "../../src/crypto/bytes";

const key: SymKey = { encKey: new Uint8Array(32).fill(4), macKey: new Uint8Array(32).fill(5) };

describe("pin wrapping", () => {
  it("round-trips the key with the correct pin", async () => {
    const w = await wrapKeyWithPin(key, "135790");
    const out = await unwrapKeyWithPin(w, "135790");
    expect(toBase64(out.encKey)).toBe(toBase64(key.encKey));
    expect(toBase64(out.macKey)).toBe(toBase64(key.macKey));
  }, 20000);

  it("fails with the wrong pin", async () => {
    const w = await wrapKeyWithPin(key, "135790");
    await expect(unwrapKeyWithPin(w, "000000")).rejects.toThrow();
  }, 20000);

  it("uses a fresh random salt each time", async () => {
    const a = await wrapKeyWithPin(key, "135790");
    const b = await wrapKeyWithPin(key, "135790");
    expect(a.salt).not.toBe(b.salt);
    expect(a.ct).not.toBe(b.ct);
    // The original assertions here (salt, ct) are both satisfied by a fresh
    // salt alone, even if the IV were pinned to a constant — AES-GCM
    // ciphertext already changes whenever the key (derived from the salt)
    // changes, independent of the IV. Assert the IV directly too, so a
    // mutation that hardcodes the IV is actually caught.
    expect(a.iv).not.toBe(b.iv);
  }, 30000);

  it("rejects a pin shorter than six characters", async () => {
    await expect(wrapKeyWithPin(key, "12345")).rejects.toThrow(/six|6/i);
  });

  it("records memory-hard parameters in the wrapped blob", async () => {
    const w = await wrapKeyWithPin(key, "135790");
    expect(w.memory).toBeGreaterThanOrEqual(64);
    expect(w.iterations).toBeGreaterThanOrEqual(3);
  }, 20000);

  it("only unwraps correctly under real Argon2id — an independent reference vector must round-trip", async () => {
    // The "records memory-hard parameters" test above only checks the
    // LABELS carried in the wrapped blob; swapping the KDF implementation
    // itself out from under those labels (e.g. for PBKDF2) leaves them
    // untouched and that test green. This test instead builds a PinWrapped
    // blob using an INDEPENDENT call to argon2id (not via pin.ts) as the
    // ground truth for the wrapping key, then asks unwrapKeyWithPin to
    // decrypt it. That only succeeds if pin.ts derives the exact same
    // AES-GCM key from these parameters — i.e. only if it is really using
    // Argon2id. Any other KDF derives a different key, and AES-GCM
    // authentication then fails outright.
    const pin = "246813";
    const salt = new Uint8Array(16).fill(7);
    const iv = new Uint8Array(12).fill(9);
    const params = { iterations: 2, memory: 16, parallelism: 1 };

    const referenceKeyBytes = new Uint8Array(
      await argon2id({
        password: new TextEncoder().encode(pin),
        salt,
        iterations: params.iterations,
        memorySize: params.memory * 1024,
        parallelism: params.parallelism,
        hashLength: 32,
        outputType: "binary",
      }),
    );
    const aes = await crypto.subtle.importKey("raw", referenceKeyBytes, "AES-GCM", false, [
      "encrypt",
    ]);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, concat(key.encKey, key.macKey)),
    );

    const wrapped: PinWrapped = {
      salt: toBase64(salt),
      iv: toBase64(iv),
      ct: toBase64(ct),
      ...params,
    };

    const out = await unwrapKeyWithPin(wrapped, pin);
    expect(toBase64(out.encKey)).toBe(toBase64(key.encKey));
    expect(toBase64(out.macKey)).toBe(toBase64(key.macKey));
  }, 20000);
});
