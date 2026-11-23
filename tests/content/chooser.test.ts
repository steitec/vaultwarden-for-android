import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountChooser, CHOOSER_HOST_ATTR, ROW_PX } from "../../src/content/chooser";
import { BADGE_HOST_ATTR } from "../../src/content/badge";

// jsdom cannot produce a trusted event: every click a test dispatches has
// `isTrusted === false`, exactly like one a page script makes up. The check
// is therefore swapped for a flag here. tests/content/gesture.test.ts runs
// the real one.
const gesture = vi.hoisted(() => ({ trusted: true }));
vi.mock("../../src/content/gesture", () => ({ isUserGesture: () => gesture.trusted }));

type Entry = { id: string; name: string; username: string | null; undecryptable: boolean };

const TWO: Entry[] = [
  { id: "a", name: "Router admin", username: "admin", undecryptable: false },
  { id: "b", name: "Router guest", username: null, undecryptable: false },
];

/**
 * The list's shadow root is closed, as the badge's is, so a page cannot read
 * the entry names out of it. The test reaches in by recording what
 * attachShadow returned — a test-only shim; the module still attaches a
 * closed root.
 */
let roots: ShadowRoot[] = [];
const NATIVE_ATTACH = HTMLElement.prototype.attachShadow;

beforeEach(() => {
  document.body.innerHTML = `<input type="password" id="pw">`;
  roots = [];
  HTMLElement.prototype.attachShadow = function (this: HTMLElement, init: ShadowRootInit) {
    const root = NATIVE_ATTACH.call(this, init);
    roots.push(root);
    return root;
  };
});

afterEach(() => {
  HTMLElement.prototype.attachShadow = NATIVE_ATTACH;
  document.body.innerHTML = "";
});

function field(): HTMLInputElement {
  const el = document.getElementById("pw");
  if (!(el instanceof HTMLInputElement)) throw new Error("fixture did not render an input");
  return el;
}

function host(): HTMLElement | null {
  const el = document.querySelector(`[${CHOOSER_HOST_ATTR}]`);
  return el instanceof HTMLElement ? el : null;
}

function rows(): HTMLElement[] {
  const root = roots.at(-1);
  if (root === undefined) throw new Error("no shadow root attached");
  return [...root.querySelectorAll<HTMLElement>("[role=menuitem]")];
}

function tap(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
}

function placeField(top: number, left = 20, width = 200, height = 40): void {
  field().getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      left,
      right: left + width,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("mountChooser", () => {
  it("lists one row per entry, with name and username", () => {
    mountChooser(field(), TWO, vi.fn(), vi.fn());

    const texts = rows().map((r) => r.textContent);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("Router admin");
    expect(texts[0]).toContain("admin");
    expect(texts[1]).toContain("Router guest");
    expect(texts[1]).toContain("No username");
  });

  it("attaches a closed shadow root, so the page cannot read the names", () => {
    mountChooser(field(), TWO, vi.fn(), vi.fn());

    expect(host()?.shadowRoot).toBeNull();
    expect(roots.at(-1)?.mode).toBe("closed");
  });

  it("is a menu for assistive technology", () => {
    mountChooser(field(), TWO, vi.fn(), vi.fn());

    const root = roots.at(-1);
    expect(root?.querySelector("[role=menu]")).not.toBeNull();
  });

  it("reports the tapped entry's id and closes", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    mountChooser(field(), TWO, onPick, onClose);

    const second = rows()[1];
    if (second === undefined) throw new Error("no second row");
    tap(second);

    expect(onPick).toHaveBeenCalledWith("b");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(host()).toBeNull();
  });

  it("keeps a tap on a row away from the page", () => {
    const pageSaw = vi.fn();
    document.body.addEventListener("click", pageSaw);
    mountChooser(field(), TWO, vi.fn(), vi.fn());

    const first = rows()[0];
    if (first === undefined) throw new Error("no first row");
    tap(first);

    expect(pageSaw).not.toHaveBeenCalled();
    document.body.removeEventListener("click", pageSaw);
  });

  it("ignores a row tap that was not the user's (F-10)", () => {
    const onPick = vi.fn();
    mountChooser(field(), TWO, onPick, vi.fn());
    const first = rows()[0];
    if (first === undefined) throw new Error("no first row");

    gesture.trusted = false;
    try {
      tap(first);
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    } finally {
      gesture.trusted = true;
    }

    expect(onPick).not.toHaveBeenCalled();
    expect(host()).not.toBeNull();
  });

  it("shows an undecryptable entry disabled, and a tap on it does nothing", () => {
    const onPick = vi.fn();
    mountChooser(
      field(),
      [...TWO, { id: "c", name: "Broken", username: null, undecryptable: true }],
      onPick,
      vi.fn(),
    );

    const broken = rows()[2];
    if (broken === undefined) throw new Error("no third row");
    expect(broken.getAttribute("aria-disabled")).toBe("true");
    expect(broken.textContent).toContain("Could not be decrypted");

    tap(broken);

    expect(onPick).not.toHaveBeenCalled();
    expect(host()).not.toBeNull();
  });

  it("closes on a tap anywhere else on the page", () => {
    const onClose = vi.fn();
    mountChooser(field(), TWO, vi.fn(), onClose);

    tap(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(host()).toBeNull();
  });

  it("leaves a tap on the badge to the badge, which toggles the list itself", () => {
    const badge = document.createElement("div");
    badge.setAttribute(BADGE_HOST_ATTR, "chooser");
    document.body.appendChild(badge);
    const onClose = vi.fn();
    mountChooser(field(), TWO, vi.fn(), onClose);

    tap(badge);

    expect(onClose).not.toHaveBeenCalled();
    expect(host()).not.toBeNull();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    mountChooser(field(), TWO, vi.fn(), onClose);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(host()).toBeNull();
  });

  it("unmounts without reporting a close, and only once", () => {
    const onClose = vi.fn();
    const unmount = mountChooser(field(), TWO, vi.fn(), onClose);

    unmount();
    unmount();
    tap(document.body);

    expect(host()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("sits under the field, aligned to its left edge", () => {
    placeField(100, 20, 300);
    mountChooser(field(), TWO, vi.fn(), vi.fn());

    expect(host()?.style.top).toBe("144px");
    expect(host()?.style.left).toBe("20px");
    expect(host()?.style.width).toBe("300px");
  });

  it("is never narrower than 220px", () => {
    placeField(100, 20, 120);
    mountChooser(field(), TWO, vi.fn(), vi.fn());

    expect(host()?.style.width).toBe("220px");
  });

  it("flips above the field when there is no room below", () => {
    const height = window.innerHeight;
    placeField(height - 60);
    mountChooser(field(), TWO, vi.fn(), vi.fn());

    const listHeight = 2 * ROW_PX + 8;
    expect(host()?.style.top).toBe(`${height - 60 - 4 - listHeight}px`);
  });

  it("follows the field when the page scrolls", () => {
    placeField(100);
    mountChooser(field(), TWO, vi.fn(), vi.fn());

    placeField(300);
    window.dispatchEvent(new Event("scroll"));

    expect(host()?.style.top).toBe("344px");
  });
});
