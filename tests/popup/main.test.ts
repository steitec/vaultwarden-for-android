import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { main } from "../../src/popup/popup";
import type { Status } from "../../src/background/messages";

// The popup's whole job is talking to a background page that can decline
// (returning undefined, which never settles), reject (a locked vault is the
// DEFAULT state on open, and every fill can be refused for a security
// reason), or answer nonsense. None of those may end as a blank panel.

const SKELETON = `
  <header id="status" class="status"></header>
  <nav id="settings" class="settings" hidden></nav>
  <input id="search" class="search" type="search" />
  <p id="error" class="banner" role="alert" hidden></p>
  <main id="root"></main>
`;

function requireEl(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found;
}

function requireInput(id: string): HTMLInputElement {
  const found = requireEl(id);
  if (!(found instanceof HTMLInputElement)) throw new Error(`#${id} is not an input`);
  return found;
}

function one(scope: ParentNode, selector: string): HTMLElement {
  const found = scope.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`no element matching ${selector}`);
  return found;
}

function oneInput(scope: ParentNode, selector: string): HTMLInputElement {
  const found = scope.querySelector(selector);
  if (!(found instanceof HTMLInputElement)) throw new Error(`no input matching ${selector}`);
  return found;
}

function submitForm(scope: ParentNode): void {
  const form = scope.querySelector("form");
  if (!(form instanceof HTMLFormElement)) throw new Error("no form to submit");
  form.dispatchEvent(new Event("submit", { cancelable: true }));
}

function tap(scope: ParentNode, selector: string): void {
  one(scope, selector).dispatchEvent(new Event("click", { bubbles: true }));
}

function kindOf(req: unknown): string {
  if (typeof req !== "object" || req === null) return "";
  if (!("kind" in req) || typeof req.kind !== "string") return "";
  return req.kind;
}

function status(over: Partial<Status> = {}): Status {
  return {
    state: "unlocked",
    lastSyncMs: null,
    email: "a@b.com",
    serverUrl: "https://vault.example.net",
    pinUnlockAvailable: true,
    pinAttemptsRemaining: 5,
    ...over,
  };
}

const UNLOCKED: Status = status();
const LOCKED: Status = status({ state: "locked", lastSyncMs: 1, pinAttemptsRemaining: 5 });
const EMPTY: Status = status({
  state: "empty",
  email: null,
  serverUrl: null,
  pinUnlockAvailable: false,
  pinAttemptsRemaining: 5,
});

type Item = {
  id: string;
  name: string;
  username: string | null;
  hasTotp: boolean;
  undecryptable: boolean;
};

function item(id: string, name: string, undecryptable = false): Item {
  return { id, name, username: null, hasTotp: false, undecryptable };
}

type Responder = (req: unknown) => unknown;

let sendMessage: ReturnType<typeof vi.fn>;
let permissionsRequest: ReturnType<typeof vi.fn>;
let closeSpy: ReturnType<typeof vi.spyOn>;

/** Installs the `browser` global the popup talks to. */
function install(responder: Responder, tabs: unknown[], grant = true): void {
  sendMessage = vi.fn((req: unknown) => Promise.resolve(responder(req)));
  permissionsRequest = vi.fn(() => Promise.resolve(grant));
  vi.stubGlobal("browser", {
    runtime: { sendMessage },
    tabs: { query: () => Promise.resolve(tabs) },
    permissions: { request: permissionsRequest },
  });
}

/** A background page that answers every kind sensibly. */
function defaultResponder(overrides: Partial<Record<string, () => unknown>> = {}): Responder {
  return (req: unknown) => {
    const kind = kindOf(req);
    const override = overrides[kind];
    if (override !== undefined) return override();
    switch (kind) {
      case "status":
        return UNLOCKED;
      case "matches":
        return [item("m1", "Matched")];
      case "list":
        return [item("l1", "Listed")];
      case "fill":
      case "lock":
      case "signOut":
      case "sync":
        return undefined;
      case "setup":
        return { ok: true };
      case "unlock":
        return undefined;
      default:
        throw new Error(`unexpected message kind ${kind}`);
    }
  };
}

function sentKinds(): string[] {
  return sendMessage.mock.calls.map((call) => kindOf(call[0]));
}

function sentOf(kind: string): unknown[] {
  return sendMessage.mock.calls.map((call) => call[0]).filter((req) => kindOf(req) === kind);
}

const CREDENTIALS = {
  server: "https://vault.example.net",
  email: "a@b.com",
  password: "master",
  pin: "135790",
};

