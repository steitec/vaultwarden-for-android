import { describe, it, expect } from "vitest";
import { isStoredState } from "../../src/session/store";
import type { StoredState } from "../../src/session/store";

const good: StoredState = {
  serverUrl: "https://v.example.net",
  email: "a@b.com",
  deviceId: "dev",
  kdf: { kdf: 0, iterations: 600000, memory: null, parallelism: null, salt: null },
  protectedUserKey: "2.a|b|c",
  protectedPrivateKey: "2.d|e|f",
  pinWrapped: { salt: "s", iv: "i", ct: "c", iterations: 4, memory: 64, parallelism: 4 },
  failedPinAttempts: 0,
  wrappedRefreshToken: null,
  cipherCache: null,
  lastSyncMs: null,
  lockTimeoutMinutes: 15,
  requireMasterPasswordOnRestart: false,
};

describe("isStoredState", () => {
  it("accepts a well-formed record", () => {
    expect(isStoredState(good)).toBe(true);
  });

  it("accepts a null pinWrapped", () => {
    expect(isStoredState({ ...good, pinWrapped: null })).toBe(true);
  });

  it("accepts an Argon2id kdf with numeric memory/parallelism", () => {
    expect(
      isStoredState({
        ...good,
        kdf: { kdf: 1, iterations: 3, memory: 64, parallelism: 4, salt: "abc" },
      }),
    ).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isStoredState(undefined)).toBe(false);
    expect(isStoredState(null)).toBe(false);
    expect(isStoredState("nope")).toBe(false);
    expect(isStoredState(42)).toBe(false);
    expect(isStoredState([])).toBe(false);
    expect(isStoredState({})).toBe(false);
  });

  it("rejects a missing kdf field entirely", () => {
    const { kdf: _kdf, ...rest } = good;
    expect(isStoredState(rest)).toBe(false);
  });

  it("rejects a malformed kdf", () => {
    expect(isStoredState({ ...good, kdf: "nope" })).toBe(false);
    expect(isStoredState({ ...good, kdf: {} })).toBe(false);
    expect(isStoredState({ ...good, kdf: { ...good.kdf, kdf: 2 } })).toBe(false);
  });

  it("rejects a missing pinWrapped field entirely", () => {
    const { pinWrapped: _pinWrapped, ...rest } = good;
    expect(isStoredState(rest)).toBe(false);
  });

  it("rejects a malformed non-null pinWrapped", () => {
    expect(isStoredState({ ...good, pinWrapped: "lol" })).toBe(false);
    expect(isStoredState({ ...good, pinWrapped: {} })).toBe(false);
    expect(
      isStoredState({ ...good, pinWrapped: { ...good.pinWrapped, salt: 5 } }),
    ).toBe(false);
  });

  it("rejects a non-finite lockTimeoutMinutes", () => {
    expect(isStoredState({ ...good, lockTimeoutMinutes: NaN })).toBe(false);
    expect(isStoredState({ ...good, lockTimeoutMinutes: Infinity })).toBe(false);
  });

  it("rejects a non-finite failedPinAttempts", () => {
    expect(isStoredState({ ...good, failedPinAttempts: NaN })).toBe(false);
  });

  it("rejects a non-number, non-null lastSyncMs", () => {
    expect(isStoredState({ ...good, lastSyncMs: "x" })).toBe(false);
  });

  it("accepts a numeric lastSyncMs", () => {
    expect(isStoredState({ ...good, lastSyncMs: 12345 })).toBe(true);
  });

  it("rejects a non-string, non-null wrappedRefreshToken", () => {
    expect(isStoredState({ ...good, wrappedRefreshToken: 5 })).toBe(false);
  });

  it("rejects a non-string, non-null cipherCache", () => {
    expect(isStoredState({ ...good, cipherCache: 5 })).toBe(false);
  });

  it("rejects a non-boolean requireMasterPasswordOnRestart", () => {
    expect(isStoredState({ ...good, requireMasterPasswordOnRestart: "yes" })).toBe(false);
  });
});
