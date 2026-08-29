import type {
  ItemSummary,
  PageMatches,
  Request,
  SetupResult,
  Status,
} from "../background/messages";
import { errorText, PinRejected } from "./errors";
import {
  renderSettings,
  renderSetup,
  renderTwoFactor,
  renderUnlock,
  type SetupValues,
} from "./screens";

/**
 * The popup: a single-column, touch-sized list of vault entries.
 *
 * It holds no key material and is never sent one. `ItemSummary` is the only
 * item shape that crosses the message boundary and it has no password field;
 * the fill path sends nothing back here either — the background page injects
 * the credential straight into the target tab.
 *
 * Everything below assumes it is talking to a background page that may
 * decline, reject, or never answer at all. See `request` and `main`.
 */

/**
 * How long to wait for the background page before giving up on one message.
 *
 * This is not belt-and-braces. `handleMessage` in background/index.ts returns
 * `undefined` — deliberately, not by omission — for any message it declines:
 * a foreign `sender.id`, or a payload `isRequest` rejects. A
 * `browser.runtime.sendMessage` whose listener returns undefined never
 * settles, so without this race a declined message is indistinguishable from
 * a frozen popup: no list, no error, nothing to tap. The same applies if the
 * background page has crashed or is still starting up.
 *
 * The budget is per kind because the kinds are not alike. A flat one has to
 * be short enough to be a useful "it is not answering" signal for the kinds
 * answered out of memory, and that same number then cuts off the kinds that
 * do key derivation before they can possibly have finished. Measured on a
 * desktop: PBKDF2-SHA256 at 600,000 iterations is 420 ms, wrapKeyWithPin
 * (Argon2id, 64 MiB, t=4, p=4) is 525 ms, unwrapKeyWithPin is 379 ms. A
 * mid-range Android phone runs this class of work roughly 3-6x slower.
 *
 * Giving up early does not cancel anything: the background page finishes the
 * work and persists the result whether or not the popup is still listening.
 * So the cost of a budget that is too short is not a failed operation, it is
 * telling the user their sign-in or unlock failed when it had just succeeded
 * — and inviting them to redo the whole key derivation.
 *
 * Typed as `Record<Request["kind"], number>` on purpose. A kind added to the
 * union with no budget decided for it is then a compile error, the same
 * exhaustiveness trick `handleMessage` uses, rather than a silent inherited
 * default that nobody revisits.
 */
const REQUEST_TIMEOUT_MS: Record<Request["kind"], number> = {
  // Answered from state already in memory: the session's own fields, or the
  // vault that was decrypted at unlock. If one of these has not come back,
  // the background page is not there.
  status: 4000,
  list: 4000,
  matches: 4000,
  totp: 4000,
  fill: 4000,
  fillFromPage: 4000,
  handOff: 4000,
  lock: 4000,
  signOut: 4000,

  // Argon2id to unwrap the key, then the whole offline cache to decrypt.
  // ~2.3 s of unwrap alone at the slow end, before the cache.
  unlock: 15000,

  // A network round trip on mobile data, then a full re-decrypt of the
  // vault. No key derivation, so the budget covers the network and little
  // else.
  sync: 20000,

  // The worst case in the extension, and the one the flat budget broke.
  // deriveMasterKey + deriveMasterPasswordHash + wrapKeyWithPin land at
  // 4-9 s on-device, and all of that happens BEFORE the first of three
  // network round trips (prelogin, token, vault), which are then followed by
  // decrypting what came back. A generous number here is not laxness: this
  // is the one operation where a false "not responding" leaves an account
  // that IS set up behind a screen that says it is not.
  setup: 45000,
};

class BackgroundUnavailableError extends Error {
  constructor() {
    super("The add-on is not responding. Close this panel and try again.");
    this.name = "BackgroundUnavailableError";
  }
}

class UnexpectedResponseError extends Error {
  constructor() {
    super("The add-on sent back something unexpected. Close this panel and try again.");
    this.name = "UnexpectedResponseError";
  }
}

function withTimeout<T>(pending: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BackgroundUnavailableError()), ms);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function request(req: Request): Promise<unknown> {
  const pending: Promise<unknown> = browser.runtime.sendMessage(req);
  return withTimeout(pending, REQUEST_TIMEOUT_MS[req.kind]);
}