function fillSetup(over: Partial<typeof CREDENTIALS> = {}): void {
  const v = { ...CREDENTIALS, ...over };
  const root = requireEl("root");
  oneInput(root, "#setup-server").value = v.server;
  oneInput(root, "#setup-email").value = v.email;
  oneInput(root, "#setup-password").value = v.password;
  oneInput(root, "#setup-pin").value = v.pin;
}

beforeEach(() => {
  document.body.innerHTML = SKELETON;
  closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("popup startup", () => {
  it("does nothing at all at import time", async () => {
    // Gating main() on an explicit signal — the document still being parsed
    // — rather than on "is there a #root right now" is what makes the render
    // functions importable. A module that fires a status request on import
    // would do it in every test file that touches it, in whatever DOM
    // happens to be lying around.
    vi.resetModules();
    install(defaultResponder(), [{ id: 1, url: "https://example.com/login" }]);
    await import("../../src/popup/popup");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(requireEl("root").childElementCount).toBe(0);
  });

  it("lists the entries that match the current page first", async () => {
    install(defaultResponder(), [{ id: 1, url: "https://example.com/login" }]);
    await main();
    expect(sentKinds()).toEqual(["status", "matches"]);
    expect(requireEl("root").textContent).toContain("Matched");
    expect(requireInput("search")).toBe(document.activeElement);
  });

  it("falls back to the whole vault when the page has no matches", async () => {
    install(defaultResponder({ matches: () => [] }), [{ id: 1, url: "https://example.com/login" }]);
    await main();
    expect(sentKinds()).toEqual(["status", "matches", "list"]);
    expect(requireEl("root").textContent).toContain("Listed");
  });

  it("skips the match query when there is no active tab", async () => {
    // tabs.query legitimately answers [] — no window, or a privileged
    // surface. `{kind:"matches", pageUrl:""}` is not a question with a
    // useful answer; it is a question about no page at all.
    install(defaultResponder(), []);
    await main();
    expect(sentKinds()).toEqual(["status", "list"]);
    expect(requireEl("root").textContent).toContain("Listed");
  });

  it("skips the match query when the tab has no readable url", async () => {
    // `tab.url` is undefined whenever activeTab has not been granted for
    // that tab, which is the normal case until the user acts.
    install(defaultResponder(), [{ id: 1 }]);
    await main();
    expect(sentKinds()).toEqual(["status", "list"]);
  });
});

describe("routing", () => {
  it("shows the unlock screen and asks the vault for nothing", async () => {
    install(defaultResponder({ status: () => LOCKED }), [
      { id: 1, url: "https://example.com/login" },
    ]);
    await main();
    expect(sentKinds()).toEqual(["status"]);
    expect(requireEl("root").textContent).toMatch(/locked/i);
    expect(requireEl("root").querySelector("#unlock-pin")).not.toBeNull();
    expect(requireEl("status").textContent).toMatch(/locked/i);
    expect(requireInput("search").hidden).toBe(true);
    expect(requireEl("settings").hidden).toBe(true);
  });

  it("takes the lockout warning from the status, not from a constant", async () => {
    // Status is the only thing that knows how many PIN attempts are left. A
    // hardcoded number here means the warning can never fire.
    install(defaultResponder({ status: () => status({ state: "locked", pinAttemptsRemaining: 2 }) }), []);
    await main();
    expect(requireEl("root").textContent).toMatch(/2 attempts remaining/i);
  });

  it("shows the setup screen when no vault exists yet", async () => {
    install(defaultResponder({ status: () => EMPTY }), []);
    await main();
    expect(sentKinds()).toEqual(["status"]);
    expect(requireEl("root").textContent).toMatch(/sign in/i);
    expect(requireEl("root").querySelector("#setup-server")).not.toBeNull();
  });

  it("routes a locked vault with no usable PIN to a prefilled re-authentication", async () => {
    // requireMasterPasswordOnRestart, or a PIN lockout that dropped
    // pinWrapped. The unlock screen could never succeed from here, so
    // rendering one strands the user with no way back into the vault.
    install(
      defaultResponder({
        status: () =>
          status({
            state: "locked",
            pinUnlockAvailable: false,
            pinAttemptsRemaining: 0,
            serverUrl: "https://vault.example.net",
            email: "a@b.com",
          }),
      }),
      [],
    );
    await main();

    const root = requireEl("root");
    expect(root.querySelector("#unlock-pin")).toBeNull();
    expect(oneInput(root, "#setup-server").value).toBe("https://vault.example.net");
    expect(oneInput(root, "#setup-email").value).toBe("a@b.com");
    expect(root.textContent).toMatch(/again|re-?authenticat/i);
  });

  it("surfaces a lock that happens between the status answer and the list", async () => {
    // The idle timer does not wait for the popup: `unlocked` from status is
    // a snapshot, not a guarantee.
    install(
      defaultResponder({
        matches: () => {
          throw new Error("Vault is locked");
        },
      }),
      [{ id: 1, url: "https://example.com/login" }],
    );
    await main();
    expect(requireEl("root").textContent).toMatch(/vault is locked/i);
  });
});

describe("setup", () => {
  it("asks for the host permission while the tap is still a tap", async () => {
    // Firefox only honours permissions.request() during the synchronous run
    // of a user input handler. A single `await` anywhere before it — even
    // `await Promise.resolve()` — and every real user gets a refusal. Hence
    // no await in this assertion either: if request() has not happened by
    // the time dispatchEvent returns, it happened too late.
    install(defaultResponder({ status: () => EMPTY }), []);
    await main();
    fillSetup();
    submitForm(requireEl("root"));

    expect(permissionsRequest).toHaveBeenCalledWith({
      origins: ["https://vault.example.net/*"],
    });
  });

  it("asks for the configured origin alone, never the manifest wildcard", async () => {
    install(defaultResponder({ status: () => EMPTY }), []);
    await main();
    fillSetup({ server: "https://vault.example.net:8443/vault/" });
    submitForm(requireEl("root"));

    expect(permissionsRequest).toHaveBeenCalledTimes(1);
    expect(permissionsRequest).toHaveBeenCalledWith({
      origins: ["https://vault.example.net:8443/*"],
    });
  });

  it("sends the setup message and re-routes into the vault without reloading", async () => {
    // Re-routing, not location.reload(): a reload throws the panel away and
    // starts a second popup lifetime, and there is nothing to prove it
    // happened. A second status request is the witness that main() re-ran
    // its routing in place.
    let signedIn = false;
    install(
      defaultResponder({
        status: () => (signedIn ? UNLOCKED : EMPTY),
        setup: () => {
          signedIn = true;
          return { ok: true };
        },
      }),
      [],
    );
    await main();
    fillSetup();
    submitForm(requireEl("root"));

    await vi.waitFor(() => expect(requireEl("root").textContent).toContain("Listed"));
    expect(sentOf("setup")[0]).toEqual({
      kind: "setup",
      serverUrl: "https://vault.example.net",
      email: "a@b.com",
      password: "master",
      pin: "135790",
    });
    expect(sentOf("status")).toHaveLength(2);
  });

  it("stops at a declined permission and names the origin, without contacting the background", async () => {
    install(defaultResponder({ status: () => EMPTY }), [], false);
    await main();
    fillSetup();
    submitForm(requireEl("root"));

    await vi.waitFor(() =>
      expect(one(requireEl("root"), ".error").textContent).toContain("https://vault.example.net"),
    );
    expect(sentKinds()).not.toContain("setup");
  });

  it("never asks for a permission for a url it will not use", async () => {
    install(defaultResponder({ status: () => EMPTY }), []);
    await main();
    fillSetup({ server: "http://vault.example.net" });
    submitForm(requireEl("root"));
    await Promise.resolve();

    expect(permissionsRequest).not.toHaveBeenCalled();
    expect(sentKinds()).not.toContain("setup");
  });

  it("renders the server's two-factor providers, not a hardcoded pair", async () => {
    // The provider list is the server's answer. Error classes do not survive
    // runtime.sendMessage, so it arrives as a structured value or not at all
    // — and offering a method the account does not have wastes the one
    // screen the user has.
    install(
      defaultResponder({
        status: () => EMPTY,
        setup: () => ({ ok: false, reason: "twoFactor", providers: [1] }),
      }),
      [],
    );
    await main();
    fillSetup();
    submitForm(requireEl("root"));

    await vi.waitFor(() => expect(requireEl("root").querySelector("#tf-code")).not.toBeNull());
    const root = requireEl("root");
    expect(root.textContent).toMatch(/email/i);
    // Provider 0 was never offered, so it must not be selectable.
    expect(root.querySelector("#tf-provider-0")).toBeNull();
    expect(root.textContent).not.toMatch(/authenticator/i);
  });

  it("retries setup with the second factor and lands in the vault", async () => {
    let challenged = false;
    install(
      defaultResponder({
        status: () => (challenged ? UNLOCKED : EMPTY),
        setup: (): unknown => {
          if (!challenged) {
            challenged = true;
            return { ok: false, reason: "twoFactor", providers: [0] };
          }
          return { ok: true };
        },
      }),
      [],
    );
    await main();
    fillSetup();
    submitForm(requireEl("root"));

    await vi.waitFor(() => expect(requireEl("root").querySelector("#tf-code")).not.toBeNull());
    oneInput(requireEl("root"), "#tf-code").value = "123456";
    submitForm(requireEl("root"));

    await vi.waitFor(() => expect(requireEl("root").textContent).toContain("Listed"));
    const setups = sentOf("setup");
    expect(setups).toHaveLength(2);
    expect(setups[1]).toEqual({
      kind: "setup",
      serverUrl: "https://vault.example.net",
      email: "a@b.com",
      password: "master",
      pin: "135790",
      twoFactor: { token: "123456", provider: 0 },
    });
    // Exactly one grant: the second call runs on the permission the first
    // one obtained.
    expect(permissionsRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps the two-factor screen up when the code is refused", async () => {
    install(
      defaultResponder({
        status: () => EMPTY,
        setup: () => ({ ok: false, reason: "twoFactor", providers: [0] }),
      }),
      [],
    );
    await main();
    fillSetup();
    submitForm(requireEl("root"));

    await vi.waitFor(() => expect(requireEl("root").querySelector("#tf-code")).not.toBeNull());
    oneInput(requireEl("root"), "#tf-code").value = "000000";
    submitForm(requireEl("root"));

    await vi.waitFor(() =>
      expect(one(requireEl("root"), ".error").textContent).toMatch(/not accepted|again/i),
    );
    expect(requireEl("root").querySelector("#tf-code")).not.toBeNull();
  });

  it("reports a malformed setup answer instead of pretending it worked", async () => {
    install(defaultResponder({ status: () => EMPTY, setup: () => ({ nope: true }) }), []);
    await main();
    fillSetup();
    submitForm(requireEl("root"));

    await vi.waitFor(() => expect(one(requireEl("root"), ".error").textContent).toMatch(/unexpected/i));
  });
});

describe("unlock", () => {
  it("sends the pin and re-routes into the vault", async () => {
    let unlocked = false;
    install(
      defaultResponder({
        status: () => (unlocked ? UNLOCKED : LOCKED),
        unlock: () => {
          unlocked = true;
          return undefined;
        },
      }),
      [],
    );
    await main();
    oneInput(requireEl("root"), "#unlock-pin").value = "135790";
    submitForm(requireEl("root"));

    await vi.waitFor(() => expect(requireEl("root").textContent).toContain("Listed"));
    expect(sentOf("unlock")[0]).toEqual({ kind: "unlock", pin: "135790" });
    expect(requireInput("search").hidden).toBe(false);
    expect(requireInput("search").disabled).toBe(false);
    expect(requireEl("settings").hidden).toBe(false);
  });

  it("wires the search box exactly once across a re-route", async () => {
    // route() runs again after every unlock. Attaching the input listener
    // each time would fire N requests per keystroke and race their answers.
    let unlocked = false;
    install(
      defaultResponder({
        status: () => (unlocked ? UNLOCKED : LOCKED),
        unlock: () => {
          unlocked = true;
          return undefined;
        },
      }),
      [],
    );
    await main();
    oneInput(requireEl("root"), "#unlock-pin").value = "135790";
    submitForm(requireEl("root"));
    await vi.waitFor(() => expect(requireEl("root").textContent).toContain("Listed"));

    const before = sentOf("list").length;
    const search = requireInput("search");
    search.value = "git";
    search.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(sentOf("list").length).toBe(before + 1));
    await Promise.resolve();
    expect(sentOf("list").length).toBe(before + 1);
  });

  it("shows a wrong PIN on the unlock screen rather than replacing it", async () => {
    install(
      defaultResponder({
        status: () => LOCKED,
        unlock: () => {
          throw new Error("Incorrect PIN");
        },
      }),
      [],
    );
    await main();
    oneInput(requireEl("root"), "#unlock-pin").value = "000000";
    submitForm(requireEl("root"));

    await vi.waitFor(() =>
      expect(one(requireEl("root"), ".error").textContent).toMatch(/incorrect pin/i),
    );
    expect(requireEl("root").querySelector("#unlock-pin")).not.toBeNull();
  });

  it("moves to the master-password screen when the last PIN attempt is spent", async () => {
    // Session drops pinWrapped once the counter is exhausted. Leaving the
    // PIN pad on screen would leave the user tapping at something that can
    // never succeed again.
    let exhausted = false;
    install(
      defaultResponder({
        status: () =>
          exhausted
            ? status({ state: "locked", pinUnlockAvailable: false, pinAttemptsRemaining: 0 })
            : status({ state: "locked", pinAttemptsRemaining: 1 }),
        unlock: () => {
          exhausted = true;
          throw new Error("Too many incorrect PIN attempts. Sign in with your master password.");
        },
      }),
      [],
    );
    await main();
    oneInput(requireEl("root"), "#unlock-pin").value = "000000";
    submitForm(requireEl("root"));

    await vi.waitFor(() => expect(requireEl("root").querySelector("#setup-password")).not.toBeNull());
    expect(requireEl("root").querySelector("#unlock-pin")).toBeNull();
  });
});

describe("settings", () => {
  it("syncs and refreshes the list", async () => {
    install(defaultResponder(), []);
    await main();
    tap(requireEl("settings"), "#settings-sync");

    await vi.waitFor(() => expect(sentKinds()).toContain("sync"));
    await vi.waitFor(() => expect(sentOf("status").length).toBe(2));
    expect(requireEl("root").textContent).toContain("Listed");
  });

  it("reports a failed sync in the banner instead of wiping the list", async () => {
    install(
      defaultResponder({
        sync: () => {
          throw new Error("Could not reach the server.");
        },
      }),
      [],
    );
    await main();
    tap(requireEl("settings"), "#settings-sync");

    await vi.waitFor(() => expect(requireEl("error").hidden).toBe(false));
    expect(requireEl("error").textContent).toMatch(/could not reach/i);
    expect(requireEl("root").textContent).toContain("Listed");
  });

  it("locks and lands on the unlock screen", async () => {
    let locked = false;
    install(
      defaultResponder({
        status: () => (locked ? LOCKED : UNLOCKED),
        lock: () => {
          locked = true;
          return undefined;
        },
      }),
      [],
    );
    await main();
    tap(requireEl("settings"), "#settings-lock");

    await vi.waitFor(() => expect(requireEl("root").querySelector("#unlock-pin")).not.toBeNull());
    expect(requireEl("settings").hidden).toBe(true);
  });

  it("does not sign out on a single tap", async () => {
    install(defaultResponder(), []);
    await main();
    tap(requireEl("settings"), "#settings-signout");
    await Promise.resolve();

    expect(sentKinds()).not.toContain("signOut");
  });

  it("signs out after the confirmation and lands on the setup screen", async () => {
    let gone = false;
    install(
      defaultResponder({
        status: () => (gone ? EMPTY : UNLOCKED),
        signOut: () => {
          gone = true;
          return undefined;
        },
      }),
      [],
    );
    await main();
    tap(requireEl("settings"), "#settings-signout");
    tap(requireEl("settings"), "#settings-signout-confirm");

    await vi.waitFor(() => expect(requireEl("root").querySelector("#setup-server")).not.toBeNull());
    expect(sentKinds()).toContain("signOut");
    expect(requireEl("settings").hidden).toBe(true);
  });
});

describe("failure handling", () => {
  it("does not hang when the background page declines to answer", async () => {
    // handleMessage returns undefined — not a rejection — for a wrong
    // sender.id or a payload isRequest rejects, and a sendMessage whose
    // listener returns undefined NEVER settles. Without the timeout this
    // popup is frozen forever with nothing on screen.
    vi.useFakeTimers();
    sendMessage = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("browser", {
      runtime: { sendMessage },
      tabs: { query: () => Promise.resolve([]) },
      permissions: { request: () => Promise.resolve(true) },
    });

    void main();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(requireEl("root").textContent).toMatch(/not responding/i);
    expect(requireEl("root").querySelector(".message-error")).not.toBeNull();
  });

  it("reports a malformed answer instead of rendering a blank panel", async () => {
    install(defaultResponder({ status: () => ({ state: "bogus" }) }), []);
    await main();
    expect(requireEl("root").textContent).toMatch(/unexpected/i);
  });

  it("rejects a status that is missing the new lock fields rather than guessing", async () => {
    // These fields decide which screen the user gets. A status without them
    // must not be waved through with defaults invented here.
    for (const partial of [
      { state: "locked", lastSyncMs: null, email: null, serverUrl: null, pinUnlockAvailable: true },
      { state: "locked", lastSyncMs: null, email: null, serverUrl: null, pinAttemptsRemaining: 5 },
      {
        state: "locked",
        lastSyncMs: null,
        email: null,
        serverUrl: 7,
        pinUnlockAvailable: true,
        pinAttemptsRemaining: 5,
      },
      {
        state: "locked",
        lastSyncMs: null,
        email: null,
        serverUrl: null,
        pinUnlockAvailable: "yes",
        pinAttemptsRemaining: 5,
      },
      {
        state: "locked",
        lastSyncMs: null,
        email: null,
        serverUrl: null,
        pinUnlockAvailable: true,
        pinAttemptsRemaining: Number.NaN,
      },
    ]) {
      document.body.innerHTML = SKELETON;
      install(defaultResponder({ status: () => partial }), []);
      await main();
      expect(requireEl("root").textContent).toMatch(/unexpected/i);
    }
  });

  it("reports a rejected status request", async () => {
    install(
      defaultResponder({
        status: () => {
          throw new Error("Vault is locked");
        },
      }),
      [],
    );
    await main();
    expect(requireEl("root").textContent).toMatch(/vault is locked/i);
    expect(requireInput("search").disabled).toBe(true);
  });
});

describe("search", () => {
  it("re-lists on input with the typed query", async () => {
    install(defaultResponder({ list: () => [item("s1", "Searched")] }), []);
    await main();
    const search = requireInput("search");
    search.value = "git";
    search.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(requireEl("root").textContent).toContain("Searched"));
    const last = sendMessage.mock.calls[sendMessage.mock.calls.length - 1]?.[0];
    expect(last).toEqual({ kind: "list", query: "git" });
  });

  it("shows an error when a search is refused rather than freezing the list", async () => {
    let fail = false;
    install(
      defaultResponder({
        list: () => {
          if (fail) throw new Error("Vault is locked");
          return [item("l1", "Listed")];
        },
      }),
      [],
    );
    await main();
    fail = true;
    const search = requireInput("search");
    search.value = "x";
    search.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(requireEl("root").textContent).toMatch(/vault is locked/i));
  });
});

