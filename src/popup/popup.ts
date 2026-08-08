import type { ItemSummary, Request, Status } from "../background/messages";

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
  return true;
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

/**
 * The message the user is shown for a failure.
 *
 * `.message` only, never `.cause`: a rejected fetch/JSON.parse deep in the
 * background page carries server-controlled text in the cause's message, and
 * this popup is not the place to render it.
 */
function errorText(e: unknown): string {
  if (e instanceof Error && e.message !== "") return e.message;
  return "Something went wrong. Please try again.";
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
 * thing that explains why the list is empty. Task 15 replaces the body for
 * the non-unlocked states; this header stays.
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

/**
 * The body for a vault that cannot be listed yet.
 *
 * A locked vault is the DEFAULT state every time this popup opens — it is
 * the normal case, not an error, and must not be presented as one. Task 15
 * replaces these placeholders with the real unlock and setup screens; this
 * function is the seam.
 */
export function renderLocked(state: "empty" | "locked", container: HTMLElement): void {
  container.replaceChildren();

  const headline = document.createElement("p");
  headline.className = "placeholder";
  headline.textContent = state === "empty" ? "No vault on this device yet." : "Your vault is locked.";
  container.append(headline);

  const hint = document.createElement("p");
  hint.className = "placeholder-hint";
  hint.textContent =
    state === "empty"
      ? "Sign in to your Vaultwarden server to get started."
      : "Unlock with your PIN to see your entries.";
  container.append(hint);
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

export async function main(): Promise<void> {
  const root = document.getElementById("root");
  const statusEl = document.getElementById("status");
  if (root === null || statusEl === null) return;

  const searchEl = document.getElementById("search");
  const search = searchEl instanceof HTMLInputElement ? searchEl : null;
  const banner = document.getElementById("error");

  let status: Status;
  try {
    status = await requestStatus();
  } catch (e) {
    statusEl.textContent = "Unavailable";
    renderMessage(errorText(e), root, "error");
    if (search !== null) search.disabled = true;
    return;
  }

  renderStatus(status, statusEl);

  // Locked is where this popup starts every single time. Asking a locked
  // vault for `list`/`matches` earns a LockedError and a blank panel.
  if (status.state !== "unlocked") {
    if (search !== null) {
      search.disabled = true;
      search.hidden = true;
    }
    renderLocked(status.state, root);
    return;
  }

  const tab = await activeTab();
  const pageUrl = usablePageUrl(tab);
  const tabId = tab?.id;

  try {
    renderList(await initialItems(pageUrl), root);
  } catch (e) {
    // The vault can lock between the status answer and this one — the idle
    // timer does not wait for the popup.
    renderMessage(errorText(e), root, "error");
    return;
  }

  // Renders are stamped so a slow answer for an earlier keystroke cannot
  // overwrite the list for a later one.
  let issued = 0;
  let rendered = 0;

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

  clearBanner(banner);
  search?.focus();
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
