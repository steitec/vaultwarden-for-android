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
    unlockMode: "pin",
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
let closeSpy: ReturnType<typeof vi.spyOn>;

/**
 * The tabs the fake `browser.tabs.query` reports. The default responder reads
 * it so that `matches` behaves the way the real background page does: it
 * resolves the tab itself and answers "unlocked, nothing" when there is no
 * page to match against. Before the badge landed the popup made that call,
 * and these tests encoded it by asserting `matches` was never sent.
 */
let installedTabs: unknown[] = [];

function activeTabHasUrl(): boolean {
  const first = installedTabs[0];
  if (typeof first !== "object" || first === null || !("url" in first)) return false;
  return typeof first.url === "string" && first.url !== "";
}

/** Installs the `browser` global the popup talks to. */
function install(responder: Responder, tabs: unknown[]): void {
  installedTabs = tabs;
  sendMessage = vi.fn((req: unknown) => Promise.resolve(responder(req)));
  vi.stubGlobal("browser", {
    runtime: { sendMessage },
    tabs: { query: () => Promise.resolve(tabs) },
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
        return activeTabHasUrl()
          ? { state: "unlocked", items: [item("m1", "Matched")] }
          : { state: "unlocked", items: [] };
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
    install(defaultResponder({ matches: () => ({ state: "unlocked", items: [] }) }), [
      { id: 1, url: "https://example.com/login" },
    ]);
    await main();
    expect(sentKinds()).toEqual(["status", "matches", "list"]);
    expect(requireEl("root").textContent).toContain("Listed");
  });

  it("still asks for matches when there is no active tab, and falls back", async () => {
    // The popup no longer decides whether the question is worth asking: it
    // does not know the URL any more. The background page resolves the tab
    // itself and answers "unlocked, nothing" when there is no page, which
    // lands on the same list the old short-circuit did.
    install(defaultResponder(), []);
    await main();
    expect(sentKinds()).toEqual(["status", "matches", "list"]);
    expect(requireEl("root").textContent).toContain("Listed");
  });

  it("falls back to the whole vault when the vault locked mid-flight", async () => {
    // The idle timer does not wait for the popup. A "locked" answer to
    // `matches` is a race, not an expected state, and it must not throw the
    // popup's startup -- it falls through to `list`, which reports the lock
    // properly.
    install(defaultResponder({ matches: () => ({ state: "locked" }) }), [{ id: 1 }]);
    await main();
    expect(sentKinds()).toEqual(["status", "matches", "list"]);
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

  it("refuses a non-https server without contacting the background at all", async () => {
    // The popup's own pre-check. setup() refuses it a second time, but a
    // master password must not cross even the internal message boundary on
    // its way to an address it will not be sent to.
    install(defaultResponder({ status: () => EMPTY }), []);
    await main();
    fillSetup({ server: "http://vault.example.net" });
    submitForm(requireEl("root"));
    await Promise.resolve();

    expect(sentKinds()).not.toContain("setup");
  });

  it("signs in against a server on a non-standard port, path and all", async () => {
    // This used to be a permissions test: the host pattern had to lose the
    // port, because Firefox match patterns have no port component (bug
    // 1362809) and `https://host:8443/*` is invalid rather than narrower.
    // The grant is gone (§ F-3) and the port is not, so what is left worth
    // pinning is that such a server still reaches setup intact.
    install(defaultResponder({ status: () => EMPTY }), []);
    await main();
    fillSetup({ server: "https://vault.example.net:8443/vault/" });
    submitForm(requireEl("root"));

    await vi.waitFor(() => expect(sentKinds()).toContain("setup"));
    expect(sentOf("setup")[0]).toMatchObject({
      serverUrl: "https://vault.example.net:8443/vault/",
    });
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
    });

    void main();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(requireEl("root").textContent).toMatch(/not responding/i);
    expect(requireEl("root").querySelector(".message-error")).not.toBeNull();
  });

  it("gives up on a status that never answers within a few seconds", async () => {
    // The counterpart to the two tests below: the crypto kinds get a long
    // budget, and this pins that the budget was widened per kind and not
    // globally. A `status` request is answered out of memory, so if one has
    // not come back in this long the background page is not there.
    vi.useFakeTimers();
    sendMessage = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("browser", {
      runtime: { sendMessage },
      tabs: { query: () => Promise.resolve([]) },
    });

    void main();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(requireEl("root").textContent).toMatch(/not responding/i);
  });

  it("waits out a setup that is slow because it is doing Argon2id and PBKDF2", async () => {
    // Measured on a desktop: PBKDF2-SHA256 at 600k iterations is 420 ms and
    // wrapKeyWithPin (Argon2id, 64 MiB, t=4, p=4) is 525 ms. setup() does
    // both plus deriveMasterPasswordHash BEFORE its first network call, and a
    // mid-range phone is 3-6x slower — so several seconds of silence is the
    // NORMAL path, not a failure. The background page finishes and persists
    // the account either way; a popup that gave up here would tell the user
    // their sign-in failed when it had just succeeded.
    vi.useFakeTimers();
    let signedIn = false;
    install(
      defaultResponder({
        status: () => (signedIn ? UNLOCKED : EMPTY),
        setup: () =>
          new Promise((resolve) => {
            setTimeout(() => {
              signedIn = true;
              resolve({ ok: true });
            }, 9_000);
          }),
      }),
      [],
    );
    await main();
    fillSetup();
    submitForm(requireEl("root"));

    await vi.advanceTimersByTimeAsync(9_000);

    expect(requireEl("root").textContent).not.toMatch(/not responding/i);
    expect(requireEl("root").textContent).toContain("Listed");
  });

  it("waits out an unlock that is slow because it is unwrapping the key", async () => {
    // unwrapKeyWithPin is 379 ms of Argon2id on a desktop and is followed by
    // decrypting the whole offline cache. Timing it out mid-flight does not
    // cost a PIN attempt — Session resets the counter on success and the
    // background completes whether or not the popup is still listening — but
    // it does tell the user the add-on is broken while it is working.
    vi.useFakeTimers();
    let unlocked = false;
    install(
      defaultResponder({
        status: () => (unlocked ? UNLOCKED : LOCKED),
        unlock: () =>
          new Promise((resolve) => {
            setTimeout(() => {
              unlocked = true;
              resolve(undefined);
            }, 8_000);
          }),
      }),
      [],
    );
    await main();
    oneInput(requireEl("root"), "#unlock-pin").value = "135790";
    submitForm(requireEl("root"));

    await vi.advanceTimersByTimeAsync(8_000);

    expect(requireEl("root").textContent).not.toMatch(/not responding/i);
    expect(requireEl("root").textContent).toContain("Listed");
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
      // Complete but for the unlock mode. The settings panel draws a security
      // switch from it, so a default invented here would show a position the
      // background page never reported.
      {
        state: "locked",
        lastSyncMs: null,
        email: null,
        serverUrl: null,
        pinUnlockAvailable: true,
        pinAttemptsRemaining: 5,
      },
      {
        state: "locked",
        lastSyncMs: null,
        email: null,
        serverUrl: null,
        pinUnlockAvailable: true,
        pinAttemptsRemaining: 5,
        unlockMode: "none",
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

describe("stale answers", () => {
  // A `list` answer is for the screen that asked for it. Between the ask and
  // the answer the vault can lock — the user taps Lock, or the idle timer
  // fires and the next route() paints the PIN pad — and painting the reply
  // then puts vault entries on top of a locked vault's unlock screen.

  type Deferred = { promise: Promise<unknown>; settle: (value: unknown) => void; fail: (e: unknown) => void };

  function deferred(): Deferred {
    let settle: (value: unknown) => void = () => {};
    let fail: (e: unknown) => void = () => {};
    const promise = new Promise<unknown>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    return { promise, settle, fail };
  }

  /** Opens the vault, types a query, and stops with that list in flight. */
  async function searchThenLock(pending: Promise<unknown>): Promise<void> {
    let locked = false;
    install(
      defaultResponder({
        status: () => (locked ? LOCKED : UNLOCKED),
        list: () => pending,
        lock: () => {
          locked = true;
          return undefined;
        },
      }),
      [{ id: 1, url: "https://example.com/login" }],
    );
    await main();
    const search = requireInput("search");
    search.value = "git";
    search.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(sentOf("list")).toHaveLength(1));

    tap(requireEl("settings"), "#settings-lock");
    await vi.waitFor(() => expect(requireEl("root").querySelector("#unlock-pin")).not.toBeNull());
  }

  /** Lets the settled list answer run all the way to its render, or not. */
  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("does not paint a late list over the unlock screen", async () => {
    const late = deferred();
    await searchThenLock(late.promise);

    late.settle([item("s1", "Searched")]);
    await flush();

    expect(requireEl("root").querySelector("#unlock-pin")).not.toBeNull();
    expect(requireEl("root").textContent).not.toContain("Searched");
  });

  it("keeps the newest query's answer when an older one comes back after it", async () => {
    // The race the stamps were originally for, and it has to keep working
    // alongside the route check: two keystrokes, and the answer for the
    // earlier one arrives last. Painting it would show results for a query
    // the user has already typed past.
    const first = deferred();
    const second = deferred();
    const answers = [first.promise, second.promise];
    install(
      defaultResponder({ list: () => answers.shift() ?? [] }),
      [{ id: 1, url: "https://example.com/login" }],
    );
    await main();
    const search = requireInput("search");
    search.value = "gi";
    search.dispatchEvent(new Event("input"));
    search.value = "git";
    search.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(sentOf("list")).toHaveLength(2));

    second.settle([item("s2", "Newer")]);
    await flush();
    first.settle([item("s1", "Older")]);
    await flush();

    expect(requireEl("root").textContent).toContain("Newer");
    expect(requireEl("root").textContent).not.toContain("Older");
  });

  it("does not let a keystroke suppress the unlock screen a lock is routing to", async () => {
    // The other direction of the same race, and the one a single shared
    // counter gets wrong. route() takes its claim BEFORE awaiting the status,
    // and the search box is still enabled and visible for the whole of that
    // await — it is only disabled once the locked branch is reached. So a
    // keystroke lands between the two and, if it can take the claim away from
    // route(), route paints NOTHING: no header, no PIN pad, and no
    // `search.disabled = true`. The keystroke's own list then hits a locked
    // vault and renderMessage puts the LockedError where the PIN pad should
    // have been. The user is left with an error and no way back in.
    //
    // A route change and a keystroke are not peers. A route must always beat
    // an in-flight list; a keystroke may only beat other lists.
    const statusAnswers = deferred();
    const listAnswer = deferred();
    let statusCalls = 0;
    let locked = false;
    install(
      defaultResponder({
        status: () => {
          statusCalls += 1;
          // The first status opens the vault; the second is the one route()
          // is awaiting when the keystroke arrives.
          return statusCalls === 1 ? UNLOCKED : statusAnswers.promise;
        },
        list: () => listAnswer.promise,
        lock: () => {
          locked = true;
          return undefined;
        },
      }),
      [{ id: 1, url: "https://example.com/login" }],
    );
    await main();

    tap(requireEl("settings"), "#settings-lock");
    await vi.waitFor(() => expect(sentOf("status")).toHaveLength(2));
    expect(locked).toBe(true);

    // Mid-route, while the box is still live.
    const search = requireInput("search");
    search.value = "git";
    search.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(sentOf("list")).toHaveLength(1));

    statusAnswers.settle(LOCKED);
    await flush();

    // Step 4 of the trace: route() must have painted its screen.
    expect(requireEl("root").querySelector("#unlock-pin")).not.toBeNull();
    expect(requireEl("status").textContent).toMatch(/locked/i);
    expect(requireInput("search").disabled).toBe(true);

    // Step 5: and the keystroke's answer — a LockedError, because that is
    // what a locked vault says to `list` — must not replace it.
    listAnswer.fail(new Error("Vault is locked"));
    await flush();

    expect(requireEl("root").querySelector("#unlock-pin")).not.toBeNull();
    expect(requireEl("root").querySelector(".message-error")).toBeNull();
  });

  it("still wires the list after a render that lost its claim", async () => {
    // showVault returns early when its claim is gone, and that return is
    // before wire(). That is only safe if the render that won the claim
    // wires instead. Here the first showVault loses to the lock, and the
    // unlock that follows is what has to leave a working list behind.
    const stalled = deferred();
    let locked = false;
    let unlocked = false;
    let listCalls = 0;
    install(
      defaultResponder({
        status: () => (unlocked ? UNLOCKED : locked ? LOCKED : UNLOCKED),
        matches: () => {
          listCalls += 1;
          // Only the first vault render is left hanging.
          return listCalls === 1
            ? stalled.promise
            : { state: "unlocked", items: [item("m1", "Matched")] };
        },
        lock: () => {
          locked = true;
          return undefined;
        },
        unlock: () => {
          unlocked = true;
          return undefined;
        },
      }),
      [{ id: 7, url: "https://example.com/login" }],
    );
    void main();
    await vi.waitFor(() => expect(sentOf("matches")).toHaveLength(1));

    tap(requireEl("settings"), "#settings-lock");
    await vi.waitFor(() => expect(requireEl("root").querySelector("#unlock-pin")).not.toBeNull());
    stalled.settle([item("stale", "Stale")]);
    await flush();

    oneInput(requireEl("root"), "#unlock-pin").value = "135790";
    submitForm(requireEl("root"));
    await vi.waitFor(() => expect(requireEl("root").textContent).toContain("Matched"));

    // The click handler is the thing wire() attaches. If it never ran, this
    // tap sends nothing and the panel stays open.
    requireEl("root").querySelector(".item")?.dispatchEvent(new Event("click", { bubbles: true }));
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled());
    expect(sentOf("fill")[0]).toEqual({ kind: "fill", tabId: 7, itemId: "m1" });
  });

  it("does not wipe the unlock screen when the late list turns out to be an error", async () => {
    // The error branch is the worse one: renderMessage replaces the whole of
    // #root, so a locked vault's "Vault is locked" answer to a search issued
    // while it was unlocked would leave the user with a message and no PIN
    // pad — nothing to tap, and no way back in short of reopening the panel.
    const late = deferred();
    await searchThenLock(late.promise);

    late.fail(new Error("Vault is locked"));
    await flush();

    expect(requireEl("root").querySelector("#unlock-pin")).not.toBeNull();
    expect(requireEl("root").querySelector(".message-error")).toBeNull();
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
    install(
      defaultResponder({
        matches: () => ({ state: "unlocked", items: [item("u1", "⚠ cannot be decrypted", true)] }),
      }),
      [{ id: 7, url: "https://example.com/login" }],
    );
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
