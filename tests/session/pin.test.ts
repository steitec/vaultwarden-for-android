import { describe, it, expect } from "vitest";
import { wrapKeyWithPin, unwrapKeyWithPin } from "../../src/session/pin";
import type { SymKey } from "../../src/crypto/encstring";
import { toBase64 } from "../../src/crypto/bytes";

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
  }, 30000);

  it("rejects a pin shorter than six characters", async () => {
    await expect(wrapKeyWithPin(key, "12345")).rejects.toThrow(/six|6/i);
  });

  it("records memory-hard parameters in the wrapped blob", async () => {
    const w = await wrapKeyWithPin(key, "135790");
    expect(w.memory).toBeGreaterThanOrEqual(64);
    expect(w.iterations).toBeGreaterThanOrEqual(3);
  }, 20000);
});
