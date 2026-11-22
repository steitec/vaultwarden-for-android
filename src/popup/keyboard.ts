/**
 * Keeps the field being typed into above the on-screen keyboard.
 *
 * Firefox for Android shows the popup as a full-screen page and lays the
 * keyboard over it without resizing it. A screen that fits the display, such
 * as the editor, then has no scroll range left: the fields below the
 * keyboard's top edge cannot be reached at all. Seen on the device
 * 2026-11-22 with the password field of the editor.
 *
 * While a text field has focus, the body gets room below its content (see
 * `body.typing` in popup.css), and once the keyboard is up the field is
 * scrolled to the middle of the screen. This does not depend on whether a
 * given Firefox resizes the viewport or not, so it cannot fight a later fix
 * on Firefox's side.
 */

export const TYPING_CLASS = "typing";

/** Long enough for the keyboard to slide in and the room to exist. */
export const SCROLL_DELAY_MS = 300;

/** Input types that bring up no keyboard. */
const NO_KEYBOARD = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function bringsUpKeyboard(target: EventTarget | null): target is HTMLElement {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return !NO_KEYBOARD.has(target.type);
  return false;
}

/** Installs the listeners on `doc`; the returned function removes them. */
export function keepFocusedFieldVisible(doc: Document): () => void {
  let pending: ReturnType<typeof setTimeout> | undefined;

  const cancel = (): void => {
    if (pending !== undefined) clearTimeout(pending);
    pending = undefined;
  };

  const onFocusIn = (e: FocusEvent): void => {
    const field = e.target;
    if (!bringsUpKeyboard(field)) return;
    doc.body.classList.add(TYPING_CLASS);
    cancel();
    pending = setTimeout(() => {
      pending = undefined;
      if (doc.activeElement === field) field.scrollIntoView({ block: "center" });
    }, SCROLL_DELAY_MS);
  };

  const onFocusOut = (e: FocusEvent): void => {
    // Moving straight to the next field keeps the room; taking it away and
    // giving it back would make the page jump on every "Next".
    if (bringsUpKeyboard(e.relatedTarget)) return;
    cancel();
    doc.body.classList.remove(TYPING_CLASS);
  };

  doc.addEventListener("focusin", onFocusIn);
  doc.addEventListener("focusout", onFocusOut);
  return () => {
    cancel();
    doc.removeEventListener("focusin", onFocusIn);
    doc.removeEventListener("focusout", onFocusOut);
  };
}
