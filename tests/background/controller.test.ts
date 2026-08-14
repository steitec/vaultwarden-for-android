import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Controller } from "../../src/background/controller";
import { wrapKeyWithPin } from "../../src/session/pin";
import { Session, MAX_PIN_ATTEMPTS } from "../../src/session/session";
import type { StoredState } from "../../src/session/store";
import type { SymKey } from "../../src/crypto/encstring";
import { encryptToString } from "../../src/crypto/encstring";
import { toBase64, utf8 } from "../../src/crypto/bytes";
import { InvalidResponseError } from "../../src/api/identity";

const PIN = "135790";
const userKey: SymKey = {
  encKey: new Uint8Array(32).fill(1),
  macKey: new Uint8Array(32).fill(2),
};

function allZero(b: Uint8Array): boolean {
  return b.every((byte) => byte === 0);
}

// Argon2id at the real PIN-wrapping parameters costs several hundred ms, and
// every test in this file needs the same wrapped key. Wrap once.
let pinWrappedOnce: Awaited<ReturnType<typeof wrapKeyWithPin>> | null = null;
async function pinWrapped(): Promise<Awaited<ReturnType<typeof wrapKeyWithPin>>> {
  pinWrappedOnce ??= await wrapKeyWithPin(userKey, PIN);
  return { ...pinWrappedOnce };
}

async function enc(text: string, key: SymKey = userKey): Promise<string> {
  return encryptToString(utf8(text), key);
}

async function encOrNull(text: string | null, key: SymKey = userKey): Promise<string | null> {
  return text === null ? null : enc(text, key);
}

/**
 * The RSA keypair an account's organization keys are wrapped under, plus the
 * matching `protectedPrivateKey` as it is stored (PKCS#8, wrapped under the
 * user key). Generating an RSA-2048 key costs real time, so the whole suite
 * shares one — it stands in for "this account", and every organization
 * fixture below is encrypted to it.
 */
let rsaOnce: { pair: CryptoKeyPair; protectedPrivateKey: string } | null = null;
async function rsa(): Promise<{ pair: CryptoKeyPair; protectedPrivateKey: string }> {
  if (rsaOnce === null) {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-1",
      },
      true,
      ["encrypt", "decrypt"],
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    rsaOnce = { pair, protectedPrivateKey: await encryptToString(pkcs8, userKey) };
  }
  return rsaOnce;
}

/** One organization, as it appears in `profile.organizations` of a sync payload. */
type OrgFixture = { id: string; name: string; key: string; symKey: SymKey };

async function makeOrg(id: string): Promise<OrgFixture> {
  const { pair } = await rsa();
  const raw = crypto.getRandomValues(new Uint8Array(64));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pair.publicKey, raw));
  return {
    id,
    name: `Org ${id}`,
    // Type 4: RSA-2048 OAEP-SHA1, ciphertext only — the wire format the
    // server actually hands back for an organization key.
    key: `4.${toBase64(ct)}`,
    symKey: { encKey: raw.slice(0, 32), macKey: raw.slice(32) },
  };
}

type Seed = {
  id: string;
  name: string;
  username?: string | null;
  password?: string | null;
  totp?: string | null;
  uris?: string[];
  type?: number;
  /** Encrypts this cipher under that organization's key instead of the user key. */
  orgId?: string;
};

async function cacheOf(seeds: Seed[], orgs: OrgFixture[] = []): Promise<string> {
  const ciphers = [];
  for (const s of seeds) {
    const org = s.orgId === undefined ? undefined : orgs.find((o) => o.id === s.orgId);
    if (s.orgId !== undefined && org === undefined) {
      throw new Error(`Seed ${s.id} names organization ${s.orgId}, which was not supplied`);
    }
    const key = org?.symKey ?? userKey;

    const uris = [];
    for (const u of s.uris ?? []) {
      uris.push({ uri: await enc(u, key), match: null });
    }
    ciphers.push({
      id: s.id,
      organizationId: org?.id ?? null,
      folderId: null,
      type: s.type ?? 1,
      name: await enc(s.name, key),
      favorite: false,
      key: null,
      login: {
        username: await encOrNull(s.username === undefined ? "octocat" : s.username, key),
        password: await encOrNull(s.password === undefined ? "hunter2" : s.password, key),
        totp: await encOrNull(s.totp ?? null, key),
        uris,
      },
    });
  }
  return JSON.stringify({
    profile: {
      organizations:
        orgs.length === 0 ? null : orgs.map((o) => ({ id: o.id, name: o.name, key: o.key })),
    },
    folders: [],
    ciphers,
  });
}

