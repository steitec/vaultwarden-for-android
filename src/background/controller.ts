import { Session } from "../session/session";
import { decryptVault, searchItems, matchItems, type VaultItem } from "../vault/index";
import { uriMatches } from "../vault/uri-match";
import { generateTotp } from "../totp";
import { isSyncResponse } from "../api/types";
import type { ItemSummary, Status, TotpCode } from "./messages";

export class LockedError extends Error {
  constructor() {
    super("Vault is locked");
    this.name = "LockedError";
  }
}

function summarize(i: VaultItem): ItemSummary {
  // Passwords never cross the message boundary to the popup. This is a
  // whitelist, not a delete: spreading the VaultItem and removing fields
  // would silently start leaking any secret a future field adds.
  return {
    id: i.id,
    name: i.name,
    username: i.username,
    hasTotp: i.totp !== null,
    undecryptable: i.undecryptable,
  };
}

/**
 * Whether credentials may be typed into this page at all.
 *
 * Plain http means the password is readable by anyone on the path, so the
 * only http origins allowed are the loopback ones, where there is no path.
 * Hostnames are matched exactly: `evil.localhost` and `127.0.0.1.evil.test`
 * are ordinary attacker-controlled names, not loopback.
 *
 * A tab URL is not guaranteed to be parseable as a URL — `about:blank`
 * parses but has no origin, and any exotic scheme could appear here — so a
 * parse failure is a refusal, not a stack trace out of fill().
 */
function isFillableOrigin(pageUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
}

export class Controller {
  private items: VaultItem[] = [];

  constructor(private session: Session) {}

  async init(): Promise<void> {
    await this.session.init();
  }

  status(): Status {
    // Read `settings` once: it returns a fresh defensive clone on every
    // access, so two reads are two allocations and are not identical.
    const s = this.session.settings;
    return {
      state: this.session.state,
      lastSyncMs: s?.lastSyncMs ?? null,
      email: s?.email ?? null,
    };
  }

  async unlock(pin: string): Promise<void> {
    await this.session.unlockWithPin(pin);
    await this.loadFromCache();
  }

  lock(): void {
    this.items = [];
    this.session.lock();
  }

  /**
   * Wipes the device: decrypted items, the in-memory keys, and every
   * persisted secret. See Session.signOut for why locking alone is not
   * enough.
   */
  async signOut(): Promise<void> {
    this.items = [];
    await this.session.signOut();
  }

  private require(): VaultItem[] {
    if (this.session.state !== "unlocked") throw new LockedError();
    this.session.touch();
    return this.items;
  }

  /**
   * Never throws. An unparseable or structurally invalid cache means the
   * vault is unusable until the next sync — it does not mean the unlock
   * failed. Throwing here would leave the session unlocked while unlock()
   * rejected, which is the worst of both: the caller believes it is locked
   * and the keys say otherwise.
   */
  private async loadFromCache(): Promise<void> {
    const cache = this.session.settings?.cipherCache;
    if (cache == null || this.session.userKey === null) {
      this.items = [];
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(cache);
    } catch {
      this.items = [];
      return;
    }
    if (!isSyncResponse(parsed)) {
      this.items = [];
      return;
    }

    this.items = await decryptVault(parsed, this.session.userKey, this.session.orgKeys);
  }

  async list(query: string): Promise<ItemSummary[]> {
    return searchItems(this.require(), query).map(summarize);
  }

  async matchesFor(pageUrl: string): Promise<ItemSummary[]> {
    return matchItems(this.require(), pageUrl).map(summarize);
  }

  async totpFor(itemId: string): Promise<TotpCode> {
    const item = this.require().find((i) => i.id === itemId);
    if (item?.totp == null) throw new Error("Item has no TOTP secret");
    return generateTotp(item.totp, Date.now());
  }

  async fill(tabId: number, itemId: string): Promise<void> {
    const item = this.require().find((i) => i.id === itemId);
    if (item === undefined) throw new Error("Item not found");

    // Read the destination from the tab itself rather than trusting a URL
    // passed in the message. The caller does not get to tell us where the
    // credentials are going.
    const tab = await browser.tabs.get(tabId);
    const pageUrl = tab.url;
    if (pageUrl === undefined) throw new Error("Cannot determine the page URL");

    if (!isFillableOrigin(pageUrl)) {
      throw new Error(
        "Refusing to fill on an insecure page. This site is not using https, so " +
          "the credentials could be read in transit.",
      );
    }

    // Re-check that this entry actually belongs to the page we are about to
    // fill. The tab may have navigated since the popup listed its matches, and
    // without this a password for one site can be injected into another.
    if (!item.uris.some((u) => uriMatches(pageUrl, u))) {
      throw new Error(
        "This entry does not match the page that is currently open. The tab may " +
          "have navigated — reopen the list and pick again.",
      );
    }

    // `undecryptable === false` does not imply fillable: a login cipher can
    // legitimately have URIs and no password at all, and matchItems returns
    // it. Injecting for one of those would grant the page the activeTab
    // content script and then report success for a fill that left the
    // password box empty. Refuse before anything is injected or sent.
    // A null *username* is fine — username-less entries are normal, and the
    // content script skips that field.
    if (item.password === null) {
      throw new Error("This entry has no password to fill.");
    }

    // activeTab grants access to this tab only, and only because the user just
    // acted. The script is injected now, not at page load.
    await browser.tabs.executeScript(tabId, { file: "autofill.js" });
    await browser.tabs.sendMessage(tabId, {
      kind: "fill",
      username: item.username,
      password: item.password,
    });
  }
}
