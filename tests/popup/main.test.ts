import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { main } from "../../src/popup/popup";
import type { Status } from "../../src/background/messages";

// The popup's whole job is talking to a background page that can decline
// (returning undefined, which never settles), reject (a locked vault is the
// DEFAULT state on open, and every fill can be refused for a security
// reason), or answer nonsense. None of those may end as a blank panel.

const SKELETON = `
  <header id="status" class="status"></header>
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

function kindOf(req: unknown): string {
  if (typeof req !== "object" || req === null) return "";
  if (!("kind" in req) || typeof req.kind !== "string") return "";
  return req.kind;
}

const UNLOCKED: Status = { state: "unlocked", lastSyncMs: null, email: "a@b.com" };

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

/** Installs the `browser` global the popup talks to. */
function install(responder: Responder, tabs: unknown[]): void {
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
        return [item("m1", "Matched")];
      case "list":
        return [item("l1", "Listed")];
      case "fill":
        return undefined;
      default:
        throw new Error(`unexpected message kind ${kind}`);
    }
  };
}

function sentKinds(): string[] {
  return sendMessage.mock.calls.map((call) => kindOf(call[0]));
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

describe("lock state", () => {
  it("shows a locked placeholder and asks the vault for nothing", async () => {
    const locked: Status = { state: "locked", lastSyncMs: 1, email: "a@b.com" };
    install(defaultResponder({ status: () => locked }), [
      { id: 1, url: "https://example.com/login" },
    ]);
    await main();
    expect(sentKinds()).toEqual(["status"]);
    expect(requireEl("root").textContent).toMatch(/locked/i);
    expect(requireEl("status").textContent).toMatch(/locked/i);
    expect(requireInput("search").hidden).toBe(true);
  });

  it("shows a setup placeholder when no vault exists yet", async () => {
    const empty: Status = { state: "empty", lastSyncMs: null, email: null };
    install(defaultResponder({ status: () => empty }), []);
    await main();
    expect(sentKinds()).toEqual(["status"]);
    expect(requireEl("root").textContent).toMatch(/sign in/i);
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

  it("reports a malformed answer instead of rendering a blank panel", async () => {
    install(defaultResponder({ status: () => ({ state: "bogus" }) }), []);
    await main();
    expect(requireEl("root").textContent).toMatch(/unexpected/i);
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
