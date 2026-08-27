import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountBadge, buildGlyph, BADGE_HOST_ATTR } from "../../src/content/badge";

function passwordField(): HTMLInputElement {
  document.body.innerHTML = `<input type="password" id="pw">`;
  const el = document.getElementById("pw");
  if (!(el instanceof HTMLInputElement)) throw new Error("fixture did not render an input");
  return el;
}

function host(): HTMLElement {
  const el = document.querySelector(`[${BADGE_HOST_ATTR}]`);
  if (!(el instanceof HTMLElement)) throw new Error("no badge host in the document");
  return el;
}

function tapBadge(): void {
  host().dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
}

/**
 * jsdom runs no layout engine, so every rect is zero and every badge would
 * land at the origin. These fakes are the only way to say "the field is
 * HERE now, and there it went" — which is the whole of what the badge has
 * to keep up with.
 */
function placeField(field: HTMLInputElement, top: number, right = 300): void {
  field.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + 40,
      left: right - 200,
      right,
      width: 200,
      height: 40,
      x: right - 200,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** The `top` the badge should be parked at for a field placed at `top`. */
function expectedTop(fieldTop: number): string {
  return `${fieldTop + (40 - 24) / 2}px`;
}

/**
 * Stands in for the layout engine's answer to "what is drawn at this point".
 *
 * The order is the real one: topmost FIRST, and everything underneath it
 * follows — covered or not. That is what makes an occlusion check possible
 * at all, and it is also the trap: the field stays in this list when a menu
 * is painted over it, so its mere presence proves nothing. Verified on the
 * device, where a field behind an open menu was still reported at every
 * corner of the badge.
 *
 * jsdom has no elementsFromPoint at all, so a test that wants one installs
 * it and removes it again.
 */
function stackAtBadge(...els: Element[]): void {
  (document as unknown as { elementsFromPoint: unknown }).elementsFromPoint = () => els;
}

/**
 * A layout engine whose answer depends on where it is asked: everything
 * above `edge` is the overlay, everything below it is the field. That is a
 * menu whose lower border cuts across the badge.
 */
function stackSplitAt(edge: number, field: HTMLInputElement, overlay: Element): void {
  (document as unknown as { elementsFromPoint: unknown }).elementsFromPoint = (
    _x: number,
    y: number,
  ) => (y < edge ? [host(), overlay, field] : [host(), field]);
}

function noStack(): void {
  delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
}

/** A ResizeObserver that fires when the test says so, since jsdom has none. */
function fakeResizeObserver(): { fire: () => void; observed: () => unknown[] } {
  const callbacks: (() => void)[] = [];
  const observed: unknown[] = [];
  class FakeResizeObserver {
    constructor(cb: () => void) {
      callbacks.push(cb);
    }
    observe(target: unknown): void {
      observed.push(target);
    }
    disconnect(): void {
      callbacks.length = 0;
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return { fire: () => callbacks.forEach((cb) => cb()), observed: () => observed };
}

beforeEach(() => {
  document.body.innerHTML = "";
  noStack();
  vi.unstubAllGlobals();
});

describe("mountBadge", () => {
  it("mounts a host element into the document", () => {
    mountBadge(passwordField(), "fill", () => {});
    expect(document.querySelectorAll(`[${BADGE_HOST_ATTR}]`)).toHaveLength(1);
  });

  it("reports a tap to the caller", () => {
    const onTap = vi.fn();
    mountBadge(passwordField(), "fill", onTap);
    tapBadge();
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("removes the host when unmounted", () => {
    const unmount = mountBadge(passwordField(), "fill", () => {});
    unmount();
    expect(document.querySelectorAll(`[${BADGE_HOST_ATTR}]`)).toHaveLength(0);
  });

  it("is safe to unmount twice", () => {
    const unmount = mountBadge(passwordField(), "fill", () => {});
    unmount();
    expect(() => unmount()).not.toThrow();
  });

  it("reports nothing after unmounting", () => {
    // The listener is removed with the host rather than left on a detached
    // node: a badge whose page navigated must not still be able to ask for a
    // fill.
    const onTap = vi.fn();
    const unmount = mountBadge(passwordField(), "fill", onTap);
    const detached = host();
    unmount();
    detached.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(onTap).not.toHaveBeenCalled();
  });

  it("stops the click from reaching the page", () => {
    // A page listening on document for clicks must not observe the badge tap.
    // On a login form that would submit the still-empty form before the fill
    // has landed.
    const pageSaw = vi.fn();
    document.addEventListener("click", pageSaw);
    try {
      mountBadge(passwordField(), "fill", () => {});
      tapBadge();
      expect(pageSaw).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("click", pageSaw);
    }
  });

  it("hides its internals from the page", () => {
    // A closed shadow root: page script cannot walk into the badge, so it
    // cannot read the affordance or tamper with the glyph.
    mountBadge(passwordField(), "fill", () => {});
    expect(host().shadowRoot).toBeNull();
  });

  it("labels each mode distinctly for assistive tech", () => {
    const labels = (["fill", "chooser", "unlock"] as const).map((mode) => {
      document.body.innerHTML = "";
      mountBadge(passwordField(), mode, () => {});
      return host().getAttribute("aria-label");
    });
    expect(new Set(labels).size).toBe(3);
    expect(labels.every((l) => typeof l === "string" && l.length > 0)).toBe(true);
  });

  it("records its mode on the host, so a refresh can tell renders apart", () => {
    mountBadge(passwordField(), "unlock", () => {});
    expect(host().getAttribute(BADGE_HOST_ATTR)).toBe("unlock");
  });

  it("carries its own styling rather than inheriting the page's", () => {
    // The page's stylesheet is not a place this addon can control. A badge
    // that inherits `display:none` from a page rule is a badge that silently
    // is not there.
    mountBadge(passwordField(), "fill", () => {});
    expect(host().style.position).toBe("absolute");
    expect(host().style.zIndex).toBe("2147483647");
  });
});

describe("the badge keeps up with its field", () => {
  it("moves with the field when the page scrolls", () => {
    const field = passwordField();
    placeField(field, 500);
    mountBadge(field, "fill", () => {});
    expect(host().style.top).toBe(expectedTop(500));

    placeField(field, 120);
    window.dispatchEvent(new Event("scroll"));

    expect(host().style.top).toBe(expectedTop(120));
  });

  it("moves with the field when the layout shifts without a scroll", () => {
    // The reported case: a menu expands inside a sticky header and pushes the
    // form down. No scroll, no childList mutation — the site toggles one
    // attribute — so this is the only signal there is.
    const resize = fakeResizeObserver();
    const field = passwordField();
    placeField(field, 500);
    mountBadge(field, "fill", () => {});

    placeField(field, 780);
    resize.fire();

    expect(host().style.top).toBe(expectedTop(780));
  });

  it("watches the field and the document, not just the window", () => {
    const resize = fakeResizeObserver();
    const field = passwordField();
    mountBadge(field, "fill", () => {});
    expect(resize.observed()).toContain(field);
    expect(resize.observed()).toContain(document.documentElement);
  });

  it("moves with the field when the viewport resizes", () => {
    const field = passwordField();
    placeField(field, 500);
    mountBadge(field, "fill", () => {});

    placeField(field, 60);
    window.dispatchEvent(new Event("resize"));

    expect(host().style.top).toBe(expectedTop(60));
  });

  it("stops following once it is unmounted", () => {
    // A listener left on the window outlives the badge it was moving and
    // reaches for a field the page may have replaced.
    const field = passwordField();
    placeField(field, 500);
    const unmount = mountBadge(field, "fill", () => {});
    const detached = host();
    unmount();

    placeField(field, 900);
    expect(() => window.dispatchEvent(new Event("scroll"))).not.toThrow();
    expect(detached.style.top).toBe(expectedTop(500));
  });
});

describe("the badge shows itself only where its field is visible", () => {
  it("hides when something is drawn over the field", () => {
    const field = passwordField();
    placeField(field, 500);
    mountBadge(field, "fill", () => {});

    // The field is still in the stack — an engine reports what is behind the
    // overlay too. What changed is that it is no longer the topmost thing.
    const overlay = document.createElement("div");
    stackAtBadge(host(), overlay, field);
    window.dispatchEvent(new Event("scroll"));

    expect(host().style.display).toBe("none");
  });

  it("comes back when the field is clear again", () => {
    const field = passwordField();
    placeField(field, 500);
    mountBadge(field, "fill", () => {});

    stackAtBadge(host(), document.createElement("div"), field);
    window.dispatchEvent(new Event("scroll"));
    stackAtBadge(host(), field);
    window.dispatchEvent(new Event("scroll"));

    expect(host().style.display).not.toBe("none");
  });

  it("stays visible when nothing can answer what is on top", () => {
    // jsdom, and any engine without elementsFromPoint. An unanswerable
    // question must not blank the badge on every page.
    const field = passwordField();
    placeField(field, 500);
    mountBadge(field, "fill", () => {});
    window.dispatchEvent(new Event("scroll"));
    expect(host().style.display).not.toBe("none");
  });

  it("stays visible when the point is outside the viewport entirely", () => {
    // An empty stack is what a real engine returns for a point that is not
    // on screen. The badge is not visible there either way, and treating it
    // as an occlusion would hide a badge that scrolling is about to reveal.
    const field = passwordField();
    placeField(field, 500);
    mountBadge(field, "fill", () => {});

    stackAtBadge();
    window.dispatchEvent(new Event("scroll"));

    expect(host().style.display).not.toBe("none");
  });


  it("hides when only part of it is covered", () => {
    // The badge is 24px tall and centred on the field, so a menu whose lower
    // edge falls between the two leaves the centre clear while the top half
    // is painted over the menu. Asking about the centre alone answers "the
    // field is right there" and shows a badge stuck to the menu's underside.
    const field = passwordField();
    placeField(field, 500);
    mountBadge(field, "fill", () => {});

    // The field's centre is at 520; the badge spans 508..532.
    stackSplitAt(515, field, document.createElement("div"));
    window.dispatchEvent(new Event("scroll"));

    expect(host().style.display).toBe("none");
  });

  it("still fills after the menu has covered its field and gone away again", () => {
    // The whole reported sequence on login.example.com, end to end: the
    // hamburger menu opens, which pushes the form down and paints over it,
    // and then the user closes it again. Hiding the badge is only half of
    // what has to happen — it has to come back as a working control, not as
    // a picture of one.
    //
    // What this can and cannot prove: the display assertion is what says a
    // finger could reach the badge, because jsdom dispatches a click at a
    // hidden element as readily as at a visible one. The tap assertion says
    // the listener survived the round trip — which is what a future change
    // that unmounts the badge while it is covered, and mounts a fresh one
    // afterwards, would break.
    const resize = fakeResizeObserver();
    const field = passwordField();
    placeField(field, 500);
    const onTap = vi.fn();
    mountBadge(field, "fill", onTap);

    // Menu open: the header grew, so the field moved down and is covered.
    placeField(field, 780);
    stackAtBadge(host(), document.createElement("nav"), field);
    resize.fire();
    expect(host().style.display).toBe("none");

    // Menu closed: the field is back where it was, and clear again.
    placeField(field, 500);
    stackAtBadge(host(), field);
    resize.fire();

    expect(host().style.display).not.toBe("none");
    expect(host().style.top).toBe(expectedTop(500));

    tapBadge();
    expect(onTap).toHaveBeenCalledTimes(1);
  });

});

describe("the badge's glyph", () => {
  const MODES = ["fill", "chooser", "unlock"] as const;

  it("draws a different shape for every mode", () => {
    // The three states differ in what a tap does: fill fills the form where
    // it stands, chooser and unlock both send the user into the add-on. A
    // user who cannot tell them apart before tapping learns the difference
    // by tapping and seeing nothing happen.
    const shapes = MODES.map((mode) => buildGlyph(document, mode).outerHTML);
    expect(new Set(shapes).size).toBe(3);
  });

  it("gives chooser the fill lock plus a marker, rather than an unrelated shape", () => {
    // Several matches is still "the vault has this", so it keeps the lock;
    // what it adds is the vertical ellipsis Android uses for an overflow
    // menu, which is the part that says a list is about to open.
    const lock = [...buildGlyph(document, "fill").children].map((c) => c.outerHTML);
    const chooser = [...buildGlyph(document, "chooser").children].map((c) => c.outerHTML);
    expect(chooser).toEqual(expect.arrayContaining(lock));
    expect(chooser.length).toBeGreaterThan(lock.length);
  });

  it("scales with its box rather than with whatever font the device ships", () => {
    // The emoji this replaced were drawn by the system emoji font, so the
    // badge looked like whatever that font had — and at 14px a closed lock
    // and an open one differ by the lean of a shackle.
    for (const mode of MODES) {
      const svg = buildGlyph(document, mode);
      expect(svg.tagName.toLowerCase()).toBe("svg");
      expect(svg.getAttribute("viewBox")).toBeTruthy();
    }
  });

  it("takes its colour from the host, so the badge's own styling reaches it", () => {
    // `color:#ffffff` on the glyph element does nothing to a colour emoji.
    // Drawing with currentColor is what turns that declaration from dead
    // into the thing that makes the glyph white.
    for (const mode of MODES) {
      for (const el of buildGlyph(document, mode).querySelectorAll("*")) {
        for (const attr of ["stroke", "fill"]) {
          const value = el.getAttribute(attr);
          if (value === null) continue;
          expect(value).toMatch(/^(currentColor|none)$/);
        }
      }
    }
  });

  it("draws the glyph rather than typing a character", () => {
    // A page may enforce Trusted Types, under which an innerHTML in a
    // content script throws instead of rendering. Built nodes have no such
    // question, and this is the only seam a test has: the shadow root is
    // closed, so the glyph itself cannot be looked at from out here.
    const created = vi.spyOn(document, "createElementNS");
    try {
      mountBadge(passwordField(), "fill", () => {});
      const tags = created.mock.calls.map(([ns, tag]) => `${String(ns)}|${String(tag)}`);
      expect(tags).toContain("http://www.w3.org/2000/svg|svg");
    } finally {
      created.mockRestore();
    }
  });
});
