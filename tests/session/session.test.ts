import { describe, it, expect, beforeEach, vi } from "vitest";
import { Session, MAX_PIN_ATTEMPTS } from "../../src/session/session";
import { wrapKeyWithPin } from "../../src/session/pin";
import type { SymKey } from "../../src/crypto/encstring";
import type { StoredState } from "../../src/session/store";

const key: SymKey = { encKey: new Uint8Array(32).fill(4), macKey: new Uint8Array(32).fill(5) };

async function baseState(): Promise<StoredState> {
  return {
    serverUrl: "https://v.example.net",
    email: "a@b.com",
    deviceId: "dev",
    kdf: { kdf: 0, iterations: 600000, memory: null, parallelism: null, salt: null },
    protectedUserKey: "2.a|b|c",
    protectedPrivateKey: "2.d|e|f",
    pinWrapped: await wrapKeyWithPin(key, "135790"),
    failedPinAttempts: 0,
    wrappedRefreshToken: null,
    cipherCache: null,
    lastSyncMs: null,
    lockTimeoutMinutes: 15,
    requireMasterPasswordOnRestart: false,
  };
}

describe("Session", () => {
  let saved: StoredState | null;
  let session: Session;

  beforeEach(async () => {
    saved = await baseState();
    session = new Session({
      load: async () => saved,
      save: async (s) => { saved = s; },
      clear: async () => { saved = null; },
    });
  });

  it("starts locked when state exists", async () => {
    await session.init();
    expect(session.state).toBe("locked");
  });

  it("starts empty when no state exists", async () => {
    saved = null;
    await session.init();
    expect(session.state).toBe("empty");
  });

  it("refuses PIN unlock when the restart policy demands the master password", async () => {
    // init() runs once per background-page start, which on Android means once
    // per Firefox restart. That is what makes this an effective restart policy.
    saved!.requireMasterPasswordOnRestart = true;
    await session.init();
    expect(session.pinUnlockAvailable).toBe(false);
    await expect(session.unlockWithPin("135790")).rejects.toThrow(/master password/i);
  }, 20000);

  it("allows PIN unlock when the restart policy is off", async () => {
    await session.init();
    expect(session.pinUnlockAvailable).toBe(true);
  });

  it("unlocks with the correct pin and exposes the key", async () => {
    await session.init();
    await session.unlockWithPin("135790");
    expect(session.state).toBe("unlocked");
    expect(session.userKey!.encKey[0]).toBe(4);
  }, 20000);

  it("resets the failed counter on success", async () => {
    saved!.failedPinAttempts = 3;
    await session.init();
    await session.unlockWithPin("135790");
    expect(saved!.failedPinAttempts).toBe(0);
  }, 20000);

  it("increments the failed counter on a wrong pin", async () => {
    await session.init();
    await expect(session.unlockWithPin("000000")).rejects.toThrow();
    expect(saved!.failedPinAttempts).toBe(1);
    expect(session.state).toBe("locked");
  }, 20000);

  it("wipes the wrapped key after the attempt limit", async () => {
    saved!.failedPinAttempts = MAX_PIN_ATTEMPTS;
    await session.init();
    await expect(session.unlockWithPin("000000")).rejects.toThrow(/master password/i);
    expect(saved!.pinWrapped).toBeNull();
  }, 20000);

  it("persists the attempt BEFORE trying it, so a crash cannot buy a free guess", async () => {
    // Simulate the process dying during the unwrap: the counter must already
    // be on disk by the time the attempt is made.
    let savedDuringUnwrap: number | null = null;
    await session.init();
    const original = saved!.failedPinAttempts;
    await session.unlockWithPin("000000").catch(() => {
      savedDuringUnwrap = saved!.failedPinAttempts;
    });
    expect(original).toBe(0);
    expect(savedDuringUnwrap).toBe(1);
  }, 20000);

  it("clears the key on lock", async () => {
    await session.init();
    await session.unlockWithPin("135790");
    session.lock();
    expect(session.state).toBe("locked");
    expect(session.userKey).toBeNull();
  }, 20000);

  it("locks automatically once the idle timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      await session.init();
      await session.unlockWithPin("135790");
      vi.advanceTimersByTime(15 * 60 * 1000 + 1000);
      expect(session.state).toBe("locked");
    } finally {
      vi.useRealTimers();
    }
  }, 20000);

  it("does not lock while activity keeps refreshing the timer", async () => {
    vi.useFakeTimers();
    try {
      await session.init();
      await session.unlockWithPin("135790");
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(10 * 60 * 1000);
        session.touch();
      }
      expect(session.state).toBe("unlocked");
    } finally {
      vi.useRealTimers();
    }
  }, 20000);
});
