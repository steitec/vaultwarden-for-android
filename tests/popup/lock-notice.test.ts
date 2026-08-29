import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { main } from "../../src/popup/popup";
import type { Status } from "../../src/background/messages";

// F-5. The idle timer locks the vault in the background page. An open popup is
// a snapshot: nothing routes it, so it went on showing the entry list -- names
// and usernames -- after the keys had been zeroed. That is the idle-lock
// scenario itself, since a panel left open is how a phone gets put down.
// Observed on the device 2026-08-26; see docs/VERIFICATION-2026-08-25.md.

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

function kindOf(req: unknown): string {
  if (typeof req !== "object" || req === null) return "";
  if (!("kind" in req) || typeof req.kind !== "string") return "";
  return req.kind;
}

/** The listeners the popup registered on the port it opened, if it opened one. */
let portListeners: ((msg: unknown) => void)[] = [];
let connected = false;

const ITEM = { id: "c1", name: "GitHub", username: "octo", hasTotp: false, undecryptable: false };

/** Locked once the idle timer has run; unlocked before that. */
let locked = false;

function respond(req: unknown): unknown {
  const kind = kindOf(req);
  if (kind === "status") {
    const s: Status = {
      state: locked ? "locked" : "unlocked",
      lastSyncMs: 1,
      email: "a@b.com",
      serverUrl: "https://vault.example.net",
      pinUnlockAvailable: true,
      pinAttemptsRemaining: 5,
      unlockMode: "pin",
    };
    return s;
  }
  if (kind === "list") {
    if (locked) throw new Error("Vault is locked");
    return [ITEM];
  }
  if (kind === "matches") {
    return locked ? { state: "locked" } : { state: "unlocked", items: [ITEM] };
  }
  throw new Error(`unexpected kind ${kind}`);
}

function notifyLocked(): void {
  if (!connected) {
    throw new Error("the popup never opened a port, so the background cannot tell it anything");
  }
  for (const listener of portListeners) listener({ kind: "locked" });
}

beforeEach(() => {
  document.body.innerHTML = SKELETON;
  portListeners = [];
  connected = false;
  locked = false;
  vi.spyOn(window, "close").mockImplementation(() => {});
  vi.stubGlobal("browser", {
    runtime: {
      sendMessage: vi.fn((req: unknown) => Promise.resolve(respond(req))),
      connect: vi.fn(() => {
        connected = true;
        return {
          onMessage: {
            addListener: (fn: (msg: unknown) => void) => {
              portListeners.push(fn);
            },
          },
          onDisconnect: { addListener: () => {} },
          disconnect: () => {},
        };
      }),
    },
    tabs: { query: () => Promise.resolve([]) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a vault that locks while the popup is open", () => {
  it("stops showing the entries", async () => {
    await main();
    const root = requireEl("root");
    expect(root.textContent).toContain("GitHub");

    // The idle timer fires in the background page.
    locked = true;
    notifyLocked();

    await vi.waitFor(() => {
      expect(root.textContent).not.toContain("GitHub");
    });
  });

  it("shows the PIN pad instead", async () => {
    await main();
    locked = true;
    notifyLocked();

    const root = requireEl("root");
    await vi.waitFor(() => {
      expect(root.querySelector("#unlock-pin")).not.toBeNull();
    });
  });
});
