import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The module under test registers a browser.runtime.onMessage listener at
// import time (it is injected on demand by the background page). `browser`
// does not exist under jsdom. Static `import` declarations are hoisted
// ahead of any other statement per ES module semantics -- writing
// `vi.stubGlobal` textually above a static `import` does not run it first
// -- so the module must be loaded via a dynamic `import()` after the stub
// is in place. This is a test-environment shim only; the source module
// still assumes the real WebExtension `browser` global at runtime.
//
// The stub also captures the registered listener and fixes `runtime.id`, so
// the sender-verification tests below can invoke the real listener directly
// with a matching or foreign `sender.id`.
const THIS_EXTENSION_ID = "this-extension-id";
let registeredListener:
  | ((msg: unknown, sender: { id?: string }) => unknown)
  | undefined;

// refreshBadge talks to the background page through runtime.sendMessage.
// Each test sets what that answers.
const sendMessage = vi.fn();

vi.stubGlobal("browser", {
  runtime: {
    id: THIS_EXTENSION_ID,
    sendMessage,
    onMessage: {
      addListener: (fn: (msg: unknown, sender: { id?: string }) => unknown) => {
        registeredListener = fn;
      },
    },
  },
});

const { findLoginFields, fillFields, refreshBadge, startObserving, stopPageWatch } =
  await import("../../src/content/autofill");

// Importing the module installs a document watch, exactly as it does in a
// real page. Every test below drives refreshBadge or its own observer
// explicitly, so the module's own one is stopped here rather than left to
// fire into whichever test happens to mutate the DOM.
stopPageWatch();

/** Comfortably past the observer's internal debounce. */
const REFRESH_DEBOUNCE = 400;
const { BADGE_HOST_ATTR } = await import("../../src/content/badge");

function setBody(html: string) {
  document.body.innerHTML = html;
}

beforeEach(() => setBody(""));

// jsdom runs no layout engine, so every getBoundingClientRect() is zero and
// the geometry layer is skipped by design. Tests that need to exercise that
// layer install a prototype stub; this pristine reference plus the afterEach
// below guarantee it cannot leak into any other test even if one throws.
const NATIVE_GET_RECT = HTMLElement.prototype.getBoundingClientRect;
afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = NATIVE_GET_RECT;
});

/**
 * Makes the document behave as if a layout engine had run: the root element
 * reports a real viewport-sized box (which is what un-gates the geometry
 * layer), every element reports a plausible on-screen box, and the elements
 * named in `rects` report whatever the test dictates.
 */
function stubLayout(rects: Record<string, DOMRect>): () => void {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    if (this === document.documentElement) return new DOMRect(0, 0, 1024, 768);
    const override = this.id === "" ? undefined : rects[this.id];
    return override ?? new DOMRect(0, 0, 200, 30);
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = NATIVE_GET_RECT;
  };
}

