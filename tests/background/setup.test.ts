import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Controller } from "../../src/background/controller";
import { Session } from "../../src/session/session";
import { InvalidCredentialsError } from "../../src/api/identity";
import {
  DEFAULT_LOCK_TIMEOUT_MINUTES,
  DEFAULT_REQUIRE_MASTER_PASSWORD_ON_RESTART,
  isStoredState,
  type StoredState,
} from "../../src/session/store";
import { stretchMasterKey, deriveMasterKey } from "../../src/crypto/kdf";
import { toBase64, concat, utf8, type Bytes } from "../../src/crypto/bytes";
import { encryptToString, decryptToString, parseEncString } from "../../src/crypto/encstring";
import type { SymKey } from "../../src/crypto/encstring";

const PIN = "135790";
const PASSWORD = "correct-horse-battery-staple";
const SERVER = "https://v.example.net";

const KDF_CFG = { kdf: 0 as const, iterations: 100, memory: null, parallelism: null, salt: null };
const PRELOGIN_BODY = {
  kdf: 0,
  kdfIterations: 100,
  kdfMemory: null,
  kdfParallelism: null,
  salt: null,
};

function allZero(b: Uint8Array): boolean {
  return b.every((byte) => byte === 0);
}

async function wrap(data: Bytes, key: SymKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ck = await crypto.subtle.importKey("raw", key.encKey, "AES-CBC", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ck, data));
  const mk = await crypto.subtle.importKey(
    "raw",
    key.macKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", mk, concat(iv, ct)));
  return `2.${toBase64(iv)}|${toBase64(ct)}|${toBase64(mac)}`;
}

/**
 * A server-side account fixture. Argon2id-free (kdf 0, 100 iterations) and
 * built once, because RSA key generation and PIN wrapping are the slow parts
 * of this file.
 */
type Account = { protectedKey: string; protectedPrivate: string; userKeyRaw: Uint8Array };
let accountOnce: Account | null = null;
async function account(): Promise<Account> {
  if (accountOnce !== null) return accountOnce;
  const masterKey = await deriveMasterKey(PASSWORD, "a@b.com", KDF_CFG);
  const stretched = await stretchMasterKey(masterKey);
  const userKeyRaw = crypto.getRandomValues(new Uint8Array(64));
  const protectedKey = await wrap(userKeyRaw, stretched);
  const userKey: SymKey = { encKey: userKeyRaw.slice(0, 32), macKey: userKeyRaw.slice(32) };
  const protectedPrivate = await wrap(new Uint8Array(64).fill(1), userKey);
  accountOnce = { protectedKey, protectedPrivate, userKeyRaw };
  return accountOnce;
}

function emptyVault(extra: Record<string, unknown> = {}): unknown {
  return { profile: { organizations: null }, folders: [], ciphers: [], ...extra };
}

/** A cipher list the vault decrypter accepts, encrypted under `key`. */
async function vaultWith(name: string, key: SymKey): Promise<unknown> {
  return {
    profile: { organizations: null },
    folders: [],
    ciphers: [
      {
        id: "c1",
        organizationId: null,
        folderId: null,
        type: 1,
        name: await encryptToString(utf8(name), key),
        favorite: false,
        key: null,
        login: {
          username: await encryptToString(utf8("octocat"), key),
          password: await encryptToString(utf8("hunter2"), key),
          totp: null,
          uris: [{ uri: await encryptToString(utf8("https://github.com"), key), match: null }],
        },
      },
    ],
  };
}

type ServerOpts = {
  token?: { status: number; body: unknown };
  vault?: () => unknown | Promise<unknown>;
  vaultStatus?: number;
  refreshToken?: string;
};

/** Records every request so tests can count attempts and inspect payloads. */
type FakeServer = {
  calls: { url: string; body: string; auth: string | null }[];
  syncCalls: () => number;
  tokenCalls: () => number;
};

async function stubServer(opts: ServerOpts = {}): Promise<FakeServer> {
  const a = await account();
  const calls: FakeServer["calls"] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (
        url: string,
        init?: { body?: unknown; headers?: Record<string, string> },
      ): Promise<unknown> => {
        calls.push({
          url,
          body: String(init?.body ?? ""),
          auth: init?.headers?.Authorization ?? null,
        });

        if (url.includes("prelogin")) {
          return { ok: true, status: 200, json: async () => PRELOGIN_BODY };
        }
        if (url.includes("connect/token")) {
          if (opts.token !== undefined) {
            return {
              ok: opts.token.status < 400,
              status: opts.token.status,
              json: async () => opts.token!.body,
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "at",
              refresh_token: opts.refreshToken ?? "rt",
              expires_in: 3600,
              Key: a.protectedKey,
              PrivateKey: a.protectedPrivate,
            }),
          };
        }
        const status = opts.vaultStatus ?? 200;
        return {
          ok: status < 400,
          status,
          json: async () => (opts.vault ? await opts.vault() : emptyVault()),
        };
      },
    ),
  );

  return {
    calls,
    syncCalls: () => calls.filter((c) => c.url.includes("/api/sync")).length,
    tokenCalls: () => calls.filter((c) => c.url.includes("connect/token")).length,
  };
}

