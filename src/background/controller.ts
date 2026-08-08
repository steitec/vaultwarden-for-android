import { Session } from "../session/session";
import {
  DEFAULT_LOCK_TIMEOUT_MINUTES,
  DEFAULT_REQUIRE_MASTER_PASSWORD_ON_RESTART,
  type StoredState,
} from "../session/store";
import { decryptVault, searchItems, matchItems, type VaultItem } from "../vault/index";
import { uriMatches } from "../vault/uri-match";
import { generateTotp } from "../totp";
import { isSyncResponse } from "../api/types";
import { performLogin } from "./login";
import { wrapKeyWithPin } from "../session/pin";
import { sync, UnauthorizedError } from "../api/sync";
import { refreshToken } from "../api/identity";
import { encryptToString, decryptToString, parseEncString } from "../crypto/encstring";
import { utf8, zero } from "../crypto/bytes";
import type { SymKey } from "../crypto/encstring";
import type { ItemSummary, Status, TotpCode } from "./messages";

export class LockedError extends Error {
  constructor() {
    super("Vault is locked");
    this.name = "LockedError";
  }
}

/**
 * The configured server address was not a usable https URL.
 *
 * https is mandatory, not preferred: setup posts the derived master password
 * hash to this address, and every later sync carries a bearer token to it.
 * Over plain http both are readable by anyone on the path. There is no
 * loopback exemption here (unlike `isFillableOrigin`, which governs pages
 * the user happens to visit) — the server address is typed once, by the
 * user, and a self-hosted Vaultwarden reachable only over http is a
 * misconfiguration this client will not paper over.
 */
export class InsecureServerUrlError extends Error {
  constructor() {
    super("Enter your server address as a full https:// URL.");
    this.name = "InsecureServerUrlError";
  }
}

export class HostPermissionDeniedError extends Error {
  constructor(origin: string) {
    super(
      `This add-on needs your permission to contact ${origin}. ` +
        "Setup cannot continue without it.",
    );
    this.name = "HostPermissionDeniedError";
  }
}

/** Zeroes a login result's key material after a failed adoption. */
function zeroKeys(userKey: SymKey, orgKeys: Map<string, SymKey>): void {
  zero(userKey.encKey);
  zero(userKey.macKey);
  for (const k of orgKeys.values()) {
    zero(k.encKey);
    zero(k.macKey);
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

  /**
   * First-run master-password login: verifies the credentials, unwraps the
   * vault keys, wraps them under the PIN, and writes the account to disk.
   *
   * Host access is requested for the ONE origin the user configured, never
   * for the broad https wildcard the manifest has to declare. MV2 cannot
   * express a runtime-determined origin in `optional_permissions`, so the
   * manifest names a pattern; the extension only ever holds the single
   * origin granted here. The request happens before the first network call,
   * so a declined prompt costs nothing and leaks nothing to the server.
   *
   * Failure atomicity: nothing touches the session until the store has
   * accepted the new state (see Session.adoptLogin). If the PIN wrap or the
   * save fails, the freshly derived keys are zeroed and the session is left
   * exactly as it was — locked or empty — rather than unlocked over an
   * account that was never persisted.
   */
  async setup(params: {
    serverUrl: string;
    email: string;
    password: string;
    pin: string;
    twoFactor?: { token: string; provider: number };
  }): Promise<void> {
    const serverUrl = params.serverUrl.trim().replace(/\/+$/, "");

    let parsed: URL;
    try {
      parsed = new URL(serverUrl);
    } catch {
      throw new InsecureServerUrlError();
    }
    if (parsed.protocol !== "https:") throw new InsecureServerUrlError();

    const granted = await browser.permissions.request({ origins: [`${parsed.origin}/*`] });
    if (!granted) throw new HostPermissionDeniedError(parsed.origin);

    const deviceId = crypto.randomUUID();
    // TwoFactorRequiredError and InvalidCredentialsError propagate untouched
    // from here; see login.ts for why neither may be reshaped.
    const r = await performLogin({
      serverUrl,
      email: params.email,
      password: params.password,
      deviceId,
      twoFactor: params.twoFactor,
    });

    try {
      const state: StoredState = {
        serverUrl,
        email: params.email,
        deviceId,
        kdf: r.kdf,
        protectedUserKey: r.tokens.Key,
        protectedPrivateKey: r.tokens.PrivateKey,
        pinWrapped: await wrapKeyWithPin(r.userKey, params.pin),
        failedPinAttempts: 0,
        // Wrapped under the user key, so a locked vault cannot reach the
        // server on its own.
        wrappedRefreshToken: await encryptToString(utf8(r.tokens.refresh_token), r.userKey),
        cipherCache: JSON.stringify(r.payload),
        lastSyncMs: Date.now(),
        lockTimeoutMinutes: DEFAULT_LOCK_TIMEOUT_MINUTES,
        requireMasterPasswordOnRestart: DEFAULT_REQUIRE_MASTER_PASSWORD_ON_RESTART,
      };
      await this.session.adoptLogin(state, {
        userKey: r.userKey,
        orgKeys: r.orgKeys,
        accessToken: r.tokens.access_token,
      });
    } catch (e) {
      // Ownership never transferred to the session, so these buffers are
      // ours to wipe. Re-throw unchanged: the message is already
      // user-facing and carries no secret.
      zeroKeys(r.userKey, r.orgKeys);
      throw e;
    }

    await this.loadFromCache();
  }

  /**
   * Fetches the vault and replaces the offline cache.
   *
   * Takes no arguments deliberately: this is reachable over the message
   * boundary, and the retry bookkeeping is not something a caller gets to
   * set.
   */
  async syncNow(): Promise<void> {
    await this.syncAttempt(true);
  }

  private async syncAttempt(mayRetry: boolean): Promise<void> {
    // One read: `settings` returns a fresh clone per access. Writes go
    // through session.update() — assigning to this clone would persist
    // nothing and the vault would silently serve a stale cache forever.
    const settings = this.session.settings;
    const userKey = this.session.userKey;
    if (this.session.state !== "unlocked" || settings === null || userKey === null) {
      throw new LockedError();
    }

    // Held in a local across the awaits below rather than re-read from the
    // session. The idle-lock timer can fire between any two awaits and
    // null it out mid-flight; re-reading would then hand `null` straight
    // into the Authorization header.
    let accessToken = this.session.accessToken;
    if (accessToken === null) {
      if (settings.wrappedRefreshToken == null) {
        throw new Error("Sign in with your master password to sync.");
      }
      // Unwrapping requires the user key, which only exists while unlocked.
      const rt = await decryptToString(parseEncString(settings.wrappedRefreshToken), userKey);
      const t = await refreshToken(settings.serverUrl, rt);
      accessToken = t.access_token;
      this.session.accessToken = accessToken;
      // Persist the rotated refresh token immediately. Vaultwarden
      // invalidates the old one, so losing it here — e.g. because the sync
      // below fails — would silently sign the user out at the next unlock.
      await this.session.update({
        wrappedRefreshToken: await encryptToString(utf8(t.refresh_token), userKey),
      });
    }

    let payload;
    try {
      payload = await sync(settings.serverUrl, accessToken);
    } catch (e) {
      if (e instanceof UnauthorizedError && mayRetry) {
        // The access token expired mid-session; refresh once and retry
        // rather than surfacing a spurious sign-in prompt. The guard
        // matters: without it, a server that rejects even a fresh token
        // recurses forever.
        this.session.accessToken = null;
        return this.syncAttempt(false);
      }
      throw e;
    }

    await this.session.update({
      cipherCache: JSON.stringify(payload),
      lastSyncMs: Date.now(),
    });
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
