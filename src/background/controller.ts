import { Session, MAX_PIN_ATTEMPTS } from "../session/session";
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
import { refreshToken, TwoFactorRequiredError } from "../api/identity";
import { encryptToString, decryptToString, parseEncString } from "../crypto/encstring";
import { unwrapOrgKeyMap } from "../crypto/keys";
import { utf8, zero } from "../crypto/bytes";
import type { SymKey } from "../crypto/encstring";
import { isRedeemable, type PendingFill } from "./pending";
import type { ItemSummary, PageMatches, SetupResult, Status, TotpCode } from "./messages";

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
  /**
   * The decrypted vault: cleartext passwords and TOTP secrets for every
   * entry. Nothing else in this process holds them, and they must not
   * outlive the session's keys — see the `onLock` wiring below.
   */
  private items: VaultItem[] = [];

  /**
   * Called after every lock, once the plaintext is gone.
   *
   * Assigned by the background page's entry point, which owns the connections
   * to any open popup. Defaults to a no-op so a Controller is usable on its
   * own, exactly as `Session.onLock` is.
   */
  onLocked: () => void = () => {};

  /**
   * A badge tap that landed on a locked vault, waiting for the unlock.
   *
   * Deliberately in memory only. A background-page restart loses it, which is
   * the safe direction: the alternative is a fill intent that outlives the
   * process that knew why it existed.
   */
  private pending: PendingFill | null = null;

  constructor(private session: Session) {
    // The session leaves the unlocked state on paths that never touch this
    // class: the idle timer fires on its own, and both `Session.signOut()`
    // and `Session.init()`'s re-entrancy guard call `Session.lock()`
    // directly. All of them zero the keys; none of them know about `items`.
    //
    // Wiring the hook in the constructor is what makes that impossible to
    // get wrong: there is no Controller anywhere — in this codebase or in a
    // test — that exists without it, so there is no "forgot to subscribe"
    // state to review for.
    session.onLock = () => {
      this.items = [];
      // Anything watching a locked vault has to hear about it from here: this
      // hook is the one place every lock path converges on -- the idle timer,
      // the Lock button, signOut, and Session.init's re-entrancy guard. See
      // F-5; the popup subscribes so an open panel stops showing the vault.
      this.onLocked();
      // The same hook, for the same reason. A pending fill is an intent to
      // hand out a credential; a lock must discard it along with the
      // plaintext, on every path that reaches here -- the idle timer,
      // signOut, and Session.init's re-entrancy guard alike.
      this.pending = null;
    };
  }

  async init(): Promise<void> {
    await this.session.init();
  }

  status(): Status {
    // First, before anything reads the session. A panel that opens onto an
    // unlocked-looking vault whose every action then fails is F-5 wearing
    // different clothes.
    this.session.lockIfExpired();
    // Read `settings` once: it returns a fresh defensive clone on every
    // access, so two reads are two allocations and are not identical.
    const s = this.session.settings;
    return {
      state: this.session.state,
      lastSyncMs: s?.lastSyncMs ?? null,
      email: s?.email ?? null,
      serverUrl: s?.serverUrl ?? null,
      pinUnlockAvailable: this.session.pinUnlockAvailable,
      // MAX_PIN_ATTEMPTS minus what has already been spent. Session charges
      // the attempt BEFORE trying it and gives up once the count EXCEEDS
      // the maximum, so a stored `n` leaves exactly `MAX - n` tries. Clamped
      // because an over-counted record (a crash between charge and unwrap
      // costs an attempt, deliberately) must not render as a negative
      // countdown.
      pinAttemptsRemaining: Math.max(0, MAX_PIN_ATTEMPTS - (s?.failedPinAttempts ?? 0)),
    };
  }

  async unlock(pin: string): Promise<void> {
    await this.session.unlockWithPin(pin);
    await this.loadFromCache();
    await this.redeemPending();
  }

  /** Records a badge tap made against a locked vault. */
  recordPending(p: PendingFill): void {
    this.pending = p;
  }

  /**
   * Turns a tap recorded against a locked vault into a fill.
   *
   * Every failure is silent and total. The pending fill is consumed first, so
   * no path can fill twice, and nothing that happened to the tab in the
   * meantime may fail the unlock the user actually asked for -- they typed
   * the right PIN, so their vault opens either way.
   *
   * `fill` is called unchanged rather than reimplemented, so every guard it
   * already runs applies again here: isFillableOrigin, the uriMatches recheck
   * against the tab's current URL, and the refusal for an entry with no
   * password. This is an intent to call it, never a way around it.
   */
  private async redeemPending(): Promise<void> {
    const p = this.pending;
    this.pending = null;
    if (p === null) return;

    try {
      const tab = await browser.tabs.get(p.tabId);
      if (!isRedeemable(p, tab.url, Date.now())) return;

      // Non-null by isRedeemable, which refuses an undefined url.
      const url = tab.url ?? "";
      const matches = matchItems(this.require("user"), url);
      // Exactly one, or nothing. Several entries for one origin is a choice
      // only the user can make, and the popup is already open on them.
      const only = matches.length === 1 ? matches[0] : undefined;
      if (only === undefined) return;

      await this.fill(p.tabId, only.id);
    } catch {
      // A closed tab, a navigated tab, an entry fill() refuses. None of them
      // are the unlock's problem.
    }
  }

  /**
   * First-run master-password login: verifies the credentials, unwraps the
   * vault keys, wraps them under the PIN, and writes the account to disk.
   *
   * Host access is not checked here, and cannot usefully be: the broad https
   * wildcard is a REQUIRED permission (manifest.json), so every https server
   * a user could enter is granted at install time. The popup used to ask for the
   * one configured origin and this method used to verify it with
   * `permissions.contains()`; against a wildcard already held, both could
   * only ever answer yes. Decided 2026-08-27 — see § F-3 of
   * `docs/VERIFICATION-2026-08-25.md` for the posture and its price.
   *
   * Failure atomicity: nothing touches the session until the store has
   * accepted the new state (see Session.adoptLogin). If the PIN wrap or the
   * save fails, the freshly derived keys are zeroed and the session is left
   * exactly as it was — locked or empty — rather than unlocked over an
   * account that was never persisted.
   *
   * A 2FA challenge comes back as a resolved `SetupResult` and not as a
   * rejection; see `SetupResult` in messages.ts for why the exception cannot
   * carry the provider list across the message boundary. Every other login
   * failure — wrong credentials, an unreachable server — still throws.
   */
  async setup(params: {
    serverUrl: string;
    email: string;
    password: string;
    pin: string;
    twoFactor?: { token: string; provider: number };
  }): Promise<SetupResult> {
    const serverUrl = params.serverUrl.trim().replace(/\/+$/, "");

    let parsed: URL;
    try {
      parsed = new URL(serverUrl);
    } catch {
      throw new InsecureServerUrlError();
    }
    if (parsed.protocol !== "https:") throw new InsecureServerUrlError();

    const deviceId = crypto.randomUUID();
    // InvalidCredentialsError and everything else propagate untouched from
    // here; see login.ts for why they may not be reshaped. Only the 2FA
    // challenge is converted, and only into a value that carries the
    // server's own provider list — the one piece of it that cannot survive
    // as an exception.
    let r;
    try {
      r = await performLogin({
        serverUrl,
        email: params.email,
        password: params.password,
        deviceId,
        twoFactor: params.twoFactor,
      });
    } catch (e) {
      if (e instanceof TwoFactorRequiredError) {
        return { ok: false, reason: "twoFactor", providers: e.providers };
      }
      throw e;
    }

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
    return { ok: true };
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
    // Like matchesFor, this method tests session.state itself instead of
    // going through require(), so it must settle the deadline itself too —
    // otherwise a session that expired while nothing else touched it reads
    // as "unlocked" here and this mints a fresh refresh token and reaches
    // the network on an expired vault. Placed first so the retry re-entry
    // below (mayRetry: false) is covered by the same call.
    this.session.lockIfExpired();

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
      // Persist whatever the server handed back, immediately, before the
      // sync below can fail.
      //
      // The original rationale here — "Vaultwarden invalidates the old
      // one" — was WRONG, and the integration suite disproved it: 1.37.1
      // returns the byte-identical refresh token and the old one keeps
      // working (see `does NOT rotate the refresh token` in
      // tests/integration/live.test.ts). So on 1.37.1 this write is a
      // no-op. It stays because a server that DOES rotate is the case that
      // costs the user their session: dropping a rotated token here signs
      // them out at the next unlock, and upstream Bitwarden rotates.
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

  /**
   * `items` is not cleared here, and that is deliberate: `Session.lock()`
   * runs the `onLock` hook installed in the constructor, which clears it.
   * Clearing it here as well would be a second mechanism doing the same job
   * — and a second mechanism that keeps THIS path green would hide a broken
   * hook on the paths that have no second mechanism, above all the idle
   * timer.
   */
  lock(): void {
    this.session.lock();
  }

  /**
   * Wipes the device: decrypted items, the in-memory keys, and every
   * persisted secret. See Session.signOut for why locking alone is not
   * enough; it locks first, so the hook clears `items` here too.
   */
  async signOut(): Promise<void> {
    await this.session.signOut();
  }

  /**
   * The unlocked-vault guard, and the one place that decides whether a read
   * counts as interaction.
   *
   * `intent` is not a convenience: it is the difference between a person and
   * a page. `matchesFor` is driven by the content script's MutationObserver,
   * so a login page that mutates on its own -- a carousel, a clock, a React
   * re-render -- reaches this with nobody present. Extending the idle timeout
   * for it lets an open tab hold the vault unlocked indefinitely, which is
   * F-4 in docs/VERIFICATION-2026-08-25.md. Passing it at every call site
   * rather than inferring it means a new caller has to state which it is.
   */
  private require(intent: "user" | "page"): VaultItem[] {
    // Settle expiry BEFORE the state test, so an expired session is
    // indistinguishable from a locked one to every caller. The idle lock is a
    // deadline rather than a timer precisely because nothing can be relied on
    // to fire on a sleeping device; this is where the deadline is read.
    this.session.lockIfExpired();
    if (this.session.state !== "unlocked") throw new LockedError();
    if (intent === "user") this.session.touch();
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
    // One read of `settings`: it returns a fresh defensive clone per access.
    const settings = this.session.settings;
    const userKey = this.session.userKey;
    if (settings === null || settings.cipherCache === null || userKey === null) {
      this.items = [];
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(settings.cipherCache);
    } catch {
      this.items = [];
      return;
    }
    if (!isSyncResponse(parsed)) {
      this.items = [];
      return;
    }

    // Rebuild the organization keys from the cache before decrypting it.
    //
    // `Session.lock()` zeroes and clears them, and `unlockWithPin` restores
    // only the user key — nothing else ever repopulates the map. Without
    // this, every organization cipher decrypts to the "cannot be decrypted"
    // placeholder from the first idle lock onwards, until the user signs in
    // with the master password again. Everything needed is in hand at this
    // exact moment: the RSA private key (wrapped under the user key, in
    // stored state) and each organization's key (wrapped under the RSA
    // public key, in the cached sync payload).
    //
    // Unconditional, even when the map is already populated: this also runs
    // on the sync path, and a sync that added the user to a NEW organization
    // brings that organization's key with it. A rebuild that skipped a
    // non-empty map would never pick it up.
    try {
      this.session.adoptOrgKeys(
        await unwrapOrgKeyMap(
          settings.protectedPrivateKey,
          parsed.profile.organizations ?? [],
          userKey,
        ),
      );
    } catch {
      // Never throws — see the doc comment above. A private key that will
      // not unwrap makes the organization items undecryptable, which is
      // exactly what the user sees today; it is not a reason to reject an
      // unlock that has already handed out the user key. An empty map, not
      // the stale one, so what the session holds always reflects the last
      // rebuild rather than some earlier payload.
      this.session.adoptOrgKeys(new Map());
    }

    const items = await decryptVault(parsed, userKey, this.session.orgKeys);
    // The idle timer can fire during the decryption above. `onLock` has
    // already emptied `items` by then, and assigning the freshly decrypted
    // vault over the top would silently repopulate a locked controller with
    // the plaintext the lock just discarded.
    this.items = this.session.state === "unlocked" ? items : [];
  }

  async list(query: string): Promise<ItemSummary[]> {
    return searchItems(this.require("user"), query).map(summarize);
  }

  /**
   * What this page offers, if anything.
   *
   * Takes no URL: the background page reads it from the tab itself (see
   * `resolveTabFor`), because the caller is now a content script running on
   * pages this addon does not control.
   *
   * A locked vault answers "locked" rather than throwing. The content script
   * needs that state to tell "cannot be consulted" apart from "nothing
   * matches" — the first renders an unlock badge, the second renders nothing.
   */
  async matchesFor(pageUrl: string | undefined): Promise<PageMatches> {
    // Settle expiry first: this method reads session.state directly and
    // returns on two paths before require() is reached, so the deadline must
    // be settled here too. Without it the content script gets no badge on the
    // first call after expiry — the page either sees "unlocked" or sees an
    // exception that gets swallowed.
    this.session.lockIfExpired();
    if (this.session.state !== "unlocked") return { state: "locked" };
    if (pageUrl === undefined) return { state: "unlocked", items: [] };
    return { state: "unlocked", items: matchItems(this.require("page"), pageUrl).map(summarize) };
  }

  async totpFor(itemId: string): Promise<TotpCode> {
    const item = this.require("user").find((i) => i.id === itemId);
    if (item?.totp == null) throw new Error("Item has no TOTP secret");
    return generateTotp(item.totp, Date.now());
  }

  async fill(tabId: number, itemId: string): Promise<void> {
    const item = this.require("user").find((i) => i.id === itemId);
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
    // it. Sending for one of those would report success for a fill that left
    // the password box empty. Refuse before anything is sent.
    //
    // It matters more now than it did when the content script was injected on
    // demand: an entry with no password still counts as a match, so it would
    // put a badge on the page and then do nothing when tapped.
    //
    // A null *username* is fine — username-less entries are normal, and the
    // content script skips that field.
    if (item.password === null) {
      throw new Error("This entry has no password to fill.");
    }

    // The content script is declared in the manifest and is already present on
    // every fillable origin, so there is nothing to inject. Injecting anyway
    // would load a second copy into the same isolated world and register a
    // second onMessage listener, filling twice per tap.
    await browser.tabs.sendMessage(tabId, {
      kind: "fill",
      username: item.username,
      password: item.password,
    });
  }
}