describe("findLoginFields", () => {
  it("finds a standard username and password pair", () => {
    setBody(`<form><input type="text" name="username"><input type="password" name="password"></form>`);
    const f = findLoginFields(document);
    expect(f.username!.getAttribute("name")).toBe("username");
    expect(f.password!.type).toBe("password");
  });

  it("recognises an email input as the username field", () => {
    setBody(`<form><input type="email" id="email"><input type="password"></form>`);
    expect(findLoginFields(document).username!.id).toBe("email");
  });

  it("handles a password-only step in a multi-step form", () => {
    setBody(`<form><input type="password" name="pass"></form>`);
    const f = findLoginFields(document);
    expect(f.username).toBeNull();
    expect(f.password).not.toBeNull();
  });

  it("handles an email-only first step", () => {
    setBody(`<form><input type="email" name="email"></form>`);
    const f = findLoginFields(document);
    expect(f.username).not.toBeNull();
    expect(f.password).toBeNull();
  });

  it("picks the input immediately before the password field when several text inputs exist", () => {
    setBody(`<form>
      <input type="text" name="search">
      <input type="text" name="user">
      <input type="password" name="pw">
    </form>`);
    expect(findLoginFields(document).username!.getAttribute("name")).toBe("user");
  });

  it("ignores hidden and disabled inputs", () => {
    setBody(`<form>
      <input type="hidden" name="csrf">
      <input type="text" name="user" disabled>
      <input type="text" name="realuser">
      <input type="password" name="pw">
    </form>`);
    expect(findLoginFields(document).username!.getAttribute("name")).toBe("realuser");
  });

  it("returns nulls when there is no login form", () => {
    setBody(`<div>no form here</div>`);
    const f = findLoginFields(document);
    expect(f.username).toBeNull();
    expect(f.password).toBeNull();
  });

  // Decoy fields hidden via a wrapper (not the input itself) must be
  // skipped in favour of the visible field -- asserting only that the
  // decoy is untouched would pass trivially if nothing were selected at
  // all, so each case asserts the VISIBLE field is the one chosen.
  it("skips a password decoy hidden by an ancestor div using display:none", () => {
    setBody(`
      <div style="display:none">
        <input type="text" name="evil-user">
        <input type="password" name="evil-pass" id="evilpass">
      </div>
      <form>
        <input type="text" name="real-user" id="realuser">
        <input type="password" name="real-pass" id="realpass">
      </form>
    `);
    const f = findLoginFields(document);
    expect(f.username!.id).toBe("realuser");
    expect(f.password!.id).toBe("realpass");
  });

  it("skips a decoy hidden by an ancestor div positioned off-screen (visibility:hidden)", () => {
    setBody(`
      <div style="visibility:hidden;position:absolute;left:-9999px;top:-9999px">
        <input type="text" name="evil-user">
        <input type="password" name="evil-pass" id="evilpass">
      </div>
      <form>
        <input type="text" name="real-user" id="realuser">
        <input type="password" name="real-pass" id="realpass">
      </form>
    `);
    const f = findLoginFields(document);
    expect(f.username!.id).toBe("realuser");
    expect(f.password!.id).toBe("realpass");
  });

  it("skips a decoy hidden by an ancestor div with visibility:collapse", () => {
    setBody(`
      <div style="visibility:collapse">
        <input type="text" name="evil-user">
        <input type="password" name="evil-pass" id="evilpass">
      </div>
      <form>
        <input type="text" name="real-user" id="realuser">
        <input type="password" name="real-pass" id="realpass">
      </form>
    `);
    const f = findLoginFields(document);
    expect(f.username!.id).toBe("realuser");
    expect(f.password!.id).toBe("realpass");
  });

  it("skips a decoy hidden by an ancestor div with opacity:0", () => {
    setBody(`
      <div style="opacity:0">
        <input type="text" name="evil-user">
        <input type="password" name="evil-pass" id="evilpass">
      </div>
      <form>
        <input type="text" name="real-user" id="realuser">
        <input type="password" name="real-pass" id="realpass">
      </form>
    `);
    const f = findLoginFields(document);
    expect(f.username!.id).toBe("realuser");
    expect(f.password!.id).toBe("realpass");
  });

  it("skips a decoy hidden by the `hidden` attribute on an ancestor div", () => {
    setBody(`
      <div hidden>
        <input type="text" name="evil-user">
        <input type="password" name="evil-pass" id="evilpass">
      </div>
      <form>
        <input type="text" name="real-user" id="realuser">
        <input type="password" name="real-pass" id="realpass">
      </form>
    `);
    const f = findLoginFields(document);
    expect(f.username!.id).toBe("realuser");
    expect(f.password!.id).toBe("realpass");
  });

  it("scopes the username fallback to the password field's own form, not the whole document", () => {
    setBody(`
      <input type="text" name="unrelated-newsletter-signup">
      <form>
        <input type="password" name="pw">
        <input type="text" name="realuser">
      </form>
    `);
    expect(findLoginFields(document).username!.getAttribute("name")).toBe("realuser");
  });

  it("returns a null username rather than a cross-form guess when no same-form candidate exists", () => {
    setBody(`
      <input type="text" name="unrelated-newsletter-signup">
      <form><input type="password" name="pw"></form>
    `);
    expect(findLoginFields(document).username).toBeNull();
  });
});

