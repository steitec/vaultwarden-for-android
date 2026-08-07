import type { KdfConfig } from "../crypto/kdf";
import type { PinWrapped } from "./pin";

export type StoredState = {
  serverUrl: string;
  email: string;
  deviceId: string;
  kdf: KdfConfig;
  /** EncString of the user key, as returned by the server */
  protectedUserKey: string;
  protectedPrivateKey: string;
  pinWrapped: PinWrapped | null;
  failedPinAttempts: number;
  /** Refresh token, itself wrapped under the user key: a locked vault is inert */
  wrappedRefreshToken: string | null;
  /** Raw sync response, as ciphertext, for offline use */
  cipherCache: string | null;
  lastSyncMs: number | null;
  lockTimeoutMinutes: number;
  requireMasterPasswordOnRestart: boolean;
};

export type StateStore = {
  load(): Promise<StoredState | null>;
  save(state: StoredState): Promise<void>;
  clear(): Promise<void>;
};

const KEY = "state";

export const browserStore: StateStore = {
  async load() {
    const r = await browser.storage.local.get(KEY);
    const value: unknown = r[KEY];
    return isStoredState(value) ? value : null;
  },
  async save(state) {
    await browser.storage.local.set({ [KEY]: state });
  },
  async clear() {
    await browser.storage.local.remove(KEY);
  },
};

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

// typeof v === "number" alone admits NaN and ±Infinity, which have no
// business surviving a JSON-backed storage round-trip as, say, a lock
// timeout or a failed-attempt count.
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isKdfConfig(v: unknown): v is KdfConfig {
  if (typeof v !== "object" || v === null) return false;
  if (
    !("kdf" in v) ||
    !("iterations" in v) ||
    !("memory" in v) ||
    !("parallelism" in v) ||
    !("salt" in v)
  ) {
    return false;
  }
  return (
    (v.kdf === 0 || v.kdf === 1) &&
    isFiniteNumber(v.iterations) &&
    (v.memory === null || isFiniteNumber(v.memory)) &&
    (v.parallelism === null || isFiniteNumber(v.parallelism)) &&
    isNullableString(v.salt)
  );
}

function isPinWrapped(v: unknown): v is PinWrapped {
  if (typeof v !== "object" || v === null) return false;
  if (
    !("salt" in v) ||
    !("iv" in v) ||
    !("ct" in v) ||
    !("iterations" in v) ||
    !("memory" in v) ||
    !("parallelism" in v)
  ) {
    return false;
  }
  return (
    typeof v.salt === "string" &&
    typeof v.iv === "string" &&
    typeof v.ct === "string" &&
    isFiniteNumber(v.iterations) &&
    isFiniteNumber(v.memory) &&
    isFiniteNumber(v.parallelism)
  );
}

/**
 * Explicit runtime narrowing rather than a cast: the value coming out of
 * `browser.storage.local.get` is untyped (`any`) at the API boundary, and
 * this codebase does not use `as` to force a shape onto unvalidated data.
 *
 * Every field of StoredState is checked, including the two structured ones
 * (`kdf`, `pinWrapped`) that are the fields later code actually
 * dereferences (`state.kdf.iterations`, `state.pinWrapped.salt`): accepting
 * those as bare `{}` or a wrong-typed value here would let a corrupt record
 * pass as `StoredState` and crash (or worse, misbehave) well downstream of
 * this guard, at a point with no idea the value was ever unvalidated.
 */
export function isStoredState(v: unknown): v is StoredState {
  if (typeof v !== "object" || v === null) return false;
  if (
    !("serverUrl" in v) ||
    !("email" in v) ||
    !("deviceId" in v) ||
    !("kdf" in v) ||
    !("protectedUserKey" in v) ||
    !("protectedPrivateKey" in v) ||
    !("pinWrapped" in v) ||
    !("failedPinAttempts" in v) ||
    !("wrappedRefreshToken" in v) ||
    !("cipherCache" in v) ||
    !("lastSyncMs" in v) ||
    !("lockTimeoutMinutes" in v) ||
    !("requireMasterPasswordOnRestart" in v)
  ) {
    return false;
  }
  // The `in` checks above narrow `v` from `object` to an intersection that
  // exposes each key typed `unknown`, so these reads need no cast.
  return (
    typeof v.serverUrl === "string" &&
    typeof v.email === "string" &&
    typeof v.deviceId === "string" &&
    isKdfConfig(v.kdf) &&
    typeof v.protectedUserKey === "string" &&
    typeof v.protectedPrivateKey === "string" &&
    (v.pinWrapped === null || isPinWrapped(v.pinWrapped)) &&
    isFiniteNumber(v.failedPinAttempts) &&
    isNullableString(v.wrappedRefreshToken) &&
    isNullableString(v.cipherCache) &&
    (v.lastSyncMs === null || isFiniteNumber(v.lastSyncMs)) &&
    isFiniteNumber(v.lockTimeoutMinutes) &&
    typeof v.requireMasterPasswordOnRestart === "boolean"
  );
}
