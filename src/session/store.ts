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

/**
 * Explicit runtime narrowing rather than a cast: the value coming out of
 * `browser.storage.local.get` is untyped (`any`) at the API boundary, and
 * this codebase does not use `as` to force a shape onto unvalidated data.
 * This checks just enough structure (object, right primitive fields) to
 * rule out `undefined`/corrupt entries; it is not a full deep schema
 * validator for `KdfConfig`/`PinWrapped`, which are themselves only ever
 * written by this module's own `save`.
 */
function isStoredState(v: unknown): v is StoredState {
  if (typeof v !== "object" || v === null) return false;
  if (
    !("serverUrl" in v) ||
    !("email" in v) ||
    !("deviceId" in v) ||
    !("protectedUserKey" in v) ||
    !("protectedPrivateKey" in v) ||
    !("failedPinAttempts" in v) ||
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
    typeof v.protectedUserKey === "string" &&
    typeof v.protectedPrivateKey === "string" &&
    typeof v.failedPinAttempts === "number" &&
    typeof v.lockTimeoutMinutes === "number" &&
    typeof v.requireMasterPasswordOnRestart === "boolean"
  );
}
