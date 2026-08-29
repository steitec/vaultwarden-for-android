import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Controller } from "../../src/background/controller";
import { Session } from "../../src/session/session";
import type { StoredState } from "../../src/session/store";

// The module under test registers a browser.runtime.onMessage listener and
// starts a Controller at import time. `browser` does not exist under the
// node test environment, and static `import` declarations are hoisted ahead
// of every other statement, so the module must be loaded via a dynamic
// `import()` after the stub is in place (same shape as the autofill content
// script's test).
//
// The stub captures the registered listener and fixes `runtime.id` so the
// sender-verification tests can invoke the real listener directly with a
// matching or a foreign `sender.id`.
const THIS_EXTENSION_ID = "vaultwarden-android@steitec.net";
let registeredListener:
  | ((msg: unknown, sender: { id?: string }) => unknown)
  | undefined;
let registeredConnectListener: ((port: unknown) => void) | undefined;

const BROWSER_STUB = {
  runtime: {
    id: THIS_EXTENSION_ID,
    onMessage: {
      addListener: (fn: (msg: unknown, sender: { id?: string }) => unknown) => {
        registeredListener = fn;
      },
    },
    // The entry subscribes at load time so a lock can reach an open popup
    // (F-5). Firefox provides this to every background script.
    onConnect: {
      addListener: (fn: (port: unknown) => void) => {
        registeredConnectListener = fn;
      },
    },
  },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  // `matches` and `handOff` resolve the tab themselves rather than trusting
  // the caller, and fall back to the active tab when the sender has none
  // (the popup). Overridden per test where the answer matters.
  tabs: { query: async (): Promise<Array<{ id?: number; url?: string }>> => [] },
  // handOff opens the popup when the platform allows it. Replaced per test.
  browserAction: undefined as { openPopup: () => Promise<void> } | undefined,
};
vi.stubGlobal("browser", BROWSER_STUB);

const { handleMessage } = await import("../../src/background/index");

const SELF = { id: THIS_EXTENSION_ID };
const FOREIGN = { id: "some-other-extensions-id" };

/**
 * The startup promise every dispatch waits on. These tests construct their
 * own controller and await `init()` themselves, so the work it stands for is
 * already done; the "background page startup" block at the bottom of this
 * file is where the waiting itself is pinned.
 */
const READY: Promise<void> = Promise.resolve();

const BASE_STATE: StoredState = {
  serverUrl: "https://v.example.net",
  email: "a@b.com",
  deviceId: "dev",
  kdf: { kdf: 0, iterations: 600000, memory: null, parallelism: null, salt: null },
  protectedUserKey: "2.a|b|c",
  protectedPrivateKey: "2.d|e|f",
  // No PIN wrapping: these tests never unlock, and wrapping costs Argon2id.
  pinWrapped: null,
  failedPinAttempts: 0,
  wrappedRefreshToken: null,
  cipherCache: null,
  lastSyncMs: 1000,
  lockTimeoutMinutes: 15,
  requireMasterPasswordOnRestart: false,
  unlockMode: "pin",
};

/** Every controller method the dispatcher can reach, stubbed and observable. */
function makeSpies(c: Controller) {
  return {
    status: vi
      .spyOn(c, "status")
      .mockReturnValue({
        state: "locked",
        lastSyncMs: 1000,
        email: "a@b.com",
        serverUrl: "https://v.example.net",
        pinUnlockAvailable: true,
        pinAttemptsRemaining: 5,
      }),
    unlock: vi.spyOn(c, "unlock").mockResolvedValue(undefined),
    lock: vi.spyOn(c, "lock").mockReturnValue(undefined),
    signOut: vi.spyOn(c, "signOut").mockResolvedValue(undefined),
    list: vi.spyOn(c, "list").mockResolvedValue([]),
  matchesFor: vi
      .spyOn(c, "matchesFor")
      .mockResolvedValue({ state: "unlocked", items: [] }),
    fill: vi.spyOn(c, "fill").mockResolvedValue(undefined),
    totpFor: vi.spyOn(c, "totpFor").mockResolvedValue({ code: "123456", secondsRemaining: 30 }),
    setup: vi.spyOn(c, "setup").mockResolvedValue({ ok: true }),
    syncNow: vi.spyOn(c, "syncNow").mockResolvedValue(undefined),
  };
}

let controller: Controller;
let spies: ReturnType<typeof makeSpies>;