type Harness = {
  controller: Controller;
  session: Session;
  /** What the fake store actually holds — the only trustworthy witness. */
  stored: () => StoredState | null;
  saves: () => number;
  failNextSave: () => void;
};

function makeHarness(initial: StoredState | null = null): Harness {
  let saved: StoredState | null = initial;
  let saveCount = 0;
  let failSave = false;
  const session = new Session({
    load: async () => saved,
    save: async (s) => {
      if (failSave) {
        failSave = false;
        throw new Error("storage quota exceeded");
      }
      saveCount += 1;
      // Store a deep-ish copy, the way a real storage round-trip would:
      // handing back the caller's live object would let an in-memory
      // mutation masquerade as a persisted write.
      saved = JSON.parse(JSON.stringify(s)) as StoredState;
    },
    clear: async () => {
      saved = null;
    },
  });
  const controller = new Controller(session);
  return {
    controller,
    session,
    stored: () => saved,
    saves: () => saveCount,
    failNextSave: () => {
      failSave = true;
    },
  };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

/**
 * An account already on the device that unlocks per session: no wrapped PIN,
 * and `unlockMode: "session"`. The cryptographic fields are placeholders —
 * setup() overwrites every one of them; what this fixture exists to carry is
 * the identity (server and address) and the mode.
 */
function sessionModeAccount(over: Partial<StoredState> = {}): StoredState {
  return {
    serverUrl: SERVER,
    email: "a@b.com",
    deviceId: "dev",
    kdf: { kdf: 0, iterations: 600000, memory: null, parallelism: null, salt: null },
    protectedUserKey: "2.a|b|c",
    protectedPrivateKey: "2.d|e|f",
    pinWrapped: null,
    failedPinAttempts: 0,
    wrappedRefreshToken: null,
    cipherCache: null,
    lastSyncMs: 1000,
    lockTimeoutMinutes: 15,
    requireMasterPasswordOnRestart: false,
    unlockMode: "session",
    ...over,
  };
}

describe("Controller.setup and the unlock mode", () => {
  // setup() is not only first-time setup: it is the master-password way back
  // in, which for an account that unlocks per session runs after EVERY
  // Firefox restart. Rebuilding the record from defaults there would demand a
  // new PIN and turn the option off again, daily.
  it("keeps session mode when the same account signs in again", async () => {
    await stubServer();
    const h = makeHarness(sessionModeAccount());
    await h.controller.init();
    expect(h.controller.status().state).toBe("locked");

    await h.controller.setup({ serverUrl: SERVER, email: "a@b.com", password: PASSWORD, pin: "" });

    expect(h.controller.status().state).toBe("unlocked");
    expect(h.stored()!.unlockMode).toBe("session");
    expect(h.stored()!.pinWrapped).toBeNull();
  }, 30000);

  // A different address is a different vault. It starts at the default, and
  // the PIN it was given is wrapped as usual.
  //
  // Written with the OTHER address on the stored record rather than on the
  // sign-in: the fake server derives its keys from `a@b.com`, because the
  // address is the KDF salt, so signing in as anyone else cannot unwrap the
  // user key it hands back. The branch under test is the same either way.
  it("starts a different account at the default, PIN and all", async () => {
    await stubServer();
    const h = makeHarness(sessionModeAccount({ email: "someone-else@b.com" }));
    await h.controller.init();

    await h.controller.setup({ serverUrl: SERVER, email: "a@b.com", password: PASSWORD, pin: PIN });

    expect(h.stored()!.unlockMode).toBe("pin");
    expect(h.stored()!.pinWrapped).not.toBeNull();
  }, 30000);

  it("starts the same address on a different server at the default too", async () => {
    await stubServer();
    const h = makeHarness(sessionModeAccount({ serverUrl: "https://other.example.net" }));
    await h.controller.init();

    await h.controller.setup({ serverUrl: SERVER, email: "a@b.com", password: PASSWORD, pin: PIN });

    expect(h.stored()!.unlockMode).toBe("pin");
    expect(h.stored()!.pinWrapped).not.toBeNull();
  }, 30000);
});

describe("Controller.setup", () => {
  it("logs in, persists the account, and leaves the vault unlocked", async () => {
    const a = await account();
    const userKey: SymKey = { encKey: a.userKeyRaw.slice(0, 32), macKey: a.userKeyRaw.slice(32) };
    await stubServer({ vault: () => vaultWith("GitHub", userKey) });

    const h = makeHarness();
    await h.controller.init();
    expect(h.controller.status().state).toBe("empty");

    await h.controller.setup({ serverUrl: SERVER, email: "a@b.com", password: PASSWORD, pin: PIN });

    expect(h.controller.status().state).toBe("unlocked");
    const s = h.stored();
    expect(s).not.toBeNull();
    // A record the storage guard accepts, not just any object.
    expect(isStoredState(s)).toBe(true);
    expect(s!.serverUrl).toBe(SERVER);
    expect(s!.email).toBe("a@b.com");
    expect(s!.protectedUserKey).toBe(a.protectedKey);
    expect(s!.pinWrapped).not.toBeNull();
    expect(s!.lastSyncMs).not.toBeNull();
    expect(s!.lockTimeoutMinutes).toBe(DEFAULT_LOCK_TIMEOUT_MINUTES);
    expect(s!.requireMasterPasswordOnRestart).toBe(
      DEFAULT_REQUIRE_MASTER_PASSWORD_ON_RESTART,
    );

    const items = await h.controller.list("");
    expect(items.map((i) => i.name)).toEqual(["GitHub"]);
  }, 30000);

  it("never persists the master password or a raw token", async () => {
    await stubServer({ refreshToken: "the-refresh-token" });
    const h = makeHarness();
    await h.controller.init();
    await h.controller.setup({ serverUrl: SERVER, email: "a@b.com", password: PASSWORD, pin: PIN });

    const blob = JSON.stringify(h.stored());
    expect(blob).not.toContain(PASSWORD);
    expect(blob).not.toContain("the-refresh-token");
    // The access token is never written to disk at all; it lives only in
    // the unlocked session.
    expect(h.session.accessToken).toBe("at");
    expect(Object.keys(h.stored()!)).not.toContain("accessToken");
    // The refresh token IS stored, but only wrapped under the user key.
    expect(h.stored()!.wrappedRefreshToken).toMatch(/^2\./);
    const key = h.session.userKey!;
    await expect(
      decryptToString(parseEncString(h.stored()!.wrappedRefreshToken!), key),
    ).resolves.toBe("the-refresh-token");
  }, 30000);

  it("refuses a non-https server url outright, before anything leaves the device", async () => {
    // A master password must never be posted over plain http.
    const server = await stubServer();
    const h = makeHarness();
    await h.controller.init();

    for (const bad of [
      "http://v.example.net",
      "http://localhost:8080",
      "ftp://v.example.net",
      "v.example.net",
      "not a url",
      "",
    ]) {
      await expect(
        h.controller.setup({ serverUrl: bad, email: "a@b.com", password: PASSWORD, pin: PIN }),
      ).rejects.toThrow(/https/i);
    }

    expect(server.calls).toEqual([]);
    expect(h.stored()).toBeNull();
  }, 30000);

  it("reports a 2FA challenge as a resolved value carrying the server's provider list", async () => {
    // Not a rejection: error CLASSES do not survive runtime.sendMessage —
    // Firefox delivers a plain Error with the message only — so
    // TwoFactorRequiredError.providers would be lost on the way to the popup
    // and the popup would be left matching on message text. The providers
    // here are the server's answer, which is why the fixture uses a list a
    // hardcoded [0, 1] could not produce.
    await stubServer({ token: { status: 400, body: { TwoFactorProviders: [1] } } });
    const h = makeHarness();
    await h.controller.init();

    const result = await h.controller.setup({
      serverUrl: SERVER,
      email: "a@b.com",
      password: PASSWORD,
      pin: PIN,
    });

    expect(result).toEqual({ ok: false, reason: "twoFactor", providers: [1] });
    expect(h.stored()).toBeNull();
    expect(h.controller.status().state).toBe("empty");
  }, 30000);

  it("answers a completed login with a plain ok", async () => {
    await stubServer();
    const h = makeHarness();
    await h.controller.init();

    await expect(
      h.controller.setup({ serverUrl: SERVER, email: "a@b.com", password: PASSWORD, pin: PIN }),
    ).resolves.toEqual({ ok: true });
  }, 30000);

  it("still rejects every other login failure rather than folding it into the result", async () => {
    // Only the 2FA challenge becomes a value. An InvalidCredentialsError
    // reported as `{ ok: false }` would be indistinguishable from a 2FA
    // prompt at the popup and would render a code box for an account that
    // has no second factor.
    await stubServer({ token: { status: 400, body: { error: "invalid_grant" } } });
    const h = makeHarness();
    await h.controller.init();

    await expect(
      h.controller.setup({ serverUrl: SERVER, email: "a@b.com", password: "nope", pin: PIN }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  }, 30000);

  it("surfaces bad credentials field-agnostically and stores nothing", async () => {
    await stubServer({ token: { status: 400, body: { error: "invalid_grant" } } });
    const h = makeHarness();
    await h.controller.init();

    const err = await h.controller
      .setup({ serverUrl: SERVER, email: "a@b.com", password: "nope", pin: PIN })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(InvalidCredentialsError);
    expect((err as Error).message).toMatch(/email or password/i);
    expect(h.stored()).toBeNull();
    expect(h.session.userKey).toBeNull();
  }, 30000);

  it("forwards a second factor on the retry", async () => {
    const server = await stubServer();
    const h = makeHarness();
    await h.controller.init();

    await h.controller.setup({
      serverUrl: SERVER,
      email: "a@b.com",
      password: PASSWORD,
      pin: PIN,
      twoFactor: { token: "654321", provider: 0 },
    });

    const tokenCall = server.calls.find((c) => c.url.includes("connect/token"))!;
    expect(tokenCall.body).toContain("twoFactorToken=654321");
  }, 30000);

  it("leaves no phantom unlocked session when persisting the account fails", async () => {
    // If the store rejects after a successful login, the session must not be
    // left unlocked with resident keys over an account that was never
    // written. Nothing to lock, nothing to sync — it is still "empty".
    await stubServer();
    const h = makeHarness();
    await h.controller.init();
    h.failNextSave();

    await expect(
      h.controller.setup({ serverUrl: SERVER, email: "a@b.com", password: PASSWORD, pin: PIN }),
    ).rejects.toThrow(/quota/i);

    expect(h.stored()).toBeNull();
    expect(h.controller.status().state).toBe("empty");
    expect(h.session.userKey).toBeNull();
    expect(h.session.accessToken).toBeNull();
    await expect(h.controller.list("")).rejects.toThrow(/locked/i);
  }, 30000);

  it("rejects a too-short PIN before writing anything", async () => {
    await stubServer();
    const h = makeHarness();
    await h.controller.init();

    await expect(
      h.controller.setup({ serverUrl: SERVER, email: "a@b.com", password: PASSWORD, pin: "12" }),
    ).rejects.toThrow(/PIN/i);

    expect(h.stored()).toBeNull();
    expect(h.controller.status().state).toBe("empty");
    expect(h.session.userKey).toBeNull();
  }, 30000);

  it("zeroes the previous key when setup runs a second time in one page lifetime", async () => {
    // Two setups in one background-page lifetime (a re-login, or setup while
    // already unlocked) must not orphan the first key's buffer with live
    // vault-key bytes still in it.
    await stubServer();
    const h = makeHarness();
    await h.controller.init();

    await h.controller.setup({ serverUrl: SERVER, email: "a@b.com", password: PASSWORD, pin: PIN });
    const firstEnc = h.session.userKey!.encKey;
    const firstMac = h.session.userKey!.macKey;
    const orgKey: SymKey = {
      encKey: new Uint8Array(32).fill(7),
      macKey: new Uint8Array(32).fill(8),
    };
    h.session.orgKeys.set("org-1", orgKey);
    expect(allZero(firstEnc)).toBe(false);

    await h.controller.setup({ serverUrl: SERVER, email: "a@b.com", password: PASSWORD, pin: PIN });

    expect(allZero(firstEnc)).toBe(true);
    expect(allZero(firstMac)).toBe(true);
    expect(allZero(orgKey.encKey)).toBe(true);
    expect(allZero(orgKey.macKey)).toBe(true);
    // The new key is still live and correct.
    const a = await account();
    expect(toBase64(concat(h.session.userKey!.encKey, h.session.userKey!.macKey))).toBe(
      toBase64(a.userKeyRaw),
    );
  }, 45000);

  it("restores PIN unlock after a sign-out in the same page lifetime", async () => {
    // signOut leaves the restart flag alone; a full master-password login
    // satisfies the restart policy, so PIN unlock must be available again
    // without restarting Firefox.
    await stubServer();
    const h = makeHarness();
    await h.controller.init();
    await h.controller.setup({ serverUrl: SERVER, email: "a@b.com", password: PASSWORD, pin: PIN });
    await h.controller.signOut();
    expect(h.session.pinUnlockAvailable).toBe(false);

    await h.controller.setup({ serverUrl: SERVER, email: "a@b.com", password: PASSWORD, pin: PIN });

    expect(h.session.pinUnlockAvailable).toBe(true);
  }, 45000);
});

describe("Controller.syncNow", () => {
  async function setUpController(vault?: () => unknown): Promise<Harness & { server: FakeServer }> {
    const server = await stubServer({ vault });
    const h = makeHarness();
    await h.controller.init();
    await h.controller.setup({ serverUrl: SERVER, email: "a@b.com", password: PASSWORD, pin: PIN });
    return { ...h, server };
  }

  it("refuses to sync while locked", async () => {
    await stubServer();
    const h = makeHarness();
    await h.controller.init();
    await expect(h.controller.syncNow()).rejects.toThrow(/locked/i);
  }, 30000);

  it("PERSISTS the new cache and sync time — proven against the store, not the session", async () => {
    // `Session.settings` returns a fresh defensive clone on every access.
    // Reading the result back through `session.settings` would pass even if
    // syncNow had written to a throwaway object and persisted nothing, so
    // the assertion has to be against what the fake STORE actually holds.
    const a = await account();
    const userKey: SymKey = { encKey: a.userKeyRaw.slice(0, 32), macKey: a.userKeyRaw.slice(32) };
    const h = await setUpController(() => emptyVault());

    const before = h.stored()!;
    expect(JSON.parse(before.cipherCache!).ciphers).toEqual([]);
    const beforeSync = before.lastSyncMs!;

    const fresh = await vaultWith("Fresh Entry", userKey);
    await stubServer({ vault: () => fresh });

    // Advance the clock so an unchanged lastSyncMs is distinguishable from
    // a re-written one.
    const now = Date.now() + 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await h.controller.syncNow();

      const after = h.stored()!;
      expect(after.cipherCache).toBe(JSON.stringify(fresh));
      expect(after.lastSyncMs).toBe(now);
      expect(after.lastSyncMs).toBeGreaterThan(beforeSync);
      // And the decrypted view was refreshed from it.
      expect((await h.controller.list("")).map((i) => i.name)).toEqual(["Fresh Entry"]);
    } finally {
      clock.mockRestore();
    }
  }, 45000);

  it("refreshes an expired access token and retries exactly once", async () => {
    const h = await setUpController();
    // Drop the access token the way a lock/restart would, so the refresh
    // path runs.
    h.session.accessToken = null;

    const server = await stubServer({ refreshToken: "rotated" });
    await h.controller.syncNow();

    expect(server.tokenCalls()).toBe(1);
    expect(server.syncCalls()).toBe(1);
    expect(server.calls.find((c) => c.url.includes("connect/token"))!.body).toContain(
      "grant_type=refresh_token",
    );
    // The rotated refresh token was persisted, not just held in memory:
    // Vaultwarden invalidates the old one.
    await expect(
      decryptToString(parseEncString(h.stored()!.wrappedRefreshToken!), h.session.userKey!),
    ).resolves.toBe("rotated");
  }, 45000);

  it("stops after two sync attempts against a server that rejects even a fresh token", async () => {
    // Without the retry guard this recurses forever: every attempt gets a
    // 401, clears the token, refreshes, and tries again.
    const h = await setUpController();
    const server = await stubServer({ vaultStatus: 401 });

    await expect(h.controller.syncNow()).rejects.toThrow(/token/i);

    expect(server.syncCalls()).toBe(2);
  }, 45000);

  it("keeps the previous cache when the server is unreachable", async () => {
    const h = await setUpController();
    const before = h.stored()!.cipherCache;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("NetworkError");
      }),
    );

    await expect(h.controller.syncNow()).rejects.toThrow(/reach the server/i);
    expect(h.stored()!.cipherCache).toBe(before);
    expect(h.controller.status().state).toBe("unlocked");
  }, 45000);

  it("asks the user to sign in when there is no token to refresh", async () => {
    const h = await setUpController();
    h.session.accessToken = null;
    await h.session.update({ wrappedRefreshToken: null });

    await expect(h.controller.syncNow()).rejects.toThrow(/master password/i);
  }, 45000);

  it("sends the access token as a bearer credential and nothing else", async () => {
    const h = await setUpController();
    const server = await stubServer();
    await h.controller.syncNow();

    const syncCall = server.calls.find((c) => c.url.includes("/api/sync"))!;
    expect(syncCall.auth).toBe("Bearer at");
    expect(syncCall.body).not.toContain(PASSWORD);
  }, 45000);
});
