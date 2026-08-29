import { describe, it, expect, beforeEach, vi } from "vitest";
import { Session, MAX_PIN_ATTEMPTS, PinAttemptsExhaustedError } from "../../src/session/session";
import { wrapKeyWithPin } from "../../src/session/pin";
import type { SymKey } from "../../src/crypto/encstring";
import type { StoredState } from "../../src/session/store";

function cloneStoredState(s: StoredState): StoredState {
  return {
    ...s,
    kdf: { ...s.kdf },
    pinWrapped: s.pinWrapped === null ? null : { ...s.pinWrapped },
  };
}

function allZero(b: Uint8Array): boolean {
  return b.every((byte) => byte === 0);
}

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
    unlockMode: "pin",
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
    // The naive version of this test (read `saved.failedPinAttempts` inside
    // a .catch() after the whole unlockWithPin() promise has settled) is
    // vacuous: the fake store's `save` hands Session back the SAME object
    // reference it just mutated, so by the time the promise rejects, BOTH
    // orderings — charge-then-unwrap, or unwrap-then-charge-on-catch —
    // have already written failedPinAttempts = 1. Reading the end state
    // can't distinguish them.
    //
    // To actually pin the ordering: record a deep COPY on every `save`
    // call, and inspect that history WHILE the (real, slow) Argon2id
    // unwrap is still in flight — i.e. before unlockWithPin's promise can
    // possibly have settled. If the counter is charged and saved before
    // the unwrap attempt, that first save is already on record well
    // before the probe below runs.
    const history: StoredState[] = [];
    const probeSession = new Session({
      load: async () => saved,
      save: async (s) => {
        history.push(cloneStoredState(s));
        saved = s;
      },
      clear: async () => {
        saved = null;
      },
    });
    await probeSession.init();
    expect(saved!.failedPinAttempts).toBe(0);

    const unlockPromise = probeSession.unlockWithPin("000000");
    // Argon2id at these parameters takes several hundred ms in this suite
    // (see the pin.test.ts timings) — 30ms is comfortably inside that
    // window without being so long the probe risks racing a slow CI host
    // in the other direction.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(history.length).toBeGreaterThan(0);
    expect(history[0]!.failedPinAttempts).toBe(1);

    await expect(unlockPromise).rejects.toThrow();
    expect(saved!.failedPinAttempts).toBe(1);
  }, 20000);

  it("clears the key on lock", async () => {
    await session.init();
    await session.unlockWithPin("135790");
    session.lock();
    expect(session.state).toBe("locked");
    expect(session.userKey).toBeNull();
  }, 20000);

  it("actually zeroes every key buffer on lock, not just the references", async () => {
    // "clears the key on lock" above only proves session.userKey becomes
    // null — it says nothing about the bytes the OLD buffer held, so a
    // regression that deletes the zero() calls inside lock() while still
    // nulling the fields would leave that test green. Capture the live
    // buffers (by identity) before locking, and a seeded org key alongside
    // them, then assert every byte of each is actually zero afterwards.
    await session.init();
    await session.unlockWithPin("135790");
    const userEnc = session.userKey!.encKey;
    const userMac = session.userKey!.macKey;

    const orgKey: SymKey = { encKey: new Uint8Array(32).fill(7), macKey: new Uint8Array(32).fill(8) };
    session.orgKeys.set("org-1", orgKey);

    session.lock();

    expect(allZero(userEnc)).toBe(true);
    expect(allZero(userMac)).toBe(true);
    expect(allZero(orgKey.encKey)).toBe(true);
    expect(allZero(orgKey.macKey)).toBe(true);
  }, 20000);

  it("tells its owner it locked, on every path out of the unlocked state", async () => {
    // Session.lock() zeroes the key buffers, but the plaintext those keys
    // produced lives in the Controller, which the Session knows nothing
    // about. The idle timer, signOut() and init()'s re-entrancy guard all
    // reach lock() without anyone calling Controller.lock() first, so
    // without this notification the 15-minute idle timeout leaves every
    // cleartext password resident in the background page's heap.
    const locks: string[] = [];
    session.onLock = () => locks.push(session.state);

    await session.init();
    await session.unlockWithPin("135790");
    session.lock();
    expect(locks).toEqual(["locked"]);

    // The idle timer.
    vi.useFakeTimers();
    try {
      await session.unlockWithPin("135790");
      vi.advanceTimersByTime(15 * 60 * 1000 + 1000);
    } finally {
      vi.useRealTimers();
    }
    expect(locks).toEqual(["locked", "locked"]);

    // init() re-entered while unlocked.
    await session.unlockWithPin("135790");
    await session.init();
    expect(locks).toEqual(["locked", "locked", "locked"]);

    // signOut(), which locks before it wipes the device.
    await session.unlockWithPin("135790");
    await session.signOut();
    expect(locks).toHaveLength(4);
  }, 40000);

  it("zeroes the organization keys it replaces", async () => {
    // Same discipline as adoptLogin and unlockWithPin: dropping the
    // reference to a Uint8Array that still holds live key bytes leaves it
    // in the heap until the GC happens to run.
    await session.init();
    await session.unlockWithPin("135790");
    const old: SymKey = {
      encKey: new Uint8Array(32).fill(7),
      macKey: new Uint8Array(32).fill(8),
    };
    session.orgKeys.set("org-1", old);

    const fresh: SymKey = {
      encKey: new Uint8Array(32).fill(9),
      macKey: new Uint8Array(32).fill(10),
    };
    session.adoptOrgKeys(new Map([["org-1", fresh]]));

    expect(allZero(old.encKey)).toBe(true);
    expect(allZero(old.macKey)).toBe(true);
    expect(session.orgKeys.get("org-1")).toBe(fresh);
    expect(allZero(fresh.encKey)).toBe(false);
  }, 20000);

  it("refuses to install organization keys into a session that is no longer unlocked", async () => {
    // Rebuilding the org keys is several awaits long (an RSA unwrap per
    // organization), and the idle timer can fire in the middle of it.
    // Installing the result afterwards would leave a LOCKED session holding
    // live organization keys that nothing would zero until the next lock —
    // precisely the state lock() exists to prevent.
    await session.init();
    const fresh: SymKey = {
      encKey: new Uint8Array(32).fill(9),
      macKey: new Uint8Array(32).fill(10),
    };

    session.adoptOrgKeys(new Map([["org-1", fresh]]));

    expect(session.orgKeys.size).toBe(0);
    expect(allZero(fresh.encKey)).toBe(true);
    expect(allZero(fresh.macKey)).toBe(true);
  });

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

  it("settings returns a copy, so mutating it cannot defeat the lockout counter", async () => {
    await session.init();
    const s = session.settings!;
    s.failedPinAttempts = 999;
    s.kdf.iterations = 1;
    // The live store, and a freshly-read copy, must both be unaffected.
    expect(saved!.failedPinAttempts).toBe(0);
    expect(session.settings!.failedPinAttempts).toBe(0);
    expect(session.settings!.kdf.iterations).toBe(600000);
  });

  it("re-running init() while already unlocked zeroes the stale key instead of leaking it", async () => {
    // A prior version of init() assigned `state = "locked"` directly on
    // re-entry, which left `userKey` populated with live key material (and
    // the idle timer still pending) even though the session now reports
    // itself locked. init() must go through lock()'s cleanup instead.
    await session.init();
    await session.unlockWithPin("135790");
    const oldEnc = session.userKey!.encKey;

    await session.init();

    expect(session.state).toBe("locked");
    expect(session.userKey).toBeNull();
    expect(allZero(oldEnc)).toBe(true);
  }, 20000);

  it("treats an undefined pinWrapped (a corrupt/partial stored record) the same as null", async () => {
    await session.init();
    // Simulate a storage read that produced `undefined` rather than an
    // explicit `null` for a missing field. StoredState types this field as
    // PinWrapped | null, but the runtime storage boundary is untyped, so a
    // corrupt/partial record could still produce undefined in practice.
    // `saved` is the same object session.init() already loaded (the fake
    // store hands back the live reference), so mutating it here reaches
    // the session's internal state without touching any private field.
    (saved as { pinWrapped: unknown }).pinWrapped = undefined;

    await expect(session.unlockWithPin("135790")).rejects.toThrow(PinAttemptsExhaustedError);
    // Must be rejected by the "no pin available" guard, before any attempt
    // is charged — exactly like the explicit-null case.
    expect(saved!.failedPinAttempts).toBe(0);
  }, 20000);

  it("signOut zeroes the live keys AND clears the persisted state", async () => {
    // lock() alone leaves protectedUserKey, pinWrapped, wrappedRefreshToken
    // and the cipherCache sitting in browser.storage.local indefinitely.
    // signOut is the only path that takes them off the device.
    await session.init();
    await session.unlockWithPin("135790");
    const enc = session.userKey!.encKey;
    const mac = session.userKey!.macKey;

    await session.signOut();

    expect(allZero(enc)).toBe(true);
    expect(allZero(mac)).toBe(true);
    expect(session.userKey).toBeNull();
    expect(saved).toBeNull();
    expect(session.state).toBe("empty");
    expect(session.settings).toBeNull();
    expect(session.pinUnlockAvailable).toBe(false);
  }, 20000);

  it("zeroes the previous key buffer when unlocking an already-unlocked session", async () => {
    await session.init();
    await session.unlockWithPin("135790");
    const oldEnc = session.userKey!.encKey;
    const oldMac = session.userKey!.macKey;

    await session.unlockWithPin("135790");

    expect(allZero(oldEnc)).toBe(true);
    expect(allZero(oldMac)).toBe(true);
    // The new key is a fresh decrypt of the same underlying key material,
    // so it must still hold the correct (unzeroed) bytes.
    expect(session.userKey!.encKey[0]).toBe(4);
    expect(session.userKey!.macKey[0]).toBe(5);
  }, 20000);

  describe("the idle deadline", () => {
    // The test the night of 2026-08-27 would have failed. Advancing the system
    // clock WITHOUT advancing timers is the frozen-process case exactly:
    // wall-clock time passes, no callback ever runs. See
    // docs/VERIFICATION-2026-08-25.md § F-4.
    it("locks on the next check when the deadline passed while nothing ran", async () => {
      vi.useFakeTimers();
      try {
        await session.init();
        await session.unlockWithPin("135790");
        expect(session.state).toBe("unlocked");

        vi.setSystemTime(Date.now() + 16 * 60 * 1000);
        session.lockIfExpired();

        expect(session.state).toBe("locked");
        expect(session.userKey).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not lock while the deadline is still ahead", async () => {
      vi.useFakeTimers();
      try {
        await session.init();
        await session.unlockWithPin("135790");

        vi.setSystemTime(Date.now() + 14 * 60 * 1000);
        session.lockIfExpired();

        expect(session.state).toBe("unlocked");
      } finally {
        vi.useRealTimers();
      }
    });

    // A timeout of 0 means "never". A deadline left behind by an earlier
    // setting would lock a vault the user asked never to lock.
    it("never expires when the timeout is zero", async () => {
      saved!.lockTimeoutMinutes = 0;
      vi.useFakeTimers();
      try {
        await session.init();
        await session.unlockWithPin("135790");

        vi.setSystemTime(Date.now() + 365 * 24 * 60 * 60 * 1000);
        session.lockIfExpired();

        expect(session.state).toBe("unlocked");
      } finally {
        vi.useRealTimers();
      }
    });

    // A backwards jump pushes the deadline away and would delay the lock, so
    // it is treated as expiry: the deadline is no longer meaningful, and
    // locking is the answer that cannot be wrong.
    it("locks when the clock has moved backwards under the deadline", async () => {
      vi.useFakeTimers();
      try {
        await session.init();
        await session.unlockWithPin("135790");

        vi.setSystemTime(Date.now() - 60 * 1000);
        session.lockIfExpired();

        expect(session.state).toBe("locked");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