// A decoy that is off-screen by *position alone* carries no display,
// visibility, opacity or `hidden` signal whatsoever -- it is an ordinary,
// fully "visible" element as far as those four checks are concerned. This is
// the exploit that shipped past the first visibility fix: the harvester's
// field is the first password input in document order, so it won the
// selection and received the real credential while the field the user was
// looking at stayed empty. Each test below asserts BOTH halves -- decoy empty
// AND real field filled -- because asserting only that the decoy is empty
// would pass trivially if nothing at all were selected.
describe("off-screen decoy fields", () => {
  const CREDS = { username: "u@example.com", password: "hunter2" };

  function expectRealFormWon() {
    const f = findLoginFields(document);
    expect(f.username!.id).toBe("realuser");
    expect(f.password!.id).toBe("realpass");

    const r = fillFields(document, CREDS);
    expect(r).toEqual({ filledUsername: true, filledPassword: true });
    expect(document.querySelector<HTMLInputElement>("#evilpass")!.value).toBe("");
    expect(document.querySelector<HTMLInputElement>("#eviluser")!.value).toBe("");
    expect(document.querySelector<HTMLInputElement>("#realpass")!.value).toBe("hunter2");
    expect(document.querySelector<HTMLInputElement>("#realuser")!.value).toBe("u@example.com");
  }

  const REAL_FORM = `
    <form>
      <input type="text" name="real-user" id="realuser">
      <input type="password" name="real-pass" id="realpass">
    </form>
  `;

  it("does not fill a decoy in an absolutely positioned off-screen wrapper", () => {
    setBody(`
      <div style="position:absolute;left:-9999px;top:-9999px">
        <input type="text" name="evil-user" id="eviluser">
        <input type="password" name="evil-pass" id="evilpass">
      </div>
      ${REAL_FORM}
    `);
    expectRealFormWon();
  });

  it("does not fill a decoy in a fixed-position off-screen wrapper", () => {
    setBody(`
      <div style="position:fixed;left:-5000px">
        <input type="text" name="evil-user" id="eviluser">
        <input type="password" name="evil-pass" id="evilpass">
      </div>
      ${REAL_FORM}
    `);
    expectRealFormWon();
  });

  it("does not fill inputs positioned off-screen directly rather than via a wrapper", () => {
    setBody(`
      <input type="text" name="evil-user" id="eviluser" style="position:absolute;top:-9999px">
      <input type="password" name="evil-pass" id="evilpass" style="position:absolute;top:-9999px">
      ${REAL_FORM}
    `);
    expectRealFormWon();
  });

  it("does not fill a decoy inside a zero-size overflow:hidden wrapper", () => {
    setBody(`
      <div style="width:0;height:0;overflow:hidden">
        <input type="text" name="evil-user" id="eviluser">
        <input type="password" name="evil-pass" id="evilpass">
      </div>
      ${REAL_FORM}
    `);
    expectRealFormWon();
  });

  // The negative control for the threshold. Absolute positioning with a small
  // offset is ordinary layout -- overlays, floating labels, popovers -- and a
  // check that rejected it would break real login pages, which is a worse
  // outcome than the attack it prevents.
  it("still fills an absolutely positioned form with a small, on-screen offset", () => {
    setBody(`
      <form style="position:absolute;left:20px;top:40px">
        <input type="text" name="u" id="realuser">
        <input type="password" name="p" id="realpass">
      </form>
    `);
    const f = findLoginFields(document);
    expect(f.username!.id).toBe("realuser");
    expect(f.password!.id).toBe("realpass");
    expect(fillFields(document, CREDS)).toEqual({ filledUsername: true, filledPassword: true });
    expect(document.querySelector<HTMLInputElement>("#realpass")!.value).toBe("hunter2");
  });

  it("still fills a form whose wrapper is positioned with a non-px or auto offset", () => {
    setBody(`
      <div style="position:absolute;left:auto;top:-2em">
        <form>
          <input type="text" name="u" id="realuser">
          <input type="password" name="p" id="realpass">
        </form>
      </div>
    `);
    expect(fillFields(document, CREDS)).toEqual({ filledUsername: true, filledPassword: true });
    expect(document.querySelector<HTMLInputElement>("#realpass")!.value).toBe("hunter2");
  });
});

