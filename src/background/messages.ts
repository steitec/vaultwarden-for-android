/**
 * The popup/background message contract.
 *
 * `ItemSummary` is deliberately the *only* item shape that ever crosses this
 * boundary, and it has no password field. Decrypted passwords stay inside the
 * background page and reach a web page only via the content script, in a
 * message addressed to one specific tab (see Controller.fill).
 */
export type ItemSummary = {
  id: string;
  name: string;
  username: string | null;
  hasTotp: boolean;
  undecryptable: boolean;
};

export type Status = {
  state: "empty" | "locked" | "unlocked";
  lastSyncMs: number | null;
  email: string | null;
  /** Prefills the sign-in form when a locked vault has to re-authenticate. */
  serverUrl: string | null;
  /**
   * Whether a PIN unlock can succeed at all. False for a locked vault whose
   * wrapped key a lockout dropped, and for the whole browser run after a
   * restart when the account requires the master password. The popup routes
   * on this: an unlock screen that can never succeed is a dead end.
   */
  pinUnlockAvailable: boolean;
  /** Tries left before the wrapped key is dropped. Never negative. */
  pinAttemptsRemaining: number;
};

export type TotpCode = { code: string; secondsRemaining: number };

/**
 * What a `matches` request answers with.
 *
 * "locked" is a distinct state rather than an error because the content
 * script has to tell "the vault cannot be consulted" apart from "nothing
 * matches this page": the first renders an unlock badge, the second renders
 * nothing at all. A locked vault holds no decrypted items and so cannot
 * answer the question — see the 2026-08-25 design's §7 for why an
 * unencrypted index of the vault's domains is not an acceptable way around
 * that.
 */
export type PageMatches =
  | { state: "locked" }
  | { state: "unlocked"; items: ItemSummary[] };

/**
 * What `setup` answers with.
 *
 * A 2FA challenge is a resolved VALUE, not a rejection, because error
 * classes do not survive `runtime.sendMessage`: Firefox structured-clones
 * the rejection into a plain Error carrying the message alone, so
 * `TwoFactorRequiredError.providers` — the server's list of methods the
 * account actually has — never reaches the popup. Matching on the message
 * text instead would be fragile and would still leave the popup guessing at
 * the providers.
 *
 * Only the challenge is a value. Every other login failure still rejects, so
 * that a wrong password cannot be mistaken for a 2FA prompt.
 */
export type SetupResult =
  | { ok: true }
  | { ok: false; reason: "twoFactor"; providers: number[] };

/**
 * Every request kind here has a handler in background/index.ts, and the
 * dispatcher ends in a compile-time exhaustiveness check. Adding a kind to
 * this union without a matching case is therefore a build error, not a
 * runtime surprise — which is why `copy` is still absent: it arrives in
 * Task 15 together with its handler.
 *
 * `setup` is the only message that carries the master password. It is a
 * plain string and cannot be zeroed in JS once it has crossed this
 * boundary; that is inherent to the runtime message API and accepted. What
 * is NOT accepted is it ever reaching an error message, a console call, or
 * `browser.storage` — see login.ts.
 */
export type Request =
  | { kind: "status" }
  | { kind: "unlock"; pin: string }
  | { kind: "lock" }
  | { kind: "signOut" }
  | { kind: "list"; query: string }
  | { kind: "matches" }
  | { kind: "fill"; tabId: number; itemId: string }
  | { kind: "fillFromPage"; itemId: string }
  | { kind: "handOff" }
  | { kind: "totp"; itemId: string }
  | {
      kind: "setup";
      serverUrl: string;
      email: string;
      password: string;
      pin: string;
      twoFactor?: { token: string; provider: number };
    }
  | { kind: "sync" };

/** `void` covers the kinds that answer with an acknowledgement only. */
export type Response = Status | ItemSummary[] | PageMatches | TotpCode | SetupResult | void;

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * The optional second-factor payload. `provider` is forwarded to the server
 * as a numeric provider id, so a NaN/Infinity here would become the string
 * "NaN" in the token request rather than being rejected at the boundary.
 */
function isTwoFactor(v: unknown): v is { token: string; provider: number } {
  if (typeof v !== "object" || v === null) return false;
  if (!("token" in v) || !("provider" in v)) return false;
  return isString(v.token) && typeof v.provider === "number" && Number.isFinite(v.provider);
}

/**
 * Explicit runtime narrowing rather than a cast: the value handed to a
 * `browser.runtime.onMessage` listener is untyped (`unknown`) at the API
 * boundary, and this codebase does not use `as` to force a shape onto
 * unvalidated data. Casting here would be the worst instance of it in the
 * project — the message originates outside this module's control, so a cast
 * would hand the controller a `pin`/`itemId`/`tabId` of any runtime type
 * whatsoever and let it flow into crypto and into `browser.tabs`.
 *
 * The per-kind payload fields are validated, not just `kind`: a
 * `{ kind: "unlock" }` with no `pin` must be rejected here rather than
 * charging a PIN attempt against `undefined` deep inside Session.
 */
export function isRequest(v: unknown): v is Request {
  if (typeof v !== "object" || v === null) return false;
  if (!("kind" in v)) return false;

  const kind: unknown = v.kind;
  if (typeof kind !== "string") return false;

  switch (kind) {
    case "status":
    case "lock":
    case "signOut":
    case "sync":
    // `matches` carries no payload any more: the background page reads the
    // tab's URL itself rather than accepting one from a caller, because the
    // content script now runs on pages this addon does not control.
    case "matches":
    // Likewise `handOff`: the tab it concerns is the sender's own.
    case "handOff":
      return true;
    case "setup":
      // Every field is checked, not just presence: a non-string serverUrl
      // would reach `new URL()`, a non-string password would reach the KDF,
      // and a malformed twoFactor would reach the token request. An absent
      // twoFactor is legal; a present-but-wrong-shaped one is not.
      return (
        "serverUrl" in v &&
        isString(v.serverUrl) &&
        "email" in v &&
        isString(v.email) &&
        "password" in v &&
        isString(v.password) &&
        "pin" in v &&
        isString(v.pin) &&
        (!("twoFactor" in v) || v.twoFactor === undefined || isTwoFactor(v.twoFactor))
      );
    case "unlock":
      return "pin" in v && isString(v.pin);
    case "list":
      return "query" in v && isString(v.query);
    case "fill":
      return (
        "tabId" in v &&
        typeof v.tabId === "number" &&
        Number.isInteger(v.tabId) &&
        "itemId" in v &&
        isString(v.itemId)
      );
    case "fillFromPage":
      return "itemId" in v && isString(v.itemId);
    case "totp":
      return "itemId" in v && isString(v.itemId);
    default:
      return false;
  }
}
