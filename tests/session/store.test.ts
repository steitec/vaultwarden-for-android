import { describe, it, expect, afterEach, vi } from "vitest";
import { browserStore, isStoredState } from "../../src/session/store";
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
  unlockMode: "pin",
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

describe("isStoredState and the unlock mode", () => {
  it("accepts a record in session mode", () => {
    expect(isStoredState({ ...good, unlockMode: "session", pinWrapped: null })).toBe(true);
  });

  it("rejects an unlock mode it does not know", () => {
    expect(isStoredState({ ...good, unlockMode: "none" })).toBe(false);
    expect(isStoredState({ ...good, unlockMode: 1 })).toBe(false);
  });

  // The guard stays strict. What rescues an old record is the separate
  // default applied before validation, not a hole in the guard itself.
  it("rejects a record with no unlockMode at all", () => {
    const missing: Record<string, unknown> = { ...good };
    delete missing.unlockMode;
    expect(isStoredState(missing)).toBe(false);
  });
});

describe("browserStore.load", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubStorage(record: unknown): void {
    vi.stubGlobal("browser", {
      storage: { local: { get: async () => ({ state: record }) } },
    });
  }

  // The record in daily use since 2026-08-29 has no unlockMode. Without the
  // default applied ahead of the guard, load() returns null, the session
  // reads "empty", and the add-on shows the setup screen: a silent sign-out
  // that also drops the offline cache.
  it("reads a record written before unlockMode existed as pin", async () => {
    const legacy: Record<string, unknown> = { ...good };
    delete legacy.unlockMode;
    stubStorage(legacy);
    const loaded = await browserStore.load();
    expect(loaded?.unlockMode).toBe("pin");
  });

  it("leaves an explicit session mode alone", async () => {
    stubStorage({ ...good, unlockMode: "session", pinWrapped: null });
    const loaded = await browserStore.load();
    expect(loaded?.unlockMode).toBe("session");
  });

  // The default fills one specific gap. It is not a repair shop.
  it("does not rescue a record that is broken for another reason", async () => {
    const broken: Record<string, unknown> = { ...good, kdf: null };
    delete broken.unlockMode;
    stubStorage(broken);
    expect(await browserStore.load()).toBeNull();
  });
});