// The geometry layer exists for the decoys the CSSOM walk cannot see at all:
// off-screen via a class in an external stylesheet, a transform, a clip-path,
// or a field scrolled out of an overflow container. jsdom never produces such
// geometry on its own, so these tests synthesise it.
describe("off-screen decoy fields detected by rendered geometry", () => {
  const CREDS = { username: "u@example.com", password: "hunter2" };

  const PAGE = `
    <div class="offscreen-via-external-stylesheet">
      <input type="text" name="evil-user" id="eviluser">
      <input type="password" name="evil-pass" id="evilpass">
    </div>
    <form>
      <input type="text" name="real-user" id="realuser">
      <input type="password" name="real-pass" id="realpass">
    </form>
  `;

  it("rejects a field rendered outside the viewport with no CSSOM tell", () => {
    setBody(PAGE);
    const restore = stubLayout({
      eviluser: new DOMRect(-9999, -9999, 200, 30),
      evilpass: new DOMRect(-9999, -9960, 200, 30),
    });
    try {
      const f = findLoginFields(document);
      expect(f.username!.id).toBe("realuser");
      expect(f.password!.id).toBe("realpass");

      fillFields(document, CREDS);
      expect(document.querySelector<HTMLInputElement>("#evilpass")!.value).toBe("");
      expect(document.querySelector<HTMLInputElement>("#realpass")!.value).toBe("hunter2");
    } finally {
      restore();
    }
  });

  it("rejects a field rendered with zero size with no CSSOM tell", () => {
    setBody(PAGE);
    const restore = stubLayout({
      eviluser: new DOMRect(10, 10, 0, 0),
      evilpass: new DOMRect(10, 10, 0, 0),
    });
    try {
      const f = findLoginFields(document);
      expect(f.username!.id).toBe("realuser");
      expect(f.password!.id).toBe("realpass");

      fillFields(document, CREDS);
      expect(document.querySelector<HTMLInputElement>("#evilpass")!.value).toBe("");
      expect(document.querySelector<HTMLInputElement>("#realpass")!.value).toBe("hunter2");
    } finally {
      restore();
    }
  });

  it("rejects a field rendered past the right edge of the viewport", () => {
    setBody(PAGE);
    const restore = stubLayout({
      eviluser: new DOMRect(5000, 10, 200, 30),
      evilpass: new DOMRect(5000, 50, 200, 30),
    });
    try {
      fillFields(document, CREDS);
      expect(document.querySelector<HTMLInputElement>("#evilpass")!.value).toBe("");
      expect(document.querySelector<HTMLInputElement>("#realpass")!.value).toBe("hunter2");
    } finally {
      restore();
    }
  });

  // The complement, and the reason the layer is gated at all: under jsdom the
  // root element reports a zero rect, which means no layout engine ran and
  // every field's zero rect is an artefact rather than evidence. If the
  // geometry layer ran unconditionally it would reject the entire page here
  // and autofill would silently stop working under test -- and, worse, in any
  // real context where layout has not yet been performed.
  it("skips the geometry layer entirely when the document reports no layout", () => {
    setBody(`<form><input type="text" name="u" id="realuser"><input type="password" name="p" id="realpass"></form>`);

    const rootRect = document.documentElement.getBoundingClientRect();
    expect(rootRect.width).toBe(0);
    expect(rootRect.height).toBe(0);
    const fieldRect = document.querySelector("#realpass")!.getBoundingClientRect();
    expect(fieldRect.width).toBe(0);
    expect(fieldRect.height).toBe(0);

    expect(fillFields(document, CREDS)).toEqual({ filledUsername: true, filledPassword: true });
    expect(document.querySelector<HTMLInputElement>("#realpass")!.value).toBe("hunter2");
  });
});

