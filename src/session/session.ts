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
  /**
   * Stale past the idle deadline: this field is not updated on its own when
   * time passes, only when something calls `lockIfExpired()`. Reading it
   * anywhere else observes a session that may already be expired. The
   * settling sites are `require()`, `status()`, `matchesFor()` and
   * `syncAttempt()` in `src/background/controller.ts` — a new reading site
   * needs its own call to `lockIfExpired()` first, the same way those four
   * do.
   */
  state: SessionState = "empty";
  /** Same hazard as `state` above: settle with `lockIfExpired()` before reading. */
  userKey: SymKey | null = null;
  orgKeys: Map<string, SymKey> = new Map();
  accessToken: string | null = null;

  /**
   * Called whenever this session leaves the unlocked state.
   *
   * Zeroing the key buffers is only half of a lock. The plaintext those keys
   * produced — every password and TOTP secret in the vault — lives in the
   * owner (the Controller), which this class knows nothing about, and most
   * locks do not go through the owner at all: the idle timer fires on its
   * own, `signOut()` locks before it wipes the device, and `init()` locks a
   * session that was still unlocked from a previous run. Without this hook
   * the 15-minute idle timeout wipes the keys and leaves the entire vault in
   * cleartext in the background page's heap for as long as Firefox keeps
   * that page alive.
   *
   * Defaults to a no-op so a Session is usable on its own; the Controller
   * assigns it in its constructor, which is the only place a Session ever
   * acquires an owner.
   */
  onLock: () => void = () => {};

  private stored: StoredState | null = null;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Wall-clock time at which this session expires, and the moment that
   * deadline was set. `null` means there is no deadline at all: a locked
   * session, or a `lockTimeoutMinutes` of 0, which means "never".
   *
   * This — not `lockTimer` — is what protects the vault. A timer has to run in
   * order to fire, and on Android it does not: measured over a night on
   * 2026-08-27/28, `setTimeout` never fired once while the device slept, and
   * the vault was still unlocked four and a half hours past its deadline
   * (docs/VERIFICATION-2026-08-25.md § F-4). A deadline only has to be read,
   * and it is read at the guard every vault access already passes through.
   *
   * In memory on purpose. `init()` locks any session that outlived its
   * background page, so a deadline can never need to survive one.
   */
  private lockDeadlineMs: number | null = null;
  private armedAtMs: number | null = null;
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

  /**
   * Applies a partial change to the stored state and persists it.
   *
   * This exists because `settings` hands out a defensive CLONE (see above).
   * Callers that read `settings`, mutate the result and then ask the session
   * to save would write to a throwaway object and persist nothing — the
   * failure mode is silent, so there must be no reason to try. Everything
   * that needs to change persisted state goes through here.
   *
   * The clone is not negotiable: making `settings` return the live object
   * would let any caller zero `failedPinAttempts` and defeat the PIN
   * lockout.
   *
   * Saves BEFORE adopting the new object, so a rejecting store leaves the
   * in-memory state matching what is actually on disk rather than a change
   * that was never written.
   */
  async update(patch: Partial<StoredState>): Promise<void> {
    if (this.stored === null) throw new Error("There is no account on this device");
    const next: StoredState = { ...this.stored, ...patch };
    await this.store.save(next);
    this.stored = next;
  }

  /**
   * Adopts the result of a full master-password login: persisted state and
   * live keys, in one step.
   *
   * Atomic on purpose. Persisting first means a rejecting store leaves the
   * session exactly as it was — locked or empty, with no keys resident —
   * instead of a phantom "unlocked" session holding keys for an account
   * that was never written to disk. The caller keeps ownership of the keys
   * on that path and is expected to zero them.
   *
   * Any previously resident key material is zeroed before the new keys are
   * adopted. Without that, running setup twice in one background-page
   * lifetime (or running it while already unlocked) would orphan a buffer
   * still holding live secret bytes — the same defect `unlockWithPin`
   * guards against.
   */
  async adoptLogin(
    state: StoredState,
    keys: { userKey: SymKey; orgKeys: Map<string, SymKey>; accessToken: string },
  ): Promise<void> {
    await this.store.save(state);

    if (this.userKey !== null) {
      zero(this.userKey.encKey);
      zero(this.userKey.macKey);
    }
    for (const k of this.orgKeys.values()) {
      zero(k.encKey);
      zero(k.macKey);
    }

    this.stored = state;
    this.userKey = keys.userKey;
    this.orgKeys = keys.orgKeys;
    this.accessToken = keys.accessToken;
    // A full master-password login satisfies the restart policy, so PIN
    // unlock becomes available again for the rest of this run.
    this.pinBlockedThisRun = false;
    this.state = "unlocked";
    this.touch();
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

  /**
   * Restarts the idle deadline. Called on every user interaction.
   *
   * The `setTimeout` below is no longer the protection — see `lockDeadlineMs`.
   * Its only remaining job is to zero the keys promptly on a device that is
   * awake, so a phone lying on a desk does not keep plaintext in the heap. If
   * Android suspends it, nothing is lost that the deadline does not cover.
   */
  touch(): void {
    if (this.state !== "unlocked" || this.stored === null) return;
    if (this.lockTimer !== null) clearTimeout(this.lockTimer);

    const minutes = this.stored.lockTimeoutMinutes;
    if (minutes <= 0) {
      // "Never" has to clear the deadline as well as skip the timer. Leaving a
      // stale one behind would lock the vault at the first interaction after
      // the user turned the timeout off.
      this.lockDeadlineMs = null;
      this.armedAtMs = null;
      return;
    }

    const delayMs = minutes * 60 * 1000;
    this.armedAtMs = Date.now();
    this.lockDeadlineMs = this.armedAtMs + delayMs;
    this.lockTimer = setTimeout(() => this.lock(), delayMs);
  }

  /**
   * Locks if the idle deadline has passed. Safe to call in any state, and
   * cheap enough to call on every vault access — which is what
   * `Controller.require()` does.
   */
  lockIfExpired(): void {
    if (this.state !== "unlocked" || this.lockDeadlineMs === null) return;

    const now = Date.now();
    // `now < armedAtMs` means the wall clock moved backwards under us: an NTP
    // correction, a timezone change, someone setting the clock. The deadline
    // stops meaning anything, and locking is the reading that cannot be wrong.
    // It costs the user one PIN entry.
    const wentBackwards = this.armedAtMs !== null && now < this.armedAtMs;
    if (now >= this.lockDeadlineMs || wentBackwards) {
      this.lock();
    }
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
    this.lockDeadlineMs = null;
    this.armedAtMs = null;
    this.state = this.stored === null ? "empty" : "locked";

    // Last: the keys are already zeroed and the state is already consistent,
    // so whatever the owner does here — including throwing — cannot leave
    // this session half-locked. Every path out of "unlocked" runs through
    // here, which is what makes the notification exhaustive rather than a
    // per-caller courtesy.
    this.onLock();
  }

  /**
   * Replaces this session's organization keys.
   *
   * Zeroes the buffers it is replacing, for the same reason `adoptLogin` and
   * `unlockWithPin` do: dropping the reference to a Uint8Array that still
   * holds live key bytes leaves them in the heap until the GC happens to
   * run, which is not a schedule this extension controls.
   *
   * Refuses to install into a session that is no longer unlocked. Rebuilding
   * organization keys is several awaits long (an RSA unwrap per
   * organization) and the idle timer can fire anywhere in the middle of it;
   * installing the result afterwards would leave a LOCKED session holding
   * live organization keys that nothing would zero until the next lock. The
   * rejected keys are zeroed here rather than handed back, because the
   * caller has already lost its reference to them by the time it returns.
   */
  adoptOrgKeys(orgKeys: Map<string, SymKey>): void {
    for (const k of this.orgKeys.values()) {
      zero(k.encKey);
      zero(k.macKey);
    }

    if (this.state !== "unlocked") {
      for (const k of orgKeys.values()) {
        zero(k.encKey);
        zero(k.macKey);
      }
      this.orgKeys = new Map();
      return;
    }

    this.orgKeys = orgKeys;
  }

  /**
   * Wipes the device. `lock()` only zeroes the in-memory keys; everything
   * that makes an offline attack possible — `protectedUserKey`,
   * `pinWrapped`, `wrappedRefreshToken` and the `cipherCache` — lives in
   * `browser.storage.local` and survives a lock, a browser restart and an
   * extension update. Without this there is no way to get it off the
   * device short of uninstalling the extension.
   *
   * lock() first so the key material is zeroed even if the store's clear()
   * rejects, and the state is set explicitly afterwards because lock()
   * decides it from `stored`, which is still populated at that point.
   */
  async signOut(): Promise<void> {
    this.lock();
    await this.store.clear();
    this.stored = null;
    this.state = "empty";
  }
}
