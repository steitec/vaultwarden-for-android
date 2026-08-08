const USERNAME_SELECTOR = [
  'input[type="text"]',
  'input[type="email"]',
  'input[type="tel"]',
  "input:not([type])",
].join(",");

/**
 * Walks the element and every ancestor, rejecting if any of them is hidden
 * via the `hidden` attribute, `display: none`, `visibility: hidden`/
 * `collapse`, or `opacity: 0`. Checking only the element itself would miss
 * the common decoy pattern where the *wrapper* is hidden and the input
 * inside it is not: an off-screen or invisible field that still passes a
 * plain per-element check would silently receive the real credential
 * instead of the field the user can actually see.
 *
 * Deliberately does not use `getBoundingClientRect()` to catch off-screen
 * positioning: jsdom performs no layout, so every element's rect is zero,
 * and an unconditional geometry check would reject every field under test.
 * The four CSSOM/DOM checks above are enough to catch the decoy patterns in
 * practice (off-screen wrappers are conventionally hidden via one of these,
 * not just positioned away) and jsdom models all four correctly.
 */
function isVisible(el: Element): boolean {
  let node: Element | null = el;
  const view = el.ownerDocument.defaultView;
  while (node !== null) {
    if (node instanceof HTMLElement && node.hidden) return false;
    const style = view?.getComputedStyle(node);
    if (style !== undefined) {
      if (style.display === "none") return false;
      if (style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (style.opacity === "0") return false;
    }
    node = node.parentElement;
  }
  return true;
}

function isUsable(el: HTMLInputElement): boolean {
  return !el.disabled && !el.readOnly && el.type !== "hidden" && isVisible(el);
}

export function findLoginFields(doc: Document): {
  username: HTMLInputElement | null;
  password: HTMLInputElement | null;
} {
  const password =
    Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="password"]')).find(isUsable) ??
    null;

  const candidates = Array.from(doc.querySelectorAll<HTMLInputElement>(USERNAME_SELECTOR)).filter(
    isUsable,
  );

  if (password === null) {
    return { username: candidates[0] ?? null, password: null };
  }

  // Scope the fallback candidate to the password field's own form. Without
  // this, a password-first form with no preceding same-form text input would
  // fall back to the first usable text input anywhere in the document --
  // e.g. an unrelated newsletter-signup field above the form -- which is a
  // wrong-but-plausible guess that is worse than filling nothing, since it
  // looks like it worked. If the password isn't inside a <form> at all,
  // there's no structural boundary to scope to, so every candidate stays in
  // scope (matches prior behaviour for form-less SPA login pages).
  const passwordForm = password.closest("form");
  const inScopeCandidates =
    passwordForm === null ? candidates : candidates.filter((c) => c.closest("form") === passwordForm);

  // The username field is normally the last usable text input preceding the
  // password field. Falling back to the first in-scope candidate covers
  // forms whose password input is rendered before the username input.
  const before = inScopeCandidates.filter(
    (c) => c.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  return { username: before[before.length - 1] ?? inScopeCandidates[0] ?? null, password };
}

/**
 * Assigning `input.value = x` is silently discarded by React and Vue, which
 * shadow the property to track changes. Invoking the prototype's native setter
 * and then dispatching input and change is what makes the framework observe it.
 */
function setValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function fillFields(
  doc: Document,
  credentials: { username: string | null; password: string | null },
): { filledUsername: boolean; filledPassword: boolean } {
  const fields = findLoginFields(doc);

  let filledUsername = false;
  if (fields.username !== null && credentials.username !== null) {
    setValue(fields.username, credentials.username);
    filledUsername = true;
  }

  let filledPassword = false;
  if (fields.password !== null && credentials.password !== null) {
    setValue(fields.password, credentials.password);
    filledPassword = true;
  }

  return { filledUsername, filledPassword };
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

type FillMessage = { kind: "fill"; username: string | null; password: string | null };

// Explicit runtime narrowing rather than a cast: `msg` from
// browser.runtime.onMessage is untyped (`unknown`) at the API boundary, and
// this codebase does not use `as` to force a shape onto unvalidated data.
function isFillMessage(v: unknown): v is FillMessage {
  if (typeof v !== "object" || v === null) return false;
  if (!("kind" in v) || v.kind !== "fill") return false;
  if (!("username" in v) || !isNullableString(v.username)) return false;
  if (!("password" in v) || !isNullableString(v.password)) return false;
  return true;
}

// Injected on demand by the background page, which then sends the credentials.
//
// Page JavaScript cannot reach this listener under MV2 -- content scripts
// and pages are isolated worlds, and this listener is never registered
// statically (see manifest.json's absent content_scripts). The threat this
// sender check closes is a *different installed extension* that has
// discovered this extension's ID (visible in about:debugging) and sends a
// forged { kind: "fill" } message to exfiltrate whatever credential the
// background page would have supplied.
browser.runtime.onMessage.addListener((msg: unknown, sender: browser.runtime.MessageSender) => {
  if (sender.id !== browser.runtime.id) return undefined;
  if (!isFillMessage(msg)) return undefined;
  return Promise.resolve(fillFields(document, { username: msg.username, password: msg.password }));
});