describe("fillFields", () => {
  it("fills both fields and reports what it filled", () => {
    setBody(`<form><input type="text" name="u"><input type="password" name="p"></form>`);
    const r = fillFields(document, { username: "octocat", password: "hunter2" });
    expect(r).toEqual({ filledUsername: true, filledPassword: true });
    expect(document.querySelector<HTMLInputElement>('[name="u"]')!.value).toBe("octocat");
    expect(document.querySelector<HTMLInputElement>('[name="p"]')!.value).toBe("hunter2");
  });

  it("dispatches input and change events so frameworks observe the value", () => {
    setBody(`<form><input type="text" name="u"><input type="password" name="p"></form>`);
    const input = document.querySelector<HTMLInputElement>('[name="u"]')!;
    const seen: string[] = [];
    input.addEventListener("input", () => seen.push("input"));
    input.addEventListener("change", () => seen.push("change"));

    fillFields(document, { username: "octocat", password: null });
    expect(seen).toEqual(["input", "change"]);
  });

  it("uses the native value setter rather than assigning the property", () => {
    setBody(`<form><input type="text" name="u"><input type="password" name="p"></form>`);
    const input = document.querySelector<HTMLInputElement>('[name="u"]')!;

    // Emulate React's value tracking: shadow the property on the instance.
    let shadowed = "";
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => shadowed,
      set: () => { /* a framework would discard a direct assignment */ },
    });

    fillFields(document, { username: "octocat", password: null });

    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.get!;
    expect(native.call(input)).toBe("octocat");
  });

  it("reports false for a field that is not present", () => {
    setBody(`<form><input type="password" name="p"></form>`);
    expect(fillFields(document, { username: "octocat", password: "hunter2" }))
      .toEqual({ filledUsername: false, filledPassword: true });
  });

  it("skips a null credential without clearing the field", () => {
    setBody(`<form><input type="text" name="u" value="existing"><input type="password" name="p"></form>`);
    fillFields(document, { username: null, password: "hunter2" });
    expect(document.querySelector<HTMLInputElement>('[name="u"]')!.value).toBe("existing");
  });

  it("skips a null password without clearing an existing password field", () => {
    setBody(`<form><input type="text" name="u"><input type="password" name="p" value="oldpw"></form>`);
    fillFields(document, { username: "octocat", password: null });
    expect(document.querySelector<HTMLInputElement>('[name="p"]')!.value).toBe("oldpw");
  });

  it("does not throw and fills nothing when both credentials are null", () => {
    setBody(`<form><input type="text" name="u" value="existing"><input type="password" name="p" value="oldpw"></form>`);
    const r = fillFields(document, { username: null, password: null });
    expect(r).toEqual({ filledUsername: false, filledPassword: false });
    expect(document.querySelector<HTMLInputElement>('[name="u"]')!.value).toBe("existing");
    expect(document.querySelector<HTMLInputElement>('[name="p"]')!.value).toBe("oldpw");
  });
});

describe("onMessage listener (sender verification)", () => {
  it("ignores a fill message from a foreign sender (a different installed extension)", async () => {
    setBody(`<form><input type="text" name="u"><input type="password" name="p"></form>`);
    const result = await registeredListener!(
      { kind: "fill", username: "octocat", password: "hunter2" },
      { id: "some-other-extensions-id" },
    );
    expect(result).toBeUndefined();
    expect(document.querySelector<HTMLInputElement>('[name="u"]')!.value).toBe("");
    expect(document.querySelector<HTMLInputElement>('[name="p"]')!.value).toBe("");
  });

  it("acts on a fill message whose sender is this extension itself", async () => {
    setBody(`<form><input type="text" name="u"><input type="password" name="p"></form>`);
    const result = await registeredListener!(
      { kind: "fill", username: "octocat", password: "hunter2" },
      { id: THIS_EXTENSION_ID },
    );
    expect(result).toEqual({ filledUsername: true, filledPassword: true });
    expect(document.querySelector<HTMLInputElement>('[name="u"]')!.value).toBe("octocat");
  });
});

