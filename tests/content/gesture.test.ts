import { describe, it, expect } from "vitest";
import { isUserGesture } from "../../src/content/gesture";

describe("isUserGesture", () => {
  it("refuses a click a script dispatched", () => {
    // What a page's own script can do to the badge host: it is in the page's
    // DOM. Such an event is never trusted, in a browser or here.
    expect(isUserGesture(new MouseEvent("click", { bubbles: true, composed: true }))).toBe(false);
  });

  it("refuses a click from element.click()", () => {
    const el = document.createElement("div");
    let seen: Event | null = null;
    el.addEventListener("click", (e) => (seen = e));
    el.click();
    expect(seen).not.toBeNull();
    expect(isUserGesture(seen as unknown as Event)).toBe(false);
  });
});
