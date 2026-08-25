import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountBadge, BADGE_HOST_ATTR } from "../../src/content/badge";

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

beforeEach(() => {
  document.body.innerHTML = "";
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
