import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { main } from "../../src/popup/popup";
import type { Status } from "../../src/background/messages";

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

function kindOf(req: unknown): string {
  if (typeof req !== "object" || req === null) return "";
  if (!("kind" in req) || typeof req.kind !== "string") return "";
  return req.kind;
}

/** A background page that counts failed PIN attempts the way Session does. */
function lockoutResponder(): (req: unknown) => unknown {
  let failed = 0;
  return (req: unknown) => {
    const kind = kindOf(req);
    if (kind === "status") {
      const s: Status = {
        state: "locked",
        lastSyncMs: 1,
        email: "a@b.com",
        serverUrl: "https://vault.example.net",
        pinUnlockAvailable: failed < 5,
        pinAttemptsRemaining: Math.max(0, 5 - failed),
        unlockMode: "pin",
      };
      return s;
    }
    if (kind === "unlock") {
      failed += 1;
      throw new Error("Incorrect PIN");
    }
    throw new Error(`unexpected kind ${kind}`);
  };
}

async function wrongPin(): Promise<void> {
  const root = requireEl("root");
  oneInput(root, "#unlock-pin").value = "000000";
  submitForm(root);
  await vi.waitFor(() => expect(root.querySelector(".error")?.textContent).toMatch(/incorrect/i));
}

beforeEach(() => {
  document.body.innerHTML = SKELETON;
  vi.spyOn(window, "close").mockImplementation(() => {});
  const responder = lockoutResponder();
  vi.stubGlobal("browser", {
    runtime: { sendMessage: vi.fn((req: unknown) => Promise.resolve(responder(req))) },
    tabs: { query: () => Promise.resolve([]) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the lockout warning during a run of wrong PINs", () => {
  it("warns once only two attempts are left", async () => {
    await main();
    const root = requireEl("root");
    expect(root.textContent).not.toMatch(/attempts remaining/i);

    await wrongPin(); // 4 left
    await wrongPin(); // 3 left
    await wrongPin(); // 2 left -- under the threshold, the warning is due

    expect(root.textContent).toMatch(/2 attempts remaining/i);
  });

  // C4's middle column, which is the half that failed on the device. Each
  // reading has to happen without the popup being closed -- reopening it is
  // what hid the bug, because the counter is persisted.
  it("counts down through every warned attempt, alongside the error", async () => {
    await main();
    const root = requireEl("root");

    await wrongPin(); // 4 left, still above the threshold
    expect(root.textContent).not.toMatch(/attempts remaining/i);

    await wrongPin(); // 3 left
    expect(root.textContent).toMatch(/3 attempts remaining/i);

    await wrongPin(); // 2 left
    expect(root.textContent).toMatch(/2 attempts remaining/i);
    expect(root.textContent).not.toMatch(/3 attempts remaining/i);

    await wrongPin(); // 1 left, and the singular
    expect(root.textContent).toMatch(/1 attempt remaining/i);

    // The warning replaces itself; it never buries the error it accompanies.
    expect(root.querySelector(".error")?.textContent).toMatch(/incorrect/i);
  });
});