describe("fill", () => {
  it("sends exactly the tab id and item id, with no caller-supplied page url", async () => {
    // The background reads the destination from the tab itself. A pageUrl in
    // this message would be a caller telling it where to send credentials.
    install(defaultResponder(), [{ id: 7, url: "https://example.com/login" }]);
    await main();
    requireEl("root").querySelector(".item")?.dispatchEvent(new Event("click", { bubbles: true }));
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled());
    const fillCall = sendMessage.mock.calls.find((call) => kindOf(call[0]) === "fill");
    expect(fillCall?.[0]).toEqual({ kind: "fill", tabId: 7, itemId: "m1" });
  });

  it("tells the user why a fill was refused and keeps the panel open", async () => {
    // A silent no-op here reads as success: the user assumes the password
    // went in, and either submits an empty form or trusts a page that this
    // add-on deliberately refused to fill.
    const refusal =
      "Refusing to fill on an insecure page. This site is not using https, so the " +
      "credentials could be read in transit.";
    install(
      defaultResponder({
        fill: () => {
          throw new Error(refusal);
        },
      }),
      [{ id: 7, url: "http://example.com/login" }],
    );
    await main();
    requireEl("root").querySelector(".item")?.dispatchEvent(new Event("click", { bubbles: true }));

    await vi.waitFor(() => expect(requireEl("error").hidden).toBe(false));
    expect(requireEl("error").textContent).toContain("Refusing to fill");
    expect(closeSpy).not.toHaveBeenCalled();
    expect(requireEl("root").querySelector(".item")).not.toBeNull();
  });

  it("does not attempt to fill an undecryptable entry", async () => {
    install(defaultResponder({ matches: () => [item("u1", "⚠ cannot be decrypted", true)] }), [
      { id: 7, url: "https://example.com/login" },
    ]);
    await main();
    requireEl("root").querySelector(".item")?.dispatchEvent(new Event("click", { bubbles: true }));
    await vi.waitFor(() => expect(requireEl("error").hidden).toBe(false));
    expect(sentKinds()).not.toContain("fill");
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("ignores taps that land outside a row", async () => {
    install(defaultResponder(), [{ id: 7, url: "https://example.com/login" }]);
    await main();
    requireEl("root").dispatchEvent(new Event("click", { bubbles: true }));
    await Promise.resolve();
    expect(sentKinds()).not.toContain("fill");
  });
});