describe("refreshBadge", () => {
  function badge(): HTMLElement | null {
    const el = document.querySelector(`[${BADGE_HOST_ATTR}]`);
    return el instanceof HTMLElement ? el : null;
  }

  function tapBadge(): void {
    badge()?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
  }

  beforeEach(() => {
    sendMessage.mockReset();
    setBody("");
  });

  it("renders nothing on a page with no password field", async () => {
    setBody(`<input type="text" name="q">`);
    sendMessage.mockResolvedValue({ state: "unlocked", items: [] });

    await refreshBadge(document);

    expect(badge()).toBeNull();
    // Not merely "no badge": a page with no login form must not cause the
    // background page to be asked about it at all. Otherwise every page the
    // user opens becomes a message.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("renders nothing when the vault is unlocked and nothing matches", async () => {
    setBody(`<input type="password">`);
    sendMessage.mockResolvedValue({ state: "unlocked", items: [] });

    await refreshBadge(document);

    expect(badge()).toBeNull();
  });

  it("renders a fill badge for exactly one match", async () => {
    setBody(`<input type="password">`);
    sendMessage.mockResolvedValue({ state: "unlocked", items: [{ id: "a", name: "Router" }] });

    await refreshBadge(document);

    expect(badge()?.getAttribute(BADGE_HOST_ATTR)).toBe("fill");
  });

  it("renders a chooser badge for several matches", async () => {
    setBody(`<input type="password">`);
    sendMessage.mockResolvedValue({
      state: "unlocked",
      items: [
        { id: "a", name: "One" },
        { id: "b", name: "Two" },
      ],
    });

    await refreshBadge(document);

    expect(badge()?.getAttribute(BADGE_HOST_ATTR)).toBe("chooser");
  });

  it("renders an unlock badge when locked, without knowing whether anything matches", async () => {
    setBody(`<input type="password">`);
    sendMessage.mockResolvedValue({ state: "locked" });

    await refreshBadge(document);

    expect(badge()?.getAttribute(BADGE_HOST_ATTR)).toBe("unlock");
  });

  it("asks the background page to fill when a single-match badge is tapped", async () => {
    setBody(`<input type="password">`);
    sendMessage.mockResolvedValue({ state: "unlocked", items: [{ id: "a", name: "Router" }] });
    await refreshBadge(document);
    sendMessage.mockClear();

    tapBadge();

    expect(sendMessage).toHaveBeenCalledWith({ kind: "fillFromPage", itemId: "a" });
  });

  it("hands off to the popup when several entries match", async () => {
    // Nothing on the page can choose between two entries for one domain.
    setBody(`<input type="password">`);
    sendMessage.mockResolvedValue({
      state: "unlocked",
      items: [
        { id: "a", name: "One" },
        { id: "b", name: "Two" },
      ],
    });
    await refreshBadge(document);
    sendMessage.mockClear();

    tapBadge();

    expect(sendMessage).toHaveBeenCalledWith({ kind: "handOff" });
  });

  it("hands off to the popup when the vault is locked", async () => {
    setBody(`<input type="password">`);
    sendMessage.mockResolvedValue({ state: "locked" });
    await refreshBadge(document);
    sendMessage.mockClear();

    tapBadge();

    expect(sendMessage).toHaveBeenCalledWith({ kind: "handOff" });
  });

  it("never sends a credential-bearing message from the page", async () => {
    // The content script's whole security story is that it holds nothing.
    // What it may send is an item id and a request to hand off, never a
    // password, and never an id it was not given by the background page.
    setBody(`<input type="password">`);
    sendMessage.mockResolvedValue({ state: "unlocked", items: [{ id: "a", name: "Router" }] });
    await refreshBadge(document);
    tapBadge();

    for (const [msg] of sendMessage.mock.calls) {
      expect(JSON.stringify(msg)).not.toMatch(/password/i);
    }
  });

  it("replaces a previous badge rather than stacking a second one", async () => {
    setBody(`<input type="password">`);
    sendMessage.mockResolvedValue({ state: "unlocked", items: [{ id: "a", name: "Router" }] });

    await refreshBadge(document);
    await refreshBadge(document);

    expect(document.querySelectorAll(`[${BADGE_HOST_ATTR}]`)).toHaveLength(1);
  });

  it("removes the badge when the page stops offering a password field", async () => {
    setBody(`<input type="password">`);
    sendMessage.mockResolvedValue({ state: "unlocked", items: [{ id: "a", name: "Router" }] });
    await refreshBadge(document);
    expect(badge()).not.toBeNull();

    setBody(`<p>signed in</p>`);
    await refreshBadge(document);

    expect(badge()).toBeNull();
  });

  it("renders nothing when the background page rejects", async () => {
    // A locked-out or mid-restart background page must leave the page alone
    // rather than throwing out of a content script on somebody's site.
    setBody(`<input type="password">`);
    sendMessage.mockRejectedValue(new Error("Vault is locked"));

    await expect(refreshBadge(document)).resolves.toBeUndefined();

    expect(badge()).toBeNull();
  });

  it("does not throw out of the page when a fill is refused", async () => {
    setBody(`<input type="password">`);
    sendMessage.mockResolvedValue({ state: "unlocked", items: [{ id: "a", name: "Router" }] });
    await refreshBadge(document);
    sendMessage.mockRejectedValue(new Error("Refusing to fill on an insecure page."));

    expect(() => tapBadge()).not.toThrow();
  });
});