const DEFAULT_SEEDS: Seed[] = [
  { id: "c1", name: "GitHub", uris: ["https://github.com"] },
];

type Harness = {
  controller: Controller;
  /** The controller's own session, for the key-lifetime assertions. */
  session: Session;
  /** What the fake store currently holds — null once it has been cleared. */
  stored: () => StoredState | null;
};

async function makeController(overrides: Partial<StoredState> = {}): Promise<Harness> {
  let saved: StoredState | null = {
    serverUrl: "https://v.example.net",
    email: "a@b.com",
    deviceId: "dev",
    kdf: { kdf: 0, iterations: 600000, memory: null, parallelism: null, salt: null },
    protectedUserKey: "2.a|b|c",
    protectedPrivateKey: "2.d|e|f",
    pinWrapped: await pinWrapped(),
    failedPinAttempts: 0,
    wrappedRefreshToken: null,
    cipherCache: await cacheOf(DEFAULT_SEEDS),
    lastSyncMs: 1000,
    lockTimeoutMinutes: 15,
    requireMasterPasswordOnRestart: false,
    ...overrides,
  };

  const session = new Session({
    load: async () => saved,
    save: async (s) => {
      saved = s;
    },
    clear: async () => {
      saved = null;
    },
  });
  const controller = new Controller(session);
  await controller.init();
  return { controller, session, stored: () => saved };
}

