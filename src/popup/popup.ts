import type { ItemSummary, Request, SetupResult, Status } from "../background/messages";
import { errorText } from "./errors";
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
 */
const REQUEST_TIMEOUT_MS = 4000;

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
  return withTimeout(pending, REQUEST_TIMEOUT_MS);
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

async function requestStatus(): Promise<Status> {
  const answer = await request({ kind: "status" });
  if (!isStatus(answer)) throw new UnexpectedResponseError();
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

async function activeTab(): Promise<browser.tabs.Tab | null> {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The tab URL, or null when there is nothing usable to match against.
 *
 * `tab.url` is genuinely absent whenever `activeTab` has not been granted for
 * that tab and on privileged pages, and an empty string is not a page — it is
 * a request for `matches` that can only ever answer "none". Returning null
 * here sends the caller straight to the full list instead.
 */
function usablePageUrl(tab: browser.tabs.Tab | null): string | null {
  const url = tab?.url;
  if (typeof url !== "string" || url === "") return null;
  return url;
}

/**
 * Page matches first: on a phone the entry you want is almost always for the
 * page you are looking at. Falls back to the whole vault when the page has no
 * matches or when there is no page URL to match against.
 */
async function initialItems(pageUrl: string | null): Promise<ItemSummary[]> {
  if (pageUrl !== null) {
    const matches = await requestItems({ kind: "matches", pageUrl });
    if (matches.length > 0) return matches;
  }
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

  // Renders are stamped so a slow answer for an earlier keystroke cannot
  // overwrite the list for a later one.
  let issued = 0;
  let rendered = 0;

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
        const seq = ++issued;
        const query = search.value;
        void (async () => {
          try {
            const items = await requestItems({ kind: "list", query });
            if (seq < rendered) return;
            rendered = seq;
            clearBanner(banner);
            renderList(items, root);
          } catch (e) {
            if (seq < rendered) return;
            rendered = seq;
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

    const tab = await activeTab();
    const pageUrl = usablePageUrl(tab);
    tabId = tab?.id;

    try {
      renderList(await initialItems(pageUrl), root);
    } catch (e) {
      // The vault can lock between the status answer and this one — the idle
      // timer does not wait for the popup.
      renderMessage(errorText(e), root, "error");
      return;
    }

    wire();
    clearBanner(banner);
    search?.focus();
  }

  /**
   * Hands a completed sign-in form to the background page.
   *
   * `browser.permissions.request()` is the FIRST statement, before any
   * await, and the form calls this synchronously from its submit listener.
   * Firefox only honours the call while the user-input handler is still on
   * the stack, and the gesture does not survive `runtime.sendMessage` — so
   * the background page verifies the grant with `contains()` and this is the
   * only place that can ask for it. `originPattern` was built by the form's
   * synchronous pre-check for exactly this reason.
   */
  async function submitSetup(v: SetupValues): Promise<void> {
    const granted = await browser.permissions.request({ origins: [v.originPattern] });
    if (!granted) {
      throw new Error(
        `This add-on needs your permission to contact ${v.originPattern.replace(/\/\*$/, "")}. ` +
          "Sign-in cannot continue without it.",
      );
    }

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
      throw e;
    }
    await route();
  }

  async function route(known?: Status): Promise<void> {
    let status: Status;
    if (known !== undefined) {
      status = known;
    } else {
      try {
        status = await requestStatus();
      } catch (e) {
        statusEl.textContent = "Unavailable";
        renderMessage(errorText(e), root, "error");
        if (search !== null) search.disabled = true;
        hideSettings();
        return;
      }
    }

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
