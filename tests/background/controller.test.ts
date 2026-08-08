import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Controller } from "../../src/background/controller";
import { wrapKeyWithPin } from "../../src/session/pin";
import { Session } from "../../src/session/session";
import type { StoredState } from "../../src/session/store";
import type { SymKey } from "../../src/crypto/encstring";
import { encryptToString } from "../../src/crypto/encstring";
import { utf8 } from "../../src/crypto/bytes";

const PIN = "135790";
const userKey: SymKey = {
  encKey: new Uint8Array(32).fill(1),
  macKey: new Uint8Array(32).fill(2),
};

// Argon2id at the real PIN-wrapping parameters costs several hundred ms, and
// every test in this file needs the same wrapped key. Wrap once.
let pinWrappedOnce: Awaited<ReturnType<typeof wrapKeyWithPin>> | null = null;
async function pinWrapped(): Promise<Awaited<ReturnType<typeof wrapKeyWithPin>>> {
  pinWrappedOnce ??= await wrapKeyWithPin(userKey, PIN);
  return { ...pinWrappedOnce };
}

async function enc(text: string): Promise<string> {
  return encryptToString(utf8(text), userKey);
}

async function encOrNull(text: string | null): Promise<string | null> {
  return text === null ? null : enc(text);
}

type Seed = {
  id: string;
  name: string;
  username?: string | null;
  password?: string | null;
  totp?: string | null;
  uris?: string[];
  type?: number;
};

async function cacheOf(seeds: Seed[]): Promise<string> {
  const ciphers = [];
  for (const s of seeds) {
    const uris = [];
    for (const u of s.uris ?? []) {
      uris.push({ uri: await enc(u), match: null });
    }
    ciphers.push({
      id: s.id,
      organizationId: null,
      folderId: null,
      type: s.type ?? 1,
      name: await enc(s.name),
      favorite: false,
      key: null,
      login: {
        username: await encOrNull(s.username === undefined ? "octocat" : s.username),
        password: await encOrNull(s.password === undefined ? "hunter2" : s.password),
        totp: await encOrNull(s.totp ?? null),
        uris,
      },
    });
  }
  return JSON.stringify({ profile: { organizations: null }, folders: [], ciphers });
}

const DEFAULT_SEEDS: Seed[] = [
  { id: "c1", name: "GitHub", uris: ["https://github.com"] },
];

type Harness = {
  controller: Controller;
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

  const controller = new Controller(
    new Session({
      load: async () => saved,
      save: async (s) => {
        saved = s;
      },
      clear: async () => {
        saved = null;
      },
    }),
  );
  await controller.init();
  return { controller, stored: () => saved };
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