/** Stubs `browser.tabs` for the fill tests and hands back the spies. */
function stubTabs(url: string | undefined) {
  const get = vi.fn().mockResolvedValue({ id: 7, url });
  const executeScript = vi.fn().mockResolvedValue([]);
  const sendMessage = vi.fn().mockResolvedValue({ filledUsername: true, filledPassword: true });
  vi.stubGlobal("browser", { tabs: { get, executeScript, sendMessage } });
  return { get, executeScript, sendMessage };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("Controller", () => {
  it("reports locked before unlocking and exposes no items", async () => {
    const { controller } = await makeController();
    expect(controller.status().state).toBe("locked");
    await expect(controller.list("")).rejects.toThrow(/locked/i);
    await expect(controller.matchesFor("https://github.com/")).rejects.toThrow(/locked/i);
    await expect(controller.totpFor("c1")).rejects.toThrow(/locked/i);
    await expect(controller.fill(7, "c1")).rejects.toThrow(/locked/i);
  }, 20000);

  it("serves items from the cache after unlocking, without network access", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { controller } = await makeController();
    await controller.unlock(PIN);

    const items = await controller.list("");
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe("GitHub");
    expect(items[0]!.username).toBe("octocat");
  }, 20000);

  it("never puts a password in a summary, under any key name", async () => {
    // Asserting `items[0].password === undefined` would be vacuous:
    // ItemSummary has no `password` key at all, so that assertion holds even
    // if the controller leaked the secret under some other name. Pin the
    // exact key set, and then assert the property that actually matters and
    // survives renaming: the serialised payload does not contain the secret.
    const { controller } = await makeController();
    await controller.unlock(PIN);

    const items = await controller.list("");
    expect(Object.keys(items[0]!).sort()).toEqual([
      "hasTotp",
      "id",
      "name",
      "undecryptable",
      "username",
    ]);
    expect(JSON.stringify(items)).not.toContain("hunter2");

    const matches = await controller.matchesFor("https://github.com/login");
    expect(JSON.stringify(matches)).not.toContain("hunter2");
  }, 20000);

  it("reports the last sync time so offline state is visible", async () => {
    const { controller } = await makeController();
    await controller.unlock(PIN);
    expect(controller.status().lastSyncMs).toBe(1000);
    expect(controller.status().email).toBe("a@b.com");
  }, 20000);

  it("reports the account the setup screen has to prefill", async () => {
    // A locked vault with no usable PIN is sent back to the master-password
    // screen. Without the server address in the status there is nothing to
    // prefill it with and the user has to retype it from memory.
    const { controller } = await makeController();
    expect(controller.status().serverUrl).toBe("https://v.example.net");
    expect(controller.status().email).toBe("a@b.com");
  }, 20000);

  it("reports whether a PIN unlock can succeed at all", async () => {
    const usable = await makeController();
    expect(usable.controller.status().pinUnlockAvailable).toBe(true);

    // No wrapped key left: a previous lockout consumed it. The PIN pad
    // could never succeed again, and the popup routes on this flag.
    const wiped = await makeController({ pinWrapped: null });
    expect(wiped.controller.status().pinUnlockAvailable).toBe(false);

    // The restart policy blocks the PIN for this whole browser run even
    // though the wrapped key is still there.
    const afterRestart = await makeController({ requireMasterPasswordOnRestart: true });
    expect(afterRestart.controller.status().pinUnlockAvailable).toBe(false);
  }, 30000);

  it("counts the PIN attempts that are actually left", async () => {
    // Session charges the attempt BEFORE trying it and gives up once
    // failedPinAttempts exceeds MAX_PIN_ATTEMPTS, so a stored count of n
    // leaves MAX - n tries. An off-by-one here shows the user a warning one
    // attempt too early or, worse, one too late.
    const fresh = await makeController();
    expect(fresh.controller.status().pinAttemptsRemaining).toBe(MAX_PIN_ATTEMPTS);

    const used = await makeController({ failedPinAttempts: 4 });
    expect(used.controller.status().pinAttemptsRemaining).toBe(MAX_PIN_ATTEMPTS - 4);

    const last = await makeController({ failedPinAttempts: MAX_PIN_ATTEMPTS - 1 });
    expect(last.controller.status().pinAttemptsRemaining).toBe(1);
    await expect(last.controller.unlock(PIN)).resolves.toBeUndefined();

    // Never negative: a corrupt or over-counted record must not render as
    // "-2 attempts remaining".
    const over = await makeController({ failedPinAttempts: MAX_PIN_ATTEMPTS + 3 });
    expect(over.controller.status().pinAttemptsRemaining).toBe(0);
  }, 40000);

  it("reports an empty device without inventing an account", async () => {
    const { controller } = await makeController();
    await controller.signOut();
    const s = controller.status();
    expect(s.serverUrl).toBeNull();
    expect(s.pinUnlockAvailable).toBe(false);
    expect(s.pinAttemptsRemaining).toBe(MAX_PIN_ATTEMPTS);
  }, 20000);

  it("returns only page matches for a tab url", async () => {
    const { controller } = await makeController();
    await controller.unlock(PIN);
    expect(await controller.matchesFor("https://gist.github.com/x")).toHaveLength(1);
    expect(await controller.matchesFor("https://unrelated.test/")).toHaveLength(0);
  }, 20000);

  it("generates a TOTP code for an entry that has one, and refuses for one that does not", async () => {
    const { controller } = await makeController({
      cipherCache: await cacheOf([
        { id: "c1", name: "GitHub", uris: ["https://github.com"] },
        { id: "c2", name: "WithTotp", totp: "JBSWY3DPEHPK3PXP", uris: ["https://totp.test"] },
      ]),
    });
    await controller.unlock(PIN);

    const { code, secondsRemaining } = await controller.totpFor("c2");
    expect(code).toMatch(/^\d{6}$/);
    expect(secondsRemaining).toBeGreaterThan(0);
    expect(secondsRemaining).toBeLessThanOrEqual(30);

    await expect(controller.totpFor("c1")).rejects.toThrow(/no TOTP/i);
  }, 20000);

  it("refuses to fill on a plain http origin", async () => {
    const { controller } = await makeController();
    await controller.unlock(PIN);
    const { executeScript, sendMessage } = stubTabs("http://example.com/login");
    await expect(controller.fill(1, "c1")).rejects.toThrow(/https/i);
    expect(executeScript).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  }, 20000);

  it("refuses to fill on a non-http(s) tab url instead of throwing a parse error", async () => {
    // about:blank, moz-extension:// and a tab URL that is not a URL at all
    // must all be ordinary refusals. `new URL()` throws on the last one, so
    // without the guarded parse this escapes fill() as a raw TypeError.
    const { controller } = await makeController();
    await controller.unlock(PIN);

    for (const url of ["about:blank", "moz-extension://abcd/popup.html", "::::", ""]) {
      const { executeScript } = stubTabs(url);
      await expect(controller.fill(1, "c1")).rejects.toThrow(/https/i);
      expect(executeScript).not.toHaveBeenCalled();
    }
  }, 20000);

  it("refuses to fill when the tab has no readable url", async () => {
    const { controller } = await makeController();
    await controller.unlock(PIN);
    const { executeScript } = stubTabs(undefined);
    await expect(controller.fill(1, "c1")).rejects.toThrow(/page URL/i);
    expect(executeScript).not.toHaveBeenCalled();
  }, 20000);

  it("treats http loopback as a fillable origin", async () => {
    // Positive proof, not just "it got past the https gate": the entry is
    // for localhost, so the fill must actually complete. IPv6 loopback is
    // covered by the next case.
    const { controller } = await makeController({
      cipherCache: await cacheOf([
        { id: "local", name: "Dev", password: "devpw", uris: ["http://localhost:8080"] },
      ]),
    });
    await controller.unlock(PIN);
    const { executeScript, sendMessage } = stubTabs("http://localhost:8080/login");

    await controller.fill(1, "local");
    expect(executeScript).toHaveBeenCalledWith(1, { file: "autofill.js" });
    expect(sendMessage).toHaveBeenCalledWith(1, {
      kind: "fill",
      username: "octocat",
      password: "devpw",
    });
  }, 20000);

  it("treats http IPv6 loopback as a fillable origin", async () => {
    // The seeded entry is for github.com, so getting past the https gate and
    // being stopped by the URI check is what proves [::1] itself is allowed.
    const { controller } = await makeController();
    await controller.unlock(PIN);
    stubTabs("http://[::1]:8080/login");
    await expect(controller.fill(1, "c1")).rejects.toThrow(/does not match/i);
  }, 20000);

  it("does not treat an attacker hostname ending in a loopback name as loopback", async () => {
    const { controller } = await makeController();
    await controller.unlock(PIN);
    for (const url of ["http://evil.localhost/login", "http://127.0.0.1.evil.test/login"]) {
      const { executeScript } = stubTabs(url);
      await expect(controller.fill(1, "c1")).rejects.toThrow(/https/i);
      expect(executeScript).not.toHaveBeenCalled();
    }
  }, 20000);

  it("refuses to fill an entry that does not match the tab's current page", async () => {
    // The tab navigated after the popup listed its matches. Filling here would
    // hand a github password to an unrelated site.
    const { controller } = await makeController();
    await controller.unlock(PIN);
    const { executeScript, sendMessage } = stubTabs("https://evil.example/login");

    await expect(controller.fill(7, "c1")).rejects.toThrow(/does not match/i);
    expect(executeScript).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  }, 20000);

  it("refuses to fill an entry that has no password, without injecting anything", async () => {
    // `undecryptable === false` does not imply fillable. A login cipher with
    // URIs and a null password is returned by matchItems, and injecting for
    // it would grant the page the activeTab content script and then report
    // success for a fill that left the password box empty.
    const { controller } = await makeController({
      cipherCache: await cacheOf([
        { id: "nopw", name: "No password", password: null, uris: ["https://github.com"] },
      ]),
    });
    await controller.unlock(PIN);
    const { executeScript, sendMessage } = stubTabs("https://github.com/login");

    await expect(controller.fill(7, "nopw")).rejects.toThrow(/no password/i);
    expect(executeScript).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  }, 20000);

  it("still fills an entry that has a password but no username", async () => {
    // Username-less entries are legitimate; the content script skips the
    // field. This must not be caught by the no-password refusal above.
    const { controller } = await makeController({
      cipherCache: await cacheOf([
        { id: "nouser", name: "No user", username: null, uris: ["https://github.com"] },
      ]),
    });
    await controller.unlock(PIN);
    const { sendMessage } = stubTabs("https://github.com/login");

    await controller.fill(7, "nouser");
    expect(sendMessage).toHaveBeenCalledWith(7, {
      kind: "fill",
      username: null,
      password: "hunter2",
    });
  }, 20000);

  it("rejects an unknown item id", async () => {
    const { controller } = await makeController();
    await controller.unlock(PIN);
    const { get } = stubTabs("https://github.com/login");
    await expect(controller.fill(7, "does-not-exist")).rejects.toThrow(/not found/i);
    expect(get).not.toHaveBeenCalled();
  }, 20000);

  it("reads the destination from the tab, not from the caller", async () => {
    // A caller cannot talk the background into filling somewhere else by
    // claiming a different URL: fill() takes no URL argument at all.
    const { controller } = await makeController();
    await controller.unlock(PIN);
    const { get, executeScript, sendMessage } = stubTabs("https://github.com/login");

    await controller.fill(7, "c1");

    expect(get).toHaveBeenCalledWith(7);
    expect(executeScript).toHaveBeenCalledWith(7, { file: "autofill.js" });
    expect(sendMessage).toHaveBeenCalledWith(7, {
      kind: "fill",
      username: "octocat",
      password: "hunter2",
    });
  }, 20000);

  it("locks and forgets the key", async () => {
    const { controller } = await makeController();
    await controller.unlock(PIN);
    controller.lock();
    expect(controller.status().state).toBe("locked");
    await expect(controller.list("")).rejects.toThrow(/locked/i);
  }, 20000);

  describe("offline cache handling", () => {
    it("unlocks with an empty vault when there is no cache yet", async () => {
      const { controller } = await makeController({ cipherCache: null });
      await controller.unlock(PIN);
      expect(controller.status().state).toBe("unlocked");
      expect(await controller.list("")).toEqual([]);
    }, 20000);

    it("unlocks with an empty vault when the cache is not parseable JSON", async () => {
      // Half-failing here is the bug: the session is already unlocked by the
      // time the cache is read, so throwing would leave live keys in memory
      // behind a rejected unlock().
      const { controller } = await makeController({ cipherCache: "{{{not json" });
      await controller.unlock(PIN);
      expect(controller.status().state).toBe("unlocked");
      expect(await controller.list("")).toEqual([]);
    }, 20000);

    it("unlocks with an empty vault when the cache is valid JSON of the wrong shape", async () => {
      for (const bad of [
        JSON.stringify({ nope: 1 }),
        JSON.stringify({ profile: { organizations: null }, folders: [], ciphers: "not-an-array" }),
        JSON.stringify({ profile: { organizations: null }, folders: [], ciphers: [{}] }),
        JSON.stringify({
          profile: { organizations: null },
          folders: [],
          ciphers: [
            {
              id: "x",
              organizationId: null,
              folderId: null,
              type: 1,
              name: "n",
              favorite: false,
              key: null,
              login: { username: null, password: null, totp: null, uris: [{ uri: 5 }] },
            },
          ],
        }),
        JSON.stringify(null),
        JSON.stringify([]),
        JSON.stringify("a string"),
      ]) {
        const { controller } = await makeController({ cipherCache: bad });
        await controller.unlock(PIN);
        expect(controller.status().state).toBe("unlocked");
        expect(await controller.list("")).toEqual([]);
      }
    }, 30000);

    it("skips non-login ciphers rather than rejecting the whole cache", async () => {
      const { controller } = await makeController({
        cipherCache: await cacheOf([
          { id: "note", name: "Secure note", type: 2 },
          { id: "c1", name: "GitHub", uris: ["https://github.com"] },
        ]),
      });
      await controller.unlock(PIN);
      const items = await controller.list("");
      expect(items.map((i) => i.id)).toEqual(["c1"]);
    }, 20000);
  });

  describe("syncNow", () => {
    /** Serves the token endpoint and one canned /api/sync response. */
    function stubServer(syncStatus: number, syncBody: unknown) {
      return vi.fn().mockImplementation(async (url: string) => ({
        ok: url.includes("/api/sync") ? syncStatus >= 200 && syncStatus < 300 : true,
        status: url.includes("/api/sync") ? syncStatus : 200,
        json: async () =>
          url.includes("/api/sync")
            ? syncBody
            : { access_token: "at", refresh_token: "rt2", expires_in: 3600 },
        text: async () => "",
      }));
    }

    async function unlockedWithRefreshToken(): Promise<Harness> {
      const h = await makeController({
        wrappedRefreshToken: await encryptToString(utf8("rt"), userKey),
      });
      await h.controller.unlock(PIN);
      return h;
    }

    it("replaces the cache with a freshly synced vault", async () => {
      const h = await unlockedWithRefreshToken();
      vi.stubGlobal("fetch", stubServer(200, JSON.parse(await cacheOf([
        { id: "c2", name: "Fastmail", uris: ["https://fastmail.com"] },
      ]))));

      await h.controller.syncNow();
      expect((await h.controller.list("")).map((i) => i.id)).toEqual(["c2"]);
    }, 20000);

    it("rejects a 200 whose body is not a vault, and keeps the previous cache", async () => {
      // sync() validates with isSyncResponse now, so a server that answers
      // 200 with something else is a loud InvalidResponseError instead of a
      // silently empty vault. The cache must survive it: an unusable
      // response is not a reason to lose the offline copy.
      const h = await unlockedWithRefreshToken();
      const before = h.stored()?.cipherCache;
      vi.stubGlobal("fetch", stubServer(200, { object: "sync", ciphers: "nope" }));

      await expect(h.controller.syncNow()).rejects.toBeInstanceOf(InvalidResponseError);
      expect(h.stored()?.cipherCache).toBe(before);
      expect((await h.controller.list("")).map((i) => i.id)).toEqual(["c1"]);
    }, 20000);
  });

  describe("locking clears the decrypted vault", () => {
    // These assertions read `controller["items"]` directly. That is the
    // point of the bug: the decrypted vault — cleartext passwords and TOTP
    // secrets for every entry — deliberately never crosses a public
    // boundary (see `summarize`), so there is no public way to observe that
    // it is still resident. `status()` and `list()` both go by the session
    // state and stay green whether or not the plaintext was dropped.

    it("drops every decrypted password when the idle timer locks the session", async () => {
      // Session.lock() zeroes the key buffers and knows nothing about the
      // Controller, so before this fix the 15-minute idle timeout wiped the
      // keys and left the whole vault in cleartext in the background page's
      // heap for as long as Firefox kept it alive.
      vi.useFakeTimers();
      try {
        const { controller, session } = await makeController();
        await controller.unlock(PIN);
        expect((await controller.list("")).map((i) => i.name)).toEqual(["GitHub"]);

        // list() above touched the session, so the full timeout starts now.
        vi.advanceTimersByTime(15 * 60 * 1000 + 1000);

        expect(session.state).toBe("locked");
        expect(controller["items"]).toEqual([]);
        expect(JSON.stringify(controller["items"])).not.toContain("hunter2");
      } finally {
        vi.useRealTimers();
      }
    }, 20000);

    it("drops them on an explicit lock and on signOut", async () => {
      const first = await makeController();
      await first.controller.unlock(PIN);
      first.controller.lock();
      expect(first.controller["items"]).toEqual([]);

      const second = await makeController();
      await second.controller.unlock(PIN);
      await second.controller.signOut();
      expect(second.controller["items"]).toEqual([]);
    }, 30000);
  });

  describe("organization keys", () => {
    it("rebuilds them from the cache, so org items survive a lock/unlock cycle", async () => {
      // lock() zeroes and clears orgKeys, and unlockWithPin restores only
      // the user key. Without a rebuild here every organization cipher
      // decrypts to the "cannot be decrypted" placeholder until the user
      // signs in with the master password again.
      const org = await makeOrg("org-1");
      const { controller } = await makeController({
        protectedPrivateKey: (await rsa()).protectedPrivateKey,
        cipherCache: await cacheOf(
          [
            { id: "c1", name: "GitHub", uris: ["https://github.com"] },
            { id: "o1", name: "Shared VPN", password: "orgpw", orgId: "org-1" },
          ],
          [org],
        ),
      });

      await controller.unlock(PIN);
      const afterFirst = (await controller.list("")).find((i) => i.id === "o1");
      expect(afterFirst).toMatchObject({ name: "Shared VPN", undecryptable: false });

      controller.lock();
      await controller.unlock(PIN);

      const afterSecond = (await controller.list("")).find((i) => i.id === "o1");
      expect(afterSecond).toMatchObject({ name: "Shared VPN", undecryptable: false });
    }, 40000);

    it("picks up an organization the user was added to by a later sync", async () => {
      // The rebuild has to be unconditional. Skipping it because orgKeys is
      // already populated would mean a newly-joined organization's items
      // stay undecryptable until the next full sign-in.
      const org1 = await makeOrg("org-1");
      const org2 = await makeOrg("org-2");
      const { controller } = await makeController({
        protectedPrivateKey: (await rsa()).protectedPrivateKey,
        wrappedRefreshToken: await encryptToString(utf8("rt"), userKey),
        cipherCache: await cacheOf([{ id: "o1", name: "First", orgId: "org-1" }], [org1]),
      });
      await controller.unlock(PIN);
      expect((await controller.list("")).map((i) => i.undecryptable)).toEqual([false]);

      const grown = JSON.parse(
        await cacheOf(
          [
            { id: "o1", name: "First", orgId: "org-1" },
            { id: "o2", name: "Second", orgId: "org-2" },
          ],
          [org1, org2],
        ),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => ({
          ok: true,
          status: 200,
          json: async () =>
            url.includes("/api/sync")
              ? grown
              : { access_token: "at", refresh_token: "rt2", expires_in: 3600 },
          text: async () => "",
        })),
      );

      await controller.syncNow();

      const items = await controller.list("");
      expect(items.map((i) => i.name).sort()).toEqual(["First", "Second"]);
      expect(items.every((i) => !i.undecryptable)).toBe(true);
    }, 40000);

    it("zeroes the organization keys it replaces", async () => {
      // A rebuild that just reassigns the map orphans the previous
      // Uint8Arrays with live organization key bytes still in them.
      const org = await makeOrg("org-1");
      const { controller, session } = await makeController({
        protectedPrivateKey: (await rsa()).protectedPrivateKey,
        cipherCache: await cacheOf([{ id: "o1", name: "Shared VPN", orgId: "org-1" }], [org]),
      });

      await controller.unlock(PIN);
      const first = session.orgKeys.get("org-1");
      expect(first).toBeDefined();

      // A second unlock leaves the session unlocked throughout, so this is
      // the rebuild replacing a live map rather than lock() clearing it.
      await controller.unlock(PIN);

      expect(session.orgKeys.get("org-1")).not.toBe(first);
      expect(allZero(first!.encKey)).toBe(true);
      expect(allZero(first!.macKey)).toBe(true);
      expect((await controller.list("")).map((i) => i.undecryptable)).toEqual([false]);
    }, 40000);

    it("leaves org items undecryptable, rather than failing the unlock, when the private key is unusable", async () => {
      // loadFromCache must never throw: the session is already unlocked by
      // the time it runs, so a rejection here would leave live keys behind
      // a rejected unlock().
      const org = await makeOrg("org-1");
      const { controller } = await makeController({
        protectedPrivateKey: await encryptToString(utf8("not a pkcs8 key"), userKey),
        cipherCache: await cacheOf(
          [
            { id: "c1", name: "GitHub", uris: ["https://github.com"] },
            { id: "o1", name: "Shared VPN", orgId: "org-1" },
          ],
          [org],
        ),
      });

      await expect(controller.unlock(PIN)).resolves.toBeUndefined();
      expect(controller.status().state).toBe("unlocked");
      const items = await controller.list("");
      expect(items.find((i) => i.id === "c1")!.undecryptable).toBe(false);
      expect(items.find((i) => i.id === "o1")!.undecryptable).toBe(true);
    }, 20000);
  });

  describe("signOut", () => {
    it("wipes the persisted state, not just the in-memory keys", async () => {
      // lock() zeroes the keys in memory, but protectedUserKey, pinWrapped,
      // wrappedRefreshToken and the cipherCache all survive it in
      // browser.storage.local. Without signOut there is no way to get them
      // off the device short of uninstalling the extension.
      const { controller, stored } = await makeController();
      await controller.unlock(PIN);
      expect(stored()).not.toBeNull();

      await controller.signOut();

      expect(stored()).toBeNull();
      expect(controller.status().state).toBe("empty");
      expect(controller.status().email).toBeNull();
      expect(controller.status().lastSyncMs).toBeNull();
      await expect(controller.list("")).rejects.toThrow(/locked/i);
    }, 20000);

    it("works from a locked session too", async () => {
      const { controller, stored } = await makeController();
      await controller.signOut();
      expect(stored()).toBeNull();
      expect(controller.status().state).toBe("empty");
    }, 20000);
  });
});
