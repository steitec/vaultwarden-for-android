import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { keepFocusedFieldVisible, TYPING_CLASS, SCROLL_DELAY_MS } from "../../src/popup/keyboard";

// Seen on the device 2026-11-22: Firefox for Android shows the popup as a
// full-screen page and lays the on-screen keyboard over it without resizing
// it. The editor fits the screen, so the page has no scroll range left, and
// the password field and the save button sit behind the keyboard where no
// amount of scrolling reaches them. The fix gives the page room below its
// content while a field has focus, and scrolls the field to the middle.

describe("keepFocusedFieldVisible", () => {
  let dispose: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom does no layout and has no scrollIntoView; every browser does.
    HTMLElement.prototype.scrollIntoView = vi.fn();
    document.body.innerHTML = `
      <input id="name" type="text" />
      <input id="password" type="password" />
      <select id="pick"><option>a</option></select>
      <textarea id="notes"></textarea>
      <button id="save" type="button">Save</button>
    `;
    dispose = keepFocusedFieldVisible(document);
  });

  afterEach(() => {
    dispose();
    document.body.className = "";
    vi.useRealTimers();
  });

  function el(id: string): HTMLElement {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`missing #${id}`);
    return found;
  }

  it("makes room below the content while a text field has focus", () => {
    el("password").focus();
    expect(document.body.classList.contains(TYPING_CLASS)).toBe(true);
  });

  it("scrolls the focused field to the middle once the keyboard is up", () => {
    const field = el("password");
    const scroll = vi.fn();
    field.scrollIntoView = scroll;

    field.focus();
    // Not at once: the keyboard is still sliding in, and the room it needs
    // only exists after the class has taken effect.
    expect(scroll).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SCROLL_DELAY_MS);
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
  });

  it("counts a textarea as a field", () => {
    el("notes").focus();
    expect(document.body.classList.contains(TYPING_CLASS)).toBe(true);
  });

  it("keeps the room when focus moves straight to the next field", () => {
    el("name").focus();
    el("password").focus();
    vi.advanceTimersByTime(SCROLL_DELAY_MS);
    expect(document.body.classList.contains(TYPING_CLASS)).toBe(true);
  });

  it("takes the room away when no field has focus any more", () => {
    el("password").focus();
    el("password").blur();
    vi.advanceTimersByTime(SCROLL_DELAY_MS);
    expect(document.body.classList.contains(TYPING_CLASS)).toBe(false);
  });

  it("does not scroll a field that lost focus before the keyboard was up", () => {
    const field = el("password");
    const scroll = vi.fn();
    field.scrollIntoView = scroll;

    field.focus();
    field.blur();
    vi.advanceTimersByTime(SCROLL_DELAY_MS);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("ignores a button and a select, which bring up no keyboard", () => {
    el("save").focus();
    expect(document.body.classList.contains(TYPING_CLASS)).toBe(false);
    el("pick").focus();
    expect(document.body.classList.contains(TYPING_CLASS)).toBe(false);
  });

  it("stops listening once disposed", () => {
    dispose();
    el("password").focus();
    expect(document.body.classList.contains(TYPING_CLASS)).toBe(false);
    dispose = () => {};
  });
});