/**
 * Explicit runtime narrowing rather than `as`: what comes back from
 * `sendMessage` is untyped at the API boundary. A cast would let a
 * malformed answer reach `renderStatus`/`renderList` and throw somewhere in
 * the DOM code, which surfaces as a blank panel rather than as an error the
 * user can act on.
 */
function isStatus(v: unknown): v is Status {
  if (typeof v !== "object" || v === null) return false;
  if (!("state" in v)) return false;
  if (v.state !== "empty" && v.state !== "locked" && v.state !== "unlocked") return false;
  if (!("lastSyncMs" in v)) return false;
  if (v.lastSyncMs !== null && !(typeof v.lastSyncMs === "number" && Number.isFinite(v.lastSyncMs)))
    return false;
  if (!("email" in v)) return false;
  if (v.email !== null && typeof v.email !== "string") return false;
  if (!("serverUrl" in v)) return false;
  if (v.serverUrl !== null && typeof v.serverUrl !== "string") return false;
  // These two pick the screen. Letting a status through without them and
  // filling in a default here would mean guessing whether the PIN pad can
  // work at all, and guessing wrong strands the user on a form that can
  // never succeed.
  if (!("pinUnlockAvailable" in v) || typeof v.pinUnlockAvailable !== "boolean") return false;
  if (!("pinAttemptsRemaining" in v)) return false;
  if (typeof v.pinAttemptsRemaining !== "number" || !Number.isFinite(v.pinAttemptsRemaining))
    return false;
  // Same reasoning as the two above: the settings panel draws a security
  // switch from this, and a default invented here would draw it in a position
  // the background page never reported.
  if (!("unlockMode" in v)) return false;
  if (v.unlockMode !== "pin" && v.unlockMode !== "session") return false;
  return true;
}

/**
 * A 2FA challenge arrives as a resolved value rather than an exception, so
 * this is a real boundary that needs a real guard — including the provider
 * list, which is forwarded to the server as numbers.
 */
function isSetupResult(v: unknown): v is SetupResult {
  if (typeof v !== "object" || v === null) return false;
  if (!("ok" in v) || typeof v.ok !== "boolean") return false;
  if (v.ok) return true;
  if (!("reason" in v) || v.reason !== "twoFactor") return false;
  if (!("providers" in v) || !Array.isArray(v.providers)) return false;
  return v.providers.every((p: unknown) => typeof p === "number" && Number.isFinite(p));
}

function isItemSummary(v: unknown): v is ItemSummary {
  if (typeof v !== "object" || v === null) return false;
  if (!("id" in v) || typeof v.id !== "string") return false;
  if (!("name" in v) || typeof v.name !== "string") return false;
  if (!("username" in v) || (v.username !== null && typeof v.username !== "string")) return false;
  if (!("hasTotp" in v) || typeof v.hasTotp !== "boolean") return false;
  if (!("undecryptable" in v) || typeof v.undecryptable !== "boolean") return false;
  return true;
}

function isItemSummaryList(v: unknown): v is ItemSummary[] {
  return Array.isArray(v) && v.every((entry: unknown) => isItemSummary(entry));
}

/**
 * `matches` no longer answers with a bare array: it distinguishes a locked
 * vault, which cannot be consulted at all, from an unlocked one with nothing
 * for this page. The popup only ever asks while unlocked, so "locked" here is
 * a race with the idle timer rather than an expected answer -- and it must
 * narrow to something, not fall through as an unvalidated shape.
 */
function isPageMatches(v: unknown): v is PageMatches {
  if (typeof v !== "object" || v === null) return false;
  if (!("state" in v)) return false;
  if (v.state === "locked") return true;
  if (v.state !== "unlocked") return false;
  return "items" in v && isItemSummaryList(v.items);
}

async function requestStatus(): Promise<Status> {
  const answer = await request({ kind: "status" });
  if (!isStatus(answer)) throw new UnexpectedResponseError();
  return answer;
}

async function requestPageMatches(): Promise<PageMatches> {
  const answer = await request({ kind: "matches" });
  if (!isPageMatches(answer)) throw new UnexpectedResponseError();
  return answer;
}

async function requestItems(req: Request): Promise<ItemSummary[]> {
  const answer = await request(req);
  if (!isItemSummaryList(answer)) throw new UnexpectedResponseError();
  return answer;
}

