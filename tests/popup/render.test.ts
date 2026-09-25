import { describe, it, expect, beforeEach } from "vitest";
// A plain static import, with no `browser` stub anywhere in this file. That
// is itself an assertion: importing the popup module must be completely
// inert — no request fired, no listener registered, no WebExtension API
// touched — or these tests could not run at all. See the readyState guard at
// the bottom of popup.ts.
import { renderList, renderStatus, renderMessage } from "../../src/popup/popup";
import type { ItemSummary, Status } from "../../src/background/messages";

function requireEl(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found;
}

function one(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`no HTMLElement matching ${selector}`);
  return found;
}

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = `<div id="root"></div>`;
  root = requireEl("root");
});

/** A Status with the fields renderStatus does not care about filled in. */
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

const github: ItemSummary = {
  id: "1",
  name: "GitHub",
  username: "octocat",
  hasTotp: true,
  undecryptable: false,
  editable: true,
};
const bare: ItemSummary = {
  id: "2",
  name: "Bare",
  username: null,
  hasTotp: false,
  undecryptable: false,
  editable: true,
};
const items: ItemSummary[] = [github, bare];

describe("renderList", () => {
  it("renders one row per item with name and username", () => {
    renderList(items, root);
    const rows = root.querySelectorAll(".item");
    expect(rows).toHaveLength(2);
    expect(one(rows[0] ?? root, ".item-name").textContent).toBe("GitHub");
    expect(one(rows[0] ?? root, ".item-username").textContent).toBe("octocat");
  });

  it("carries the item id for click handling", () => {
    renderList(items, root);
    expect(one(root, ".item").dataset.id).toBe("1");
  });

  it("marks items that have a totp code", () => {
    renderList(items, root);
    const rows = root.querySelectorAll(".item");
    expect(rows[0]?.querySelector(".item-totp")).not.toBeNull();
    expect(rows[1]?.querySelector(".item-totp")).toBeNull();
  });

  it("replaces the previous list instead of appending to it", () => {
    renderList(items, root);
    renderList([github], root);
    expect(root.querySelectorAll(".item")).toHaveLength(1);
  });

  it("shows an empty state rather than a blank panel", () => {
    renderList([], root);
    expect(root.textContent).toMatch(/no matching entries/i);
  });

  it("flags undecryptable items visibly", () => {
    renderList(
      [
        {
          id: "3",
          name: "⚠ This item cannot be decrypted",
          username: null,
          hasTotp: false,
          undecryptable: true,
          editable: false,
        },
      ],
      root,
    );
    expect(root.querySelector(".item.undecryptable")).not.toBeNull();
  });

  it("escapes item names rather than injecting markup", () => {
    renderList(
      [
        {
          id: "4",
          name: "<img src=x onerror=alert(1)>",
          username: null,
          hasTotp: false,
          undecryptable: false,
          editable: true,
        },
      ],
      root,
    );
    expect(root.querySelector("img")).toBeNull();
    expect(one(root, ".item-name").textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("escapes item usernames too, not just names", () => {
    // The username is exactly as attacker-influenced as the name: both are
    // decrypted cipher fields, and a shared-organisation item is written by
    // someone else.
    renderList(
      [
        {
          id: "5",
          name: "Shared",
          username: "<script>alert(1)</script>",
          hasTotp: false,
          undecryptable: false,
          editable: true,
        },
      ],
      root,
    );
    expect(root.querySelector("script")).toBeNull();
    expect(one(root, ".item-username").textContent).toBe("<script>alert(1)</script>");
  });
});

describe("renderStatus", () => {
  it("shows the offline age when a sync time is known", () => {
    renderStatus(status({ lastSyncMs: Date.now() - 3600_000 }), root);
    expect(root.textContent).toMatch(/last synced/i);
  });

  it("says never synced when there is no sync time", () => {
    renderStatus(status({ lastSyncMs: null }), root);
    expect(root.textContent).toMatch(/never synced/i);
  });

  it("reports the lock state, not only the sync age", () => {
    renderStatus(status({ state: "locked", email: null }), root);
    expect(root.textContent).toMatch(/locked/i);

    renderStatus(status({ state: "empty", email: null }), root);
    expect(root.textContent).toMatch(/not set up/i);

    renderStatus(status({ lastSyncMs: Date.now(), email: null }), root);
    expect(root.textContent).toMatch(/unlocked/i);
  });

  it("escapes the account email rather than injecting markup", () => {
    renderStatus(status({ email: "<img src=x onerror=alert(1)>@b.com" }), root);
    expect(root.querySelector("img")).toBeNull();
    expect(one(root, ".status-email").textContent).toBe("<img src=x onerror=alert(1)>@b.com");
  });

  it("omits the email line entirely when there is no account", () => {
    renderStatus(status({ state: "empty", email: null }), root);
    expect(root.querySelector(".status-email")).toBeNull();
  });

  it("replaces the previous header instead of appending to it", () => {
    renderStatus(status({ state: "locked" }), root);
    renderStatus(status({ state: "locked" }), root);
    expect(root.querySelectorAll(".status-state")).toHaveLength(1);
  });
});

describe("renderMessage", () => {
  it("marks error tone distinctly and escapes the text", () => {
    renderMessage("<b>boom</b>", root, "error");
    expect(root.querySelector("b")).toBeNull();
    expect(one(root, ".message-error").textContent).toBe("<b>boom</b>");
  });
});
