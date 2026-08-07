const USERNAME_SELECTOR = [
  'input[type="text"]',
  'input[type="email"]',
  'input[type="tel"]',
  "input:not([type])",
].join(",");

function isUsable(el: HTMLInputElement): boolean {
  return !el.disabled && !el.readOnly && el.type !== "hidden";
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

  // The username field is normally the last usable text input preceding the
  // password field. Falling back to the first candidate covers forms whose
  // password input is rendered before the username input.
  const before = candidates.filter(
    (c) => c.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  return { username: before[before.length - 1] ?? candidates[0] ?? null, password };
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
browser.runtime.onMessage.addListener((msg: unknown) => {
  if (!isFillMessage(msg)) return undefined;
  return Promise.resolve(fillFields(document, { username: msg.username, password: msg.password }));
});
