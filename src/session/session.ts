import type { SymKey } from "../crypto/encstring";
import { zero } from "../crypto/bytes";
import { unwrapKeyWithPin } from "./pin";
import type { StateStore, StoredState } from "./store";

export const MAX_PIN_ATTEMPTS = 5;

export type SessionState = "empty" | "locked" | "unlocked";

export class PinAttemptsExhaustedError extends Error {
  constructor() {
    super("Too many incorrect PIN attempts. Sign in with your master password.");
    this.name = "PinAttemptsExhaustedError";
  }
}

export class Session {
  state: SessionState = "empty";
  userKey: SymKey | null = null;
  orgKeys: Map<string, SymKey> = new Map();
  accessToken: string | null = null;

  private stored: StoredState | null = null;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  private pinBlockedThisRun = false;

  constructor(private store: StateStore) {}

  async init(): Promise<void> {
    this.stored = await this.store.load();
    // Re-running init() (e.g. a background-page/service-worker restart)
    // while a previous instance was still unlocked must not leave live key
    // material resident and an idle timer pending — lock() already
    // enforces exactly that discipline, so reuse it rather than assigning
    // `state` directly and skipping the cleanup.
    if (this.state === "unlocked") {
      this.lock();
    }
    this.state = this.stored === null ? "empty" : "locked";
    // The background page starts once per Firefox launch, so this flag is
    // exactly "since the last restart".
    this.pinBlockedThisRun = this.stored?.requireMasterPasswordOnRestart ?? false;
  }

  /**
   * Returns a copy, not the live object: handing out the actual `stored`
   * reference would let a caller mutate fields like `failedPinAttempts`
   * directly and defeat the lockout without ever going through `store`.
   */
  get settings(): StoredState | null {
    if (this.stored === null) return null;
    return {
      ...this.stored,
      kdf: { ...this.stored.kdf },
      pinWrapped: this.stored.pinWrapped === null ? null : { ...this.stored.pinWrapped },
    };
  }

  get pinUnlockAvailable(): boolean {
    return !this.pinBlockedThisRun && (this.stored?.pinWrapped ?? null) !== null;
  }

  async unlockWithPin(pin: string): Promise<void> {
    if (this.pinBlockedThisRun) {
      throw new Error("Sign in with your master password after restarting Firefox.");
    }
    if (this.stored === null) {
      throw new PinAttemptsExhaustedError();
    }
    // `?? null`, not a bare `this.stored.pinWrapped` truthiness/`=== null`
    // check: StoredState types pinWrapped as `PinWrapped | null`, but the
    // storage boundary this crosses is untyped, so a corrupt/partial record
    // could still surface `undefined` here. Falling through on `undefined`
    // would send it into unwrapKeyWithPin(undefined, ...), throw a raw
    // TypeError caught below, and report "Incorrect PIN" instead of the
    // correct PinAttemptsExhaustedError — and do it AFTER charging an
    // attempt. Matches pinUnlockAvailable's identical guard above, and the
    // narrowed local is reused below so unwrapKeyWithPin always receives a
    // genuine PinWrapped.
    const pinWrapped = this.stored.pinWrapped ?? null;
    if (pinWrapped === null) {
      throw new PinAttemptsExhaustedError();
    }

    // Charge the attempt BEFORE trying it, and persist that immediately. If the
    // counter were only written after a failure, an attacker could kill the
    // browser between the failed unwrap and the save and guess for free. This
    // ordering can only ever over-count — a crash costs the user one attempt,
    // which is the safe direction to be wrong in.
    this.stored.failedPinAttempts += 1;
    if (this.stored.failedPinAttempts > MAX_PIN_ATTEMPTS) {
      // Defends against on-device guessing. It does not defend against an
      // offline attack on an extracted storage image.
      this.stored.pinWrapped = null;
      await this.store.save(this.stored);
      throw new PinAttemptsExhaustedError();
    }
    await this.store.save(this.stored);

    let newUserKey: SymKey;
    try {
      newUserKey = await unwrapKeyWithPin(pinWrapped, pin);
    } catch {
      throw new Error("Incorrect PIN");
    }

    // Re-unlocking an already-unlocked session (or any path that leaves a
    // stale userKey behind) must not orphan the previous buffer with live
    // key bytes still in it: zero it before the reference is replaced.
    if (this.userKey !== null) {
      zero(this.userKey.encKey);
      zero(this.userKey.macKey);
    }
    this.userKey = newUserKey;

    this.stored.failedPinAttempts = 0;
    await this.store.save(this.stored);
    this.state = "unlocked";
    this.touch();
  }

  /** Restarts the idle timer. Called on every user interaction. */
  touch(): void {
    if (this.state !== "unlocked" || this.stored === null) return;
    if (this.lockTimer !== null) clearTimeout(this.lockTimer);

    const minutes = this.stored.lockTimeoutMinutes;
    if (minutes <= 0) return; // 0 means never

    this.lockTimer = setTimeout(() => this.lock(), minutes * 60 * 1000);
  }

  lock(): void {
    if (this.userKey !== null) {
      zero(this.userKey.encKey);
      zero(this.userKey.macKey);
    }
    for (const k of this.orgKeys.values()) {
      zero(k.encKey);
      zero(k.macKey);
    }
    this.orgKeys.clear();
    this.userKey = null;
    this.accessToken = null;

    if (this.lockTimer !== null) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
    this.state = this.stored === null ? "empty" : "locked";
  }
}