describe("the module-scope lookup", () => {
  it("looks for a login form as soon as the module is evaluated", async () => {
    // The declared content script's only entry point is the call at module
    // scope. It runs while the rest of the module body is still being
    // evaluated, so anything it touches that is declared with let/const
    // BELOW it sits in the temporal dead zone -- and the resulting
    // ReferenceError is swallowed by the `void`, leaving no badge, no error
    // and no clue.
    //
    // Every other test in this file calls refreshBadge() by hand, long after
    // evaluation has finished and the dead zone is over. That is why this is
    // the one path they cannot cover, and it is the path that shipped broken.
    vi.resetModules();
    document.body.innerHTML = `<input type="password">`;
    sendMessage.mockReset();
    sendMessage.mockResolvedValue({ state: "unlocked", items: [] });

    const fresh = await import("../../src/content/autofill");

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ kind: "matches" }));

    // This evaluation installed its own document watch. Leaving it running
    // would have it fire into every test that runs after this one.
    fresh.stopPageWatch();
  });
});

describe("startObserving", () => {
  function badge(): HTMLElement | null {
    const el = document.querySelector(`[${BADGE_HOST_ATTR}]`);
    return el instanceof HTMLElement ? el : null;
  }

  let stopCurrent: (() => void) | null = null;

  function observe(): void {
    stopCurrent = startObserving(document);
  }

  beforeEach(() => {
    sendMessage.mockReset();
    setBody("");
  });

  afterEach(() => {
    // Registered here rather than at the end of each test: a test that fails
    // before its own stop() would otherwise leak a live observer into every
    // test after it, and the resulting failures point everywhere but here.
    stopCurrent?.();
    stopCurrent = null;
    vi.useRealTimers();
  });

  it("renders a badge for a form that mounts after the page settled", async () => {
    // The case a one-shot lookup at document_idle misses entirely: a
    // single-page app that renders its login form later.
    vi.useFakeTimers();
    sendMessage.mockResolvedValue({ state: "unlocked", items: [{ id: "a", name: "Router" }] });
    observe();

    setBody(`<input type="password">`);
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE);

    expect(badge()).not.toBeNull();
  });

  it("coalesces mutations arriving in separate batches into one lookup", async () => {
    // A framework render mutates the DOM repeatedly as it works. One
    // background message per batch would be a message storm on every page the
    // user opens, on a phone.
    //
    // The awaits are the whole point: a MutationObserver already coalesces
    // everything done in ONE microtask into a single callback, so a loop
    // without them proves nothing about this debounce -- it passes just as
    // well with the debounce removed. Yielding between mutations is what
    // makes the observer fire repeatedly and puts the timer reset under test.
    vi.useFakeTimers();
    setBody(`<input type="password">`);
    sendMessage.mockResolvedValue({ state: "unlocked", items: [] });
    observe();

    for (let i = 0; i < 5; i++) {
      document.body.appendChild(document.createElement("div"));
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE);

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not react to the badge it mounted itself", async () => {
    // refreshBadge appends the badge host, which is itself a mutation.
    // Reacting to it would schedule another lookup after every render,
    // forever.
    vi.useFakeTimers();
    setBody(`<input type="password">`);
    sendMessage.mockResolvedValue({ state: "unlocked", items: [{ id: "a", name: "Router" }] });
    observe();

    document.body.appendChild(document.createElement("div"));
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE);
    const afterFirst = sendMessage.mock.calls.length;

    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE * 4);

    expect(sendMessage.mock.calls.length).toBe(afterFirst);
  });

  it("stops looking once disconnected", async () => {
    vi.useFakeTimers();
    sendMessage.mockResolvedValue({ state: "unlocked", items: [] });
    observe();
    stopCurrent?.();

    setBody(`<input type="password">`);
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE * 4);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("drops a lookup that was still pending when it was stopped", async () => {
    // disconnect() discards records the observer has not delivered yet, but
    // it does nothing about a timer that has already been scheduled -- that
    // has to be cleared alongside it.
    //
    // The await is load-bearing: without it the observer callback has not run
    // by the time stop() is called, there is no timer yet, and the test
    // passes for a reason that has nothing to do with what it claims.
    vi.useFakeTimers();
    sendMessage.mockResolvedValue({ state: "unlocked", items: [] });
    observe();

    setBody(`<input type="password">`);
    await Promise.resolve();
    stopCurrent?.();
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE * 4);

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
