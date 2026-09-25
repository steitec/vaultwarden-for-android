import type { UnlockMode } from "../session/store";

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

/**
 * What the editor is given for an existing entry.
 *
 * The sibling of `ItemSummary`, and it keeps the same rule: NO password field
 * on the type. `hasPassword` carries exactly one bit — that there is one —
 * which is what the overwrite confirmation is built from. Anything more would
 * be a decrypted password crossing this boundary, which is the guarantee
 * SECURITY.md makes.
 *
 * `uri` is the FIRST uri and `otherUriCount` is how many the form is not
 * showing, so the editor can promise they will survive rather than leaving
 * the user to guess.
 */
export type ItemDraftView = {
  id: string;
  name: string;
  username: string | null;
  uri: string | null;
  otherUriCount: number;
  hasPassword: boolean;
  /** False for an organization item, and for one that will not decrypt. */
  editable: boolean;
};

/**
 * What the editor sends back.
 *
 * Structurally identical to `ItemDraft` in vault/encrypt.ts and deliberately
 * re-declared rather than imported: this module is the wire contract, and it
 * must not drag the crypto layer into the popup bundle's type graph.
 * `isItemDraft` is what makes the two agree at runtime.
 */
export type ItemDraftMessage = {
  name: string;
  username: string;
  uri: string;
  /** null means "leave the stored password alone". */
  password: string | null;
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
  /**
   * How this account unlocks. The settings switch draws its position from
   * this; nothing routes a SCREEN on it, because a locked "session" account
   * is already covered by `pinUnlockAvailable` being false.
   */
  unlockMode: UnlockMode;
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
  | { kind: "sync" }
  | { kind: "setUnlockMode"; mode: UnlockMode; pin?: string }
  | { kind: "itemDetail"; itemId: string }
  | { kind: "createItem"; draft: ItemDraftMessage }
  | { kind: "updateItem"; itemId: string; draft: ItemDraftMessage }
  | { kind: "deleteItem"; itemId: string };

/** `void` covers the kinds that answer with an acknowledgement only. */
export type Response =
  | Status
  | ItemSummary[]
  | ItemDraftView
  | PageMatches
  | TotpCode
  | SetupResult
  | void;

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
 * Every field checked, not merely present.
 *
 * These strings go straight into encryption and into a URL comparison: a
 * non-string `name` would reach `String.prototype.trim`, a non-string
 * `password` would reach `TextEncoder.encode`.
 *
 * `password` is `string | null`, and `undefined` is NOT accepted. "Absent"
 * and "leave the stored password alone" have to be the same explicit value on
 * the wire — otherwise a field dropped in transit would quietly mean "keep
 * the old password" on a create, which is a request that cannot be satisfied
 * at all.
 */
function isItemDraft(v: unknown): v is ItemDraftMessage {
  if (typeof v !== "object" || v === null) return false;
  if (!("name" in v) || !("username" in v) || !("uri" in v) || !("password" in v)) return false;
  return (
    isString(v.name) &&
    isString(v.username) &&
    isString(v.uri) &&
    (v.password === null || isString(v.password))
  );
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
    case "itemDetail":
    case "deleteItem":
      return "itemId" in v && isString(v.itemId);
    case "createItem":
      return "draft" in v && isItemDraft(v.draft);
    case "updateItem":
      return "itemId" in v && isString(v.itemId) && "draft" in v && isItemDraft(v.draft);
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
    case "setUnlockMode":
      // `mode` is checked against the two literals rather than "is a string":
      // an unknown mode reaching the controller would be a silent no-op at
      // best. `pin` is optional — absent when turning the PIN off, required
      // by the controller when turning it on — but a present one must be a
      // string, because it goes straight into the KDF.
      return (
        "mode" in v &&
        (v.mode === "pin" || v.mode === "session") &&
        (!("pin" in v) || v.pin === undefined || isString(v.pin))
      );
    default:
      return false;
  }
}
