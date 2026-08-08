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
};

export type TotpCode = { code: string; secondsRemaining: number };

/**
 * Every request kind here has a handler in background/index.ts, and the
 * dispatcher ends in a compile-time exhaustiveness check. Adding a kind to
 * this union without a matching case is therefore a build error, not a
 * runtime surprise — which is why `setup`, `sync` and `copy` are absent:
 * they arrive in Tasks 13 and 15 together with their handlers.
 */
export type Request =
  | { kind: "status" }
  | { kind: "unlock"; pin: string }
  | { kind: "lock" }
  | { kind: "signOut" }
  | { kind: "list"; query: string }
  | { kind: "matches"; pageUrl: string }
  | { kind: "fill"; tabId: number; itemId: string }
  | { kind: "totp"; itemId: string };

/** `void` covers the kinds that answer with an acknowledgement only. */
export type Response = Status | ItemSummary[] | TotpCode | void;

function isString(v: unknown): v is string {
  return typeof v === "string";
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
      return true;
    case "unlock":
      return "pin" in v && isString(v.pin);
    case "list":
      return "query" in v && isString(v.query);
    case "matches":
      return "pageUrl" in v && isString(v.pageUrl);
    case "fill":
      return (
        "tabId" in v &&
        typeof v.tabId === "number" &&
        Number.isInteger(v.tabId) &&
        "itemId" in v &&
        isString(v.itemId)
      );
    case "totp":
      return "itemId" in v && isString(v.itemId);
    default:
      return false;
  }
}