async function requestSetup(req: Request): Promise<SetupResult> {
  const answer = await request(req);
  if (!isSetupResult(answer)) throw new UnexpectedResponseError();
  return answer;
}

function humanAge(lastSyncMs: number, nowMs: number): string {
  const minutes = Math.round((nowMs - lastSyncMs) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const STATE_LABEL = {
  empty: "Not set up",
  locked: "Locked",
  unlocked: "Unlocked",
} as const;

/**
 * The header: lock state first, then how stale the offline copy is.
 *
 * The state belongs here and not just in the body because it is the one
 * thing that explains why the list is empty. It stays on screen for every
 * body the router picks.
 */
export function renderStatus(status: Status, container: HTMLElement): void {
  container.replaceChildren();

  const parts: HTMLElement[] = [];

  const state = document.createElement("span");
  state.className = `status-state status-${status.state}`;
  state.textContent = STATE_LABEL[status.state];
  parts.push(state);

  const sync = document.createElement("span");
  sync.className = "status-sync";
  sync.textContent =
    status.lastSyncMs === null ? "Never synced" : `Last synced ${humanAge(status.lastSyncMs, Date.now())}`;
  parts.push(sync);

  if (status.email !== null && status.email !== "") {
    const email = document.createElement("span");
    email.className = "status-email";
    // textContent, never innerHTML: the account email came back from the
    // server and is displayed data like any other.
    email.textContent = status.email;
    parts.push(email);
  }

  parts.forEach((part, i) => {
    if (i > 0) container.append(document.createTextNode(" · "));
    container.append(part);
  });
}

export function renderList(items: ItemSummary[], container: HTMLElement): void {
  container.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No matching entries.";
    container.append(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = item.undecryptable ? "item undecryptable" : "item";
    row.dataset.id = item.id;

    const name = document.createElement("span");
    name.className = "item-name";
    // textContent, never innerHTML: item names are attacker-influenced data.
    name.textContent = item.name;
    row.append(name);

    if (item.username !== null) {
      const user = document.createElement("span");
      user.className = "item-username";
      // Same rule as the name, and for the same reason: a username is
      // whatever the entry says it is.
      user.textContent = item.username;
      row.append(user);
    }

    if (item.hasTotp) {
      const totp = document.createElement("span");
      totp.className = "item-totp";
      totp.textContent = "TOTP";
      row.append(totp);
    }

    container.append(row);
  }
}

export function renderMessage(
  text: string,
  container: HTMLElement,
  tone: "info" | "error" = "info",
): void {
  container.replaceChildren();
  const p = document.createElement("p");
  p.className = tone === "error" ? "message message-error" : "message";
  p.textContent = text;
  container.append(p);
}

/** The banner above the list, used for failures that must not wipe it. */
function showBanner(banner: HTMLElement | null, text: string): void {
  if (banner === null) return;
  banner.textContent = text;
  banner.hidden = false;
}

function clearBanner(banner: HTMLElement | null): void {
  if (banner === null) return;
  banner.textContent = "";
  banner.hidden = true;
}

/**
 * The active tab, for its ID alone.
 *
 * The popup's `fill` still names a tab; `matches` no longer names anything,
 * because the background page reads the URL from the tab itself. What used
 * to be read here — `tab.url`, plus a `usablePageUrl` guard for the case
 * where `activeTab` had not been granted — is gone with it: host permissions
 * mean the URL is always readable, and it is no longer the popup's to assert.
 */
async function activeTab(): Promise<browser.tabs.Tab | null> {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Page matches first: on a phone the entry you want is almost always for the
 * page you are looking at. Falls back to the whole vault when the page has no
 * matches, when there is no page to match against, or when the vault locked
 * between the status answer and this one.
 */
async function initialItems(): Promise<ItemSummary[]> {
  const matches = await requestPageMatches();
  if (matches.state === "unlocked" && matches.items.length > 0) return matches.items;
  return requestItems({ kind: "list", query: "" });
}

/**
 * Wires the panel and routes to the screen the session state calls for.
 *
 * Routing is a function, not a straight line, because every successful
 * setup/unlock/lock/sign-out has to land the user somewhere new. The
 * alternative — `location.reload()` — throws the panel away and starts a
 * second popup lifetime for what is a state change inside this one, and
 * nothing on the way back can be observed or tested.
 *
 * `wired` is a closure local rather than module state: the list listeners
 * must be attached exactly once no matter how often `route` runs, and a
 * module-level flag would leak that "once" across tests.
 */
export async function main(): Promise<void> {
  const rootEl = document.getElementById("root");
  const headerEl = document.getElementById("status");
  if (rootEl === null || headerEl === null) return;
  // Re-declared with the narrowed type rather than relied on by narrowing:
  // the routing helpers below are hoisted function declarations, and
  // TypeScript will not carry a null check into one of those.
  const root: HTMLElement = rootEl;
  const statusEl: HTMLElement = headerEl;

  const searchEl = document.getElementById("search");
  const search = searchEl instanceof HTMLInputElement ? searchEl : null;
  const banner = document.getElementById("error");
  const settings = document.getElementById("settings");

  // Set by the vault screen and read by the click handler, which is wired
  // once and outlives any single render.
  let tabId: number | undefined;
  let wired = false;

  /**
   * Which screen #root currently belongs to.
   *
   * Every paint into #root that happens after an `await` has to take a claim
   * BEFORE that await and check it after; a claim that is no longer current
   * means the screen moved on and the paint is dropped. Two counters, because
   * the two kinds of paint are not peers.
   *
   * Stamping only the search handler was not enough, because the two things
   * racing are not always two keystrokes. A `list` still in flight when the
   * user taps Lock (or when the idle timer locks the vault and route() paints
   * the PIN pad) used to land on top of the unlock screen: renderList puts
   * vault entries over a locked vault, and the error branch is worse still,
   * because renderMessage replaces the whole of #root and takes the PIN form
   * with it, leaving nothing to tap.
   *
   * But a single shared counter, with routes and keystrokes bumping the same
   * number, gets the other direction wrong — and that direction is worse. A
   * route takes its claim BEFORE awaiting the status, and the search box stays
   * enabled and visible for the whole of that await: it is only disabled once
   * the locked branch is reached. A keystroke landing in that window would
   * take the claim from route(), which then paints NOTHING — no header, no PIN
   * pad, and no `search.disabled = true`. The keystroke's own list, now asking
   * a locked vault, comes back a LockedError and renderMessage puts it where
   * the PIN pad should have been. That leaves the user on an error with
   * nothing to tap, which is a worse place than the stale list this whole
   * mechanism exists to prevent.
   *
   * So: a route change always beats an in-flight list, and a keystroke only
   * ever beats other lists. `routeEpoch` is bumped by route() alone, and a
   * list paint has to be BOTH still inside the screen it was issued against
   * and the newest list within it. Nothing but a route can invalidate a route.
   *
   * `displayedEpoch` is the subtle half. A list belongs to the screen the user
   * was LOOKING AT when it was issued, which is not the same as the route in
   * progress: the keystroke above arrives after route() has already bumped
   * `routeEpoch`, so a list that captured that number would still look current
   * once the PIN pad painted. It captures what is on display instead, and a
   * route updates that only at the moment it actually paints.
   *
   * The claims are deliberately values any async path can hold, rather than
   * checks written into the one handler that had the bug — the next async
   * render added here needs the same guard and should not have to rediscover
   * why. Paints belonging to a screen ask claimRoute(); paints that fill in
   * part of the screen already on display ask claimList().
   */
  /** The newest route, painted or not. */
  let routeEpoch = 0;
  /** The route whose screen #root is actually showing. */
  let displayedEpoch = 0;
  let listSeq = 0;

  /**
   * For a paint that IS a screen change. Only a later route supersedes it.
   *
   * The returned predicate has a deliberate side effect: on true it records
   * this route as the one now on display, which is what makes every list
   * issued against the previous screen stale. Check and claim are one call
   * rather than two because a separable "commit" is a step that can be
   * forgotten, and forgetting it puts the stale-list bug straight back.
   * Idempotent, so calling it before each of a route's paints is fine.
   */
  function claimRoute(): () => boolean {
    const mine = ++routeEpoch;
    return () => {
      if (mine !== routeEpoch) return false;
      displayedEpoch = mine;
      return true;
    };
  }

  /**
   * For a paint into the screen that is already up. Superseded by a later
   * list, and by any route that has painted since — note this reads the
   * epochs without bumping `routeEpoch`, which is precisely what stops a
   * keystroke from preempting the route it is racing.
   */
  function claimList(): () => boolean {
    const myScreen = displayedEpoch;
    const mine = ++listSeq;
    return () => myScreen === displayedEpoch && mine === listSeq;
  }

  function hideSettings(): void {
    if (settings === null) return;
    settings.replaceChildren();
    settings.hidden = true;
  }

  function wire(): void {
    if (wired) return;
    wired = true;

    if (search !== null) {
      search.addEventListener("input", () => {
        const current = claimList();
        const query = search.value;
        void (async () => {
          try {
            const items = await requestItems({ kind: "list", query });
            if (!current()) return;
            clearBanner(banner);
            renderList(items, root);
          } catch (e) {
            if (!current()) return;
            renderMessage(errorText(e), root, "error");
          }
        })();
      });
    }

    root.addEventListener("click", (event) => {
      void (async () => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const row = target.closest(".item");
        if (!(row instanceof HTMLElement)) return;
        const itemId = row.dataset.id;
        if (itemId === undefined) return;

        if (row.classList.contains("undecryptable")) {
          showBanner(banner, "This entry could not be decrypted, so there is nothing to fill.");
          return;
        }
        if (tabId === undefined) {
          showBanner(banner, "There is no page here to fill.");
          return;
        }

        try {
          // Exactly these three fields. The background reads the destination
          // from the tab itself; a caller-supplied page URL was removed on
          // purpose so that a caller cannot redirect credentials, and sending
          // one back would be signalling the wrong intent even if it were
          // ignored.
          await request({ kind: "fill", tabId, itemId });
        } catch (e) {
          // The user must be told why. A silent no-op reads as "filled" and
          // they will submit an empty form — or worse, assume a password
          // reached a page that refused it for a security reason.
          showBanner(banner, errorText(e));
          return;
        }
        window.close();
      })();
    });
  }

  async function showVault(): Promise<void> {
    // A list claim, not the route's: this is the initial list for a screen
    // that is already up, and it races the same way a keystroke's list does.
    // Taken before the first await, and it captures the route it belongs to,
    // so a later route drops it exactly as the route claim would have.
    const current = claimList();

    if (search !== null) {
      search.disabled = false;
      search.hidden = false;
    }
    if (settings !== null) {
      settings.hidden = false;
      renderSettings(settings, {
        onSync: async () => {
          try {
            await request({ kind: "sync" });
          } catch (e) {
            // A failed sync must not wipe the list: the offline copy is
            // still exactly as usable as it was a second ago.
            showBanner(banner, errorText(e));
            return;
          }
          await route();
        },
        onLock: async () => {
          await request({ kind: "lock" });
          await route();
        },
        onSignOut: async () => {
          await request({ kind: "signOut" });
          await route();
        },
      });
    }

    tabId = (await activeTab())?.id;

    let items: ItemSummary[];
    try {
      items = await initialItems();
    } catch (e) {
      // The vault can lock between the status answer and this one — the idle
      // timer does not wait for the popup.
      if (!current()) return;
      renderMessage(errorText(e), root, "error");
      return;
    }
    // Same claim, same reason as the search handler: this list was asked for
    // on behalf of one screen, and by now the user may be on another.
    //
    // Returning here skips wire(), which is safe in both directions and not
    // by luck. On the very first vault render there is no input listener yet
    // — wire() is what attaches it — so no keystroke can take this claim, and
    // only a route can; that route paints its own screen and wires if it
    // lands back here. On every later render wire() is already a no-op.
    if (!current()) return;
    renderList(items, root);

    wire();
    clearBanner(banner);
    search?.focus();
  }

  /**
   * Hands a completed sign-in form to the background page.
   *
   * This used to open with `browser.permissions.request()` for the entered
   * host, from inside the form's own submit gesture. The broad https wildcard
   * is a required permission now, so that call had nothing left to ask for
   * and resolved true without a prompt every time — see § F-3 of
   * `docs/VERIFICATION-2026-08-25.md`.
   */
  async function submitSetup(v: SetupValues): Promise<void> {
    const first = await requestSetup({
      kind: "setup",
      serverUrl: v.serverUrl,
      email: v.email,
      password: v.password,
      pin: v.pin,
    });
    if (first.ok) {
      await route();
      return;
    }

    // The second factor needs the same credentials again — the background
    // page keeps nothing between attempts. They live in this closure only
    // until the two-factor screen is replaced, which the next route() does.
    renderTwoFactor(root, first.providers, async (twoFactor) => {
      const second = await requestSetup({
        kind: "setup",
        serverUrl: v.serverUrl,
        email: v.email,
        password: v.password,
        pin: v.pin,
        twoFactor,
      });
      // A second challenge means the code was wrong or has expired. Throwing
      // keeps the code box on screen with the message in it rather than
      // rebuilding the form under the user's thumb.
      if (!second.ok) throw new Error("That code was not accepted. Try again.");
      await route();
    });
  }

  async function submitUnlock(pin: string): Promise<void> {
    try {
      await request({ kind: "unlock", pin });
    } catch (e) {
      // A wrong PIN can be the LAST wrong PIN: Session drops the wrapped key
      // once the attempts are exhausted, and the screen this rejection is
      // about to land on could then never succeed again. Re-route in that
      // case so the master-password form appears instead of a dead PIN pad.
      const after = await requestStatus().catch(() => null);
      if (after !== null && !(after.state === "locked" && after.pinUnlockAvailable)) {
        await route(after);
        return;
      }
      // Still a usable pad. Rethrowing plainly leaves the screen showing the
      // count it was painted with, which is the whole of F-2 — so the fresh
      // count rides along and the pad updates its own warning.
      if (after !== null) throw new PinRejected(errorText(e), after.pinAttemptsRemaining);
      throw e;
    }
    await route();
  }

  async function route(known?: Status): Promise<void> {
    // Taken before anything is awaited. Routing is what changes which screen
    // #root holds, so it is also what makes every render still in flight
    // stale — including one issued by a screen this route is about to
    // replace, whose answer would otherwise arrive and paint over the new
    // one. Holding the claim rather than only invalidating means route's own
    // async paths are covered by the same check: only a LATER route can stop
    // this one from painting.
    const current = claimRoute();

    let status: Status;
    if (known !== undefined) {
      status = known;
    } else {
      try {
        status = await requestStatus();
      } catch (e) {
        if (!current()) return;
        statusEl.textContent = "Unavailable";
        renderMessage(errorText(e), root, "error");
        if (search !== null) search.disabled = true;
        hideSettings();
        return;
      }
    }

    if (!current()) return;
    renderStatus(status, statusEl);

    if (status.state === "unlocked") {
      await showVault();
      return;
    }

    // Asking a locked vault for `list`/`matches` earns a LockedError and a
    // blank panel, so nothing below this line talks to the vault.
    if (search !== null) {
      search.disabled = true;
      search.hidden = true;
    }
    hideSettings();
    clearBanner(banner);

    if (status.state === "locked" && status.pinUnlockAvailable) {
      renderUnlock(root, submitUnlock, status.pinAttemptsRemaining);
      return;
    }

    // Either there is no account at all, or there is one that the PIN can no
    // longer open — a restart under the master-password policy, or a
    // lockout. Both need the same form; only the wording and the prefill
    // differ, and setup() adopts the new login over the old account either
    // way.
    renderSetup(root, submitSetup, {
      mode: status.state === "empty" ? "new" : "reauthenticate",
      serverUrl: status.serverUrl ?? "",
      email: status.email ?? "",
    });
  }

  // The vault can lock while this panel is up: the idle timer runs in the
  // background page and knows nothing about an open popup. Without this the
  // panel goes on showing entry names and usernames after the keys have been
  // zeroed — which is F-5, and it is the idle-lock scenario itself, since a
  // panel left open is how a phone gets put down in the first place.
  //
  // A port rather than a broadcast `sendMessage`: a broadcast rejects with
  // "no receiving end" whenever no popup is open, which is almost always, and
  // it never tells the background that the popup has gone away.
  //
  // Guarded because `connect` is not worth a blank panel: a popup that failed
  // to subscribe is the behaviour we have today, not a worse one.
  try {
    const port = browser.runtime.connect({ name: "popup" });
    port.onMessage.addListener(() => {
      void route();
    });
  } catch {
    // Nothing to report to; the panel still works, it just will not learn
    // about a lock that happens while it is open.
  }

  await route();
}

// `main` runs when the popup document says so, never as an import side
// effect: importing this module must be inert so tests can exercise the
// render functions without a `browser` global and without a stray request
// firing off in the background. In the popup, popup.js is parsed as part of
// the document, so readyState is still "loading" here; in any other host
// (a test importing the module) it is not.
if (typeof document !== "undefined" && document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void main(), { once: true });
}
