import { describe, it, expect, beforeEach, vi } from "vitest";
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

vi.stubGlobal("browser", {
  runtime: {
    id: THIS_EXTENSION_ID,
    onMessage: {
      addListener: (fn: (msg: unknown, sender: { id?: string }) => unknown) => {
        registeredListener = fn;
      },
    },
  },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
});

const { handleMessage } = await import("../../src/background/index");

const SELF = { id: THIS_EXTENSION_ID };
const FOREIGN = { id: "some-other-extensions-id" };

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
};

/** Every controller method the dispatcher can reach, stubbed and observable. */
function makeSpies(c: Controller) {
  return {
    status: vi
      .spyOn(c, "status")
      .mockReturnValue({ state: "locked", lastSyncMs: 1000, email: "a@b.com" }),
    unlock: vi.spyOn(c, "unlock").mockResolvedValue(undefined),
    lock: vi.spyOn(c, "lock").mockReturnValue(undefined),
    signOut: vi.spyOn(c, "signOut").mockResolvedValue(undefined),
    list: vi.spyOn(c, "list").mockResolvedValue([]),
    matchesFor: vi.spyOn(c, "matchesFor").mockResolvedValue([]),
    fill: vi.spyOn(c, "fill").mockResolvedValue(undefined),
    totpFor: vi.spyOn(c, "totpFor").mockResolvedValue({ code: "123456", secondsRemaining: 30 }),
    setup: vi.spyOn(c, "setup").mockResolvedValue(undefined),
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
  { kind: "matches", pageUrl: "https://github.com/" },
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
      expect(handleMessage(controller, msg, FOREIGN)).toBeUndefined();
    }
    expectNothingDispatched();
  });

  it("ignores a request whose sender has no id at all (a content script or page)", async () => {
    expect(handleMessage(controller, { kind: "list", query: "" }, {})).toBeUndefined();
    expectNothingDispatched();
  });

  it("acts on a request whose sender is this extension itself", async () => {
    const result = handleMessage(controller, { kind: "status" }, SELF);
    await expect(result).resolves.toEqual({
      state: "locked",
      lastSyncMs: 1000,
      email: "a@b.com",
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
    ["matches with no pageUrl", { kind: "matches" }],
    ["matches with a non-string pageUrl", { kind: "matches", pageUrl: 1 }],
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
      expect(handleMessage(controller, msg, SELF)).toBeUndefined();
      expectNothingDispatched();
    });
  }

  it("does not reject — it returns undefined, so a malformed message yields no error to the sender", () => {
    // Returning a rejected promise would confirm to a probing extension
    // both that this extension exists and which shapes it understands.
    expect(() => handleMessage(controller, { kind: "unlock" }, SELF)).not.toThrow();
  });
});

describe("handleMessage routing", () => {
  it("routes each request kind to the matching controller call", async () => {
    await handleMessage(controller, { kind: "status" }, SELF);
    expect(spies.status).toHaveBeenCalledTimes(1);

    await handleMessage(controller, { kind: "unlock", pin: "135790" }, SELF);
    expect(spies.unlock).toHaveBeenCalledWith("135790");

    await handleMessage(controller, { kind: "lock" }, SELF);
    expect(spies.lock).toHaveBeenCalledTimes(1);

    await handleMessage(controller, { kind: "signOut" }, SELF);
    expect(spies.signOut).toHaveBeenCalledTimes(1);

    await handleMessage(controller, { kind: "list", query: "git" }, SELF);
    expect(spies.list).toHaveBeenCalledWith("git");

    await handleMessage(controller, { kind: "matches", pageUrl: "https://github.com/" }, SELF);
    expect(spies.matchesFor).toHaveBeenCalledWith("https://github.com/");

    await handleMessage(controller, { kind: "fill", tabId: 7, itemId: "c1" }, SELF);
    expect(spies.fill).toHaveBeenCalledWith(7, "c1");

    await handleMessage(controller, { kind: "totp", itemId: "c1" }, SELF);
    expect(spies.totpFor).toHaveBeenCalledWith("c1");

    await handleMessage(controller, { kind: "sync" }, SELF);
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
      const result = handleMessage(controller, msg, SELF);
      expect(result).toBeInstanceOf(Promise);
      await result;
    }
  });
});