beforeEach(async () => {
  let saved: StoredState | null = { ...BASE_STATE, kdf: { ...BASE_STATE.kdf } };
  controller = new Controller(
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
  spies = makeSpies(controller);
});

function expectNothingDispatched(): void {
  for (const [name, spy] of Object.entries(spies)) {
    expect(spy, `controller.${name} must not have been called`).not.toHaveBeenCalled();
  }
}

// Every request kind, with a payload that is valid for that kind. Used to
// prove the sender check covers the whole API surface rather than one case.
const EVERY_KIND: unknown[] = [
  { kind: "status" },
  { kind: "unlock", pin: "135790" },
  { kind: "lock" },
  { kind: "signOut" },
  { kind: "list", query: "" },
  { kind: "matches" },
  { kind: "fill", tabId: 7, itemId: "c1" },
  { kind: "totp", itemId: "c1" },
  { kind: "setup", serverUrl: "https://v.test", email: "a@b.com", password: "p", pin: "135790" },
  { kind: "sync" },
];

describe("handleMessage sender verification", () => {
  it("ignores every request kind when the sender is a different installed extension", async () => {
    // browser.runtime.onMessage is reachable by any other installed
    // extension that knows this extension's ID. Without this check,
    // {kind:"unlock"} is a native-speed offline PIN brute-force oracle,
    // {kind:"list"} enumerates the vault, and {kind:"fill"} exfiltrates a
    // password into a tab of the attacker's choosing.
    for (const msg of EVERY_KIND) {
      expect(handleMessage(controller, msg, FOREIGN, READY)).toBeUndefined();
    }
    expectNothingDispatched();
  });

  it("ignores a request whose sender has no id at all (a content script or page)", async () => {
    expect(handleMessage(controller, { kind: "list", query: "" }, {}, READY)).toBeUndefined();
    expectNothingDispatched();
  });

  it("acts on a request whose sender is this extension itself", async () => {
    const result = handleMessage(controller, { kind: "status" }, SELF, READY);
    await expect(result).resolves.toEqual({
      state: "locked",
      lastSyncMs: 1000,
      email: "a@b.com",
      serverUrl: "https://v.example.net",
      pinUnlockAvailable: true,
      pinAttemptsRemaining: 5,
    });
    expect(spies.status).toHaveBeenCalled();
  });

  it("is enforced by the listener that is actually registered, not only by the export", async () => {
    expect(registeredListener).toBeDefined();
    expect(registeredListener!({ kind: "status" }, FOREIGN)).toBeUndefined();
    // The registered listener runs against the module's own controller, so
    // a well-formed request from this extension must produce an answer.
    await expect(registeredListener!({ kind: "status" }, SELF)).resolves.toMatchObject({
      state: expect.any(String),
    });
  });
});

describe("handleMessage request validation", () => {
  const MALFORMED: [string, unknown][] = [
    ["null", null],
    ["a string", "unlock"],
    ["a number", 7],
    ["an array", [{ kind: "list", query: "" }]],
    ["no kind", { pin: "135790" }],
    ["a non-string kind", { kind: 7 }],
    ["an unknown kind", { kind: "eval", code: "1" }],
    ["unlock with no pin", { kind: "unlock" }],
    ["unlock with a non-string pin", { kind: "unlock", pin: 135790 }],
    ["unlock with a null pin", { kind: "unlock", pin: null }],
    ["list with no query", { kind: "list" }],
    ["list with a non-string query", { kind: "list", query: { toLowerCase: null } }],
    ["fillFromPage with no itemId", { kind: "fillFromPage" }],
    ["fillFromPage with a non-string itemId", { kind: "fillFromPage", itemId: 7 }],
    ["fill with no tabId", { kind: "fill", itemId: "c1" }],
    ["fill with a string tabId", { kind: "fill", tabId: "7", itemId: "c1" }],
    ["fill with a NaN tabId", { kind: "fill", tabId: Number.NaN, itemId: "c1" }],
    ["fill with no itemId", { kind: "fill", tabId: 7 }],
    ["totp with no itemId", { kind: "totp" }],
    // Declared in the brief's union but deliberately not part of the API
    // yet: `copy` arrives in Task 15 with its handler. Until then it must
    // be rejected outright, not dispatched into a runtime default.
    ["a copy request", { kind: "copy", itemId: "c1", field: "password" }],
    // setup carries the master password and the server URL that host
    // permission is requested for, so every field is validated here rather
    // than letting a non-string reach `new URL()` or the KDF.
    ["setup with no serverUrl", { kind: "setup", email: "a@b.com", password: "p", pin: "135790" }],
    [
      "setup with a non-string serverUrl",
      { kind: "setup", serverUrl: 1, email: "a@b.com", password: "p", pin: "135790" },
    ],
    [
      "setup with no email",
      { kind: "setup", serverUrl: "https://v.test", password: "p", pin: "135790" },
    ],
    [
      "setup with no password",
      { kind: "setup", serverUrl: "https://v.test", email: "a@b.com", pin: "135790" },
    ],
    [
      "setup with a null password",
      { kind: "setup", serverUrl: "https://v.test", email: "a@b.com", password: null, pin: "135790" },
    ],
    [
      "setup with no pin",
      { kind: "setup", serverUrl: "https://v.test", email: "a@b.com", password: "p" },
    ],
    [
      "setup with a non-string pin",
      { kind: "setup", serverUrl: "https://v.test", email: "a@b.com", password: "p", pin: 135790 },
    ],
    [
      "setup with a non-object twoFactor",
      {
        kind: "setup",
        serverUrl: "https://v.test",
        email: "a@b.com",
        password: "p",
        pin: "135790",
        twoFactor: "654321",
      },
    ],
    [
      "setup with a twoFactor missing its provider",
      {
        kind: "setup",
        serverUrl: "https://v.test",
        email: "a@b.com",
        password: "p",
        pin: "135790",
        twoFactor: { token: "654321" },
      },
    ],
    [
      "setup with a NaN twoFactor provider",
      {
        kind: "setup",
        serverUrl: "https://v.test",
        email: "a@b.com",
        password: "p",
        pin: "135790",
        twoFactor: { token: "654321", provider: Number.NaN },
      },
    ],
  ];

  for (const [label, msg] of MALFORMED) {
    it(`ignores ${label}`, () => {
      expect(handleMessage(controller, msg, SELF, READY)).toBeUndefined();
      expectNothingDispatched();
    });
  }

  it("does not reject — it returns undefined, so a malformed message yields no error to the sender", () => {
    // Returning a rejected promise would confirm to a probing extension
    // both that this extension exists and which shapes it understands.
    expect(() => handleMessage(controller, { kind: "unlock" }, SELF, READY)).not.toThrow();
  });
});

describe("handleMessage routing", () => {
  it("routes each request kind to the matching controller call", async () => {
    await handleMessage(controller, { kind: "status" }, SELF, READY);
    expect(spies.status).toHaveBeenCalledTimes(1);

    await handleMessage(controller, { kind: "unlock", pin: "135790" }, SELF, READY);
    expect(spies.unlock).toHaveBeenCalledWith("135790");

    await handleMessage(controller, { kind: "lock" }, SELF, READY);
    expect(spies.lock).toHaveBeenCalledTimes(1);

    await handleMessage(controller, { kind: "signOut" }, SELF, READY);
    expect(spies.signOut).toHaveBeenCalledTimes(1);

    await handleMessage(controller, { kind: "list", query: "git" }, SELF, READY);
    expect(spies.list).toHaveBeenCalledWith("git");

    BROWSER_STUB.tabs.query = async () => [{ id: 3, url: "https://github.com/" }];
    await handleMessage(controller, { kind: "matches" }, SELF, READY);
    expect(spies.matchesFor).toHaveBeenCalledWith("https://github.com/");

    await handleMessage(controller, { kind: "fill", tabId: 7, itemId: "c1" }, SELF, READY);
    expect(spies.fill).toHaveBeenCalledWith(7, "c1");

    await handleMessage(controller, { kind: "totp", itemId: "c1" }, SELF, READY);
    expect(spies.totpFor).toHaveBeenCalledWith("c1");

    await handleMessage(controller, { kind: "sync" }, SELF, READY);
    expect(spies.syncNow).toHaveBeenCalledTimes(1);
    // syncNow takes no arguments: the retry bookkeeping is internal and is
    // not something a message sender gets to set.
    expect(spies.syncNow).toHaveBeenCalledWith();

    await handleMessage(
      controller,
      {
        kind: "setup",
        serverUrl: "https://v.test",
        email: "a@b.com",
        password: "p",
        pin: "135790",
        twoFactor: { token: "654321", provider: 0 },
      },
      SELF,
      READY,
    );
    // The envelope is not forwarded — only the named fields.
    expect(spies.setup).toHaveBeenCalledWith({
      serverUrl: "https://v.test",
      email: "a@b.com",
      password: "p",
      pin: "135790",
      twoFactor: { token: "654321", provider: 0 },
    });
  });

  it("answers every kind with a promise, so the sender always gets a settled reply", async () => {
    for (const msg of EVERY_KIND) {
      const result = handleMessage(controller, msg, SELF, READY);
      expect(result).toBeInstanceOf(Promise);
      await result;
    }
  });
});

describe("background page startup", () => {
  /**
   * Loads a fresh copy of the background module against a storage stub we
   * control, and hands back the listener it registered.
   *
   * The module reads the stored account asynchronously at import time, so
   * the only way to observe the window before that read finishes is to
   * control when `storage.local.get` settles — hence `vi.resetModules()`
   * and a second import rather than reusing the module-level instance.
   */
  async function startBackground(
    get: () => Promise<Record<string, unknown>>,
  ): Promise<(msg: unknown, sender: { id?: string }) => unknown> {
    let listener: ((msg: unknown, sender: { id?: string }) => unknown) | undefined;
    vi.stubGlobal("browser", {
      runtime: {
        id: THIS_EXTENSION_ID,
        onMessage: {
          addListener: (fn: (msg: unknown, sender: { id?: string }) => unknown) => {
            listener = fn;
          },
        },
        onConnect: { addListener: () => {} },
      },
      storage: { local: { get, set: async () => {}, remove: async () => {} } },
    });
    vi.resetModules();
    await import("../../src/background/index");
    if (listener === undefined) throw new Error("the background module registered no listener");
    return listener;
  }

  afterEach(() => {
    vi.stubGlobal("browser", BROWSER_STUB);
  });

  it("answers status only once the stored account has been loaded", async () => {
    // Tapping the toolbar icon immediately after Firefox starts lands in
    // exactly this window. Answering early reports state "empty" for an
    // account that exists, and the popup shows "Sign in to your vault".
    let release!: (value: Record<string, unknown>) => void;
    const stored = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    const listener = await startBackground(() => stored);

    const answer = Promise.resolve(listener({ kind: "status" }, SELF));
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    // A handful of microtask turns: more than enough for a dispatcher that
    // answered from the unloaded session to have resolved already.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(settled).toBe(false);

    release({ state: BASE_STATE });

    await expect(answer).resolves.toMatchObject({
      state: "locked",
      email: "a@b.com",
      serverUrl: "https://v.example.net",
    });
  });

  it("surfaces a failed load to the sender instead of swallowing it", async () => {
    // `void controller.init()` dropped the rejection on the floor: the
    // popup then saw an empty device forever with no indication that
    // anything had gone wrong.
    const listener = await startBackground(async () => {
      throw new Error("QuotaExceededError: storage is unreadable at /data/xyz");
    });

    const answer = Promise.resolve(listener({ kind: "status" }, SELF));
    const failure: unknown = await answer.then(
      () => null,
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    // User-facing, and carrying nothing from the underlying failure: the
    // popup renders `.message` verbatim (see popup/errors.ts).
    expect(message).toMatch(/saved data/i);
    expect(message).not.toContain("QuotaExceeded");
    expect(message).not.toContain("/data/xyz");
  });

  it("still declines a foreign sender without waiting for the load", async () => {
    // The sender and payload checks stay synchronous. Returning a promise
    // here — even one that later resolves to nothing — would confirm to the
    // sender that this extension is installed and listening.
    const listener = await startBackground(() => new Promise<Record<string, unknown>>(() => {}));
    expect(listener({ kind: "status" }, FOREIGN)).toBeUndefined();
    expect(listener({ kind: "nope" }, SELF)).toBeUndefined();
  });
});

describe("the background page resolves the tab itself", () => {
  const CONTENT_SCRIPT: browser.runtime.MessageSender = {
    id: THIS_EXTENSION_ID,
    tab: { id: 7, url: "https://real.example/login" } as browser.tabs.Tab,
  };

  it("reads the page URL from the sender's tab, not from the message", async () => {
    // The payload carries a URL the caller would prefer we used. It must be
    // ignored: a content script runs on pages we do not control and does not
    // get to name the origin its matches are computed against. The extra key
    // is simply not part of the request shape any more, so this also pins
    // that a stray one cannot sneak back in as a source of truth.
    BROWSER_STUB.tabs.query = async () => [{ id: 99, url: "https://attacker.example/" }];

    await handleMessage(
      controller,
      { kind: "matches", pageUrl: "https://attacker.example/" },
      CONTENT_SCRIPT,
      READY,
    );

    expect(spies.matchesFor).toHaveBeenCalledWith("https://real.example/login");
  });

  it("falls back to the active tab when the sender is the popup, which has no tab", async () => {
    BROWSER_STUB.tabs.query = async () => [{ id: 3, url: "https://active.example/login" }];

    await handleMessage(controller, { kind: "matches" }, SELF, READY);

    expect(spies.matchesFor).toHaveBeenCalledWith("https://active.example/login");
  });

  it("answers with no matches when neither the sender nor the active tab has a URL", async () => {
    BROWSER_STUB.tabs.query = async () => [];

    await handleMessage(controller, { kind: "matches" }, SELF, READY);

    expect(spies.matchesFor).toHaveBeenCalledWith(undefined);
  });

  it("does not consult the active tab when the sender already has one", async () => {
    // A content script's own tab is the only correct answer for it. Querying
    // the active tab as well would fill the foreground tab for a message that
    // came from a background one.
    let queried = false;
    BROWSER_STUB.tabs.query = async () => {
      queried = true;
      return [{ id: 99, url: "https://foreground.example/" }];
    };

    await handleMessage(controller, { kind: "matches" }, CONTENT_SCRIPT, READY);

    expect(queried).toBe(false);
    expect(spies.matchesFor).toHaveBeenCalledWith("https://real.example/login");
  });
});

describe("fillFromPage", () => {
  const CONTENT_SCRIPT: browser.runtime.MessageSender = {
    id: THIS_EXTENSION_ID,
    tab: { id: 7, url: "https://real.example/login" } as browser.tabs.Tab,
  };

  it("fills the sender's own tab", async () => {
    await handleMessage(controller, { kind: "fillFromPage", itemId: "c1" }, CONTENT_SCRIPT, READY);
    expect(spies.fill).toHaveBeenCalledWith(7, "c1");
  });

  it("refuses a page fill from a sender with no tab", async () => {
    // The popup has no tab and must use `fill` with an explicit tabId. A
    // tabless fillFromPage is a shape that should not exist; falling back to
    // the active tab would fill a tab the sender never named.
    BROWSER_STUB.tabs.query = async () => [{ id: 3, url: "https://active.example/login" }];

    await expect(
      handleMessage(controller, { kind: "fillFromPage", itemId: "c1" }, SELF, READY),
    ).rejects.toThrow(/no tab/i);
    expect(spies.fill).not.toHaveBeenCalled();
  });

  it("does not let the message name the tab", async () => {
    // `tabId` is not part of the fillFromPage shape at all, so a sender that
    // bolts one on is filling its own tab regardless.
    await handleMessage(
      controller,
      { kind: "fillFromPage", itemId: "c1", tabId: 99 },
      CONTENT_SCRIPT,
      READY,
    );
    expect(spies.fill).toHaveBeenCalledWith(7, "c1");
  });

  it("hands the refusal back rather than swallowing it", async () => {
    // Controller.fill rejects on an insecure origin, a navigated tab and an
    // entry with no password. The content script has to hear about it: a
    // silent no-op reads to the user as a fill that worked.
    spies.fill.mockRejectedValueOnce(new Error("Refusing to fill on an insecure page."));

    await expect(
      handleMessage(controller, { kind: "fillFromPage", itemId: "c1" }, CONTENT_SCRIPT, READY),
    ).rejects.toThrow(/insecure/i);
  });
});

describe("handOff", () => {
  const CONTENT_SCRIPT: browser.runtime.MessageSender = {
    id: THIS_EXTENSION_ID,
    tab: { id: 7, url: "https://fritz.box/login" } as browser.tabs.Tab,
  };

  const LOCKED_STATUS = {
    state: "locked",
    lastSyncMs: 1000,
    email: "a@b.com",
    serverUrl: "https://v.example.net",
    pinUnlockAvailable: true,
    pinAttemptsRemaining: 5,
  } as const;
  const UNLOCKED_STATUS = { ...LOCKED_STATUS, state: "unlocked" } as const;

  let openPopup: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openPopup = vi.fn().mockResolvedValue(undefined);
    BROWSER_STUB.browserAction = { openPopup };
  });

  it("records a pending fill when the vault is locked", async () => {
    spies.status.mockReturnValue({ ...LOCKED_STATUS });
    const record = vi.spyOn(controller, "recordPending");

    await handleMessage(controller, { kind: "handOff" }, CONTENT_SCRIPT, READY);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 7, origin: "https://fritz.box" }),
    );
  });

  it("records the origin, not the whole URL", async () => {
    // The redemption compares origins. Recording a full URL would either
    // never match after a path change or, worse, be compared loosely.
    spies.status.mockReturnValue({ ...LOCKED_STATUS });
    const record = vi.spyOn(controller, "recordPending");

    await handleMessage(controller, { kind: "handOff" }, CONTENT_SCRIPT, READY);

    const arg = record.mock.calls[0]?.[0];
    expect(arg?.origin).toBe("https://fritz.box");
  });

  it("records nothing when the vault is already unlocked", async () => {
    // An unlocked multi-match tap needs the popup, not a redeemable intent.
    // Leaving one behind would fire on some later, unrelated unlock.
    spies.status.mockReturnValue({ ...UNLOCKED_STATUS });
    const record = vi.spyOn(controller, "recordPending");

    await handleMessage(controller, { kind: "handOff" }, CONTENT_SCRIPT, READY);

    expect(record).not.toHaveBeenCalled();
  });

  it("opens the popup", async () => {
    await handleMessage(controller, { kind: "handOff" }, CONTENT_SCRIPT, READY);
    expect(openPopup).toHaveBeenCalled();
  });

  it("survives a platform where openPopup rejects", async () => {
    // Firefox for Android may refuse this outside a gesture it trusts. The
    // hand-off must still work: the pending fill is recorded either way and
    // opening the addon by hand reaches the same place.
    spies.status.mockReturnValue({ ...LOCKED_STATUS });
    openPopup.mockRejectedValue(new Error("openPopup requires a user gesture"));
    const record = vi.spyOn(controller, "recordPending");

    await expect(
      handleMessage(controller, { kind: "handOff" }, CONTENT_SCRIPT, READY),
    ).resolves.toBeUndefined();

    expect(record).toHaveBeenCalled();
  });

  it("survives a platform with no openPopup at all", async () => {
    // Accessing an undefined method throws a TypeError rather than rejecting.
    spies.status.mockReturnValue({ ...LOCKED_STATUS });
    BROWSER_STUB.browserAction = undefined;

    await expect(
      handleMessage(controller, { kind: "handOff" }, CONTENT_SCRIPT, READY),
    ).resolves.toBeUndefined();
  });

  it("records nothing for a tab whose URL will not parse", async () => {
    spies.status.mockReturnValue({ ...LOCKED_STATUS });
    const record = vi.spyOn(controller, "recordPending");
    const odd: browser.runtime.MessageSender = {
      id: THIS_EXTENSION_ID,
      tab: { id: 7, url: "::::" } as browser.tabs.Tab,
    };

    await expect(
      handleMessage(controller, { kind: "handOff" }, odd, READY),
    ).resolves.toBeUndefined();

    expect(record).not.toHaveBeenCalled();
  });
});

describe("ports from an open popup", () => {
  // The background tells open popups when the vault locks (F-5), which means
  // it now accepts connections. `port.sender.id` is the whole of the check
  // that keeps that channel to this extension's own popup, so it is pinned
  // the same way the onMessage sender check is.

  function fakePort(id: string | undefined) {
    return {
      sender: id === undefined ? undefined : { id },
      onDisconnect: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      postMessage: vi.fn(),
    };
  }

  it("subscribes at load time", () => {
    expect(registeredConnectListener).toBeTypeOf("function");
  });

  it("accepts this extension's own popup and ignores anything else", () => {
    const mine = fakePort(THIS_EXTENSION_ID);
    const theirs = fakePort("some-other-extensions-id");
    const anonymous = fakePort(undefined);

    registeredConnectListener?.(mine);
    registeredConnectListener?.(theirs);
    registeredConnectListener?.(anonymous);

    // Only an accepted port is kept, and keeping it is what installs the
    // disconnect handler that later drops it.
    expect(mine.onDisconnect.addListener).toHaveBeenCalledTimes(1);
    expect(theirs.onDisconnect.addListener).not.toHaveBeenCalled();
    expect(anonymous.onDisconnect.addListener).not.toHaveBeenCalled();
  });
});
