const USERNAME_SELECTOR = [
  'input[type="text"]',
  'input[type="email"]',
  'input[type="tel"]',
  "input:not([type])",
].join(",");

// A field parked this far to the left of / above the origin is off-screen by
// construction. Real decoys and the conventional `.sr-only`/`.visually-hidden`
// idiom use -5000px to -10000px; no legitimate *visible* login field is laid
// out a thousand pixels beyond the origin, so this threshold separates the two
// without depending on the viewport size (which layer 2 handles instead).
const OFFSCREEN_THRESHOLD_PX = -1000;

// Matches only an unambiguously negative px length ("-9999px", "-.5px").
// Computed offsets may also be "", "auto", a percentage, or a calc()
// expression; none of those are confidently off-screen, so they must not
// trigger rejection here -- layer 2 backstops them in a real browser.
const NEGATIVE_PX = /^-(?:\d+(?:\.\d+)?|\.\d+)px$/;

function isFarNegativeOffset(value: string): boolean {
  if (!NEGATIVE_PX.test(value)) return false;
  const px = Number.parseFloat(value);
  return Number.isFinite(px) && px <= OFFSCREEN_THRESHOLD_PX;
}

/**
 * Layer 1: the off-screen decoy detectable purely from the CSSOM.
 *
 * An out-of-flow box (`position: absolute`/`fixed`) shifted far negative on
 * `left` or `top` is invisible to the user while remaining a perfectly normal
 * element to `display`/`visibility`/`opacity` checks -- which is exactly how
 * the demonstrated exploit smuggled a password field past this function.
 *
 * A zero-sized clipping wrapper (`width`/`height: 0` with `overflow: hidden`
 * or `clip`) is the other half of the `.sr-only` idiom. Zero size *alone* is
 * not enough to reject: an unstyled wrapper reports "" for both dimensions,
 * and an input's own computed width/height carries no explicit value either.
 */
function isCssHiddenBox(style: CSSStyleDeclaration): boolean {
  if (style.position === "absolute" || style.position === "fixed") {
    if (isFarNegativeOffset(style.left) || isFarNegativeOffset(style.top)) return true;
  }
  if (style.overflow === "hidden" || style.overflow === "clip") {
    if (style.width === "0px" || style.height === "0px") return true;
  }
  return false;
}

/**
 * Layer 2: the geometry backstop, applied to the candidate field itself.
 *
 * This is what catches everything the CSSOM walk cannot see -- off-screen via
 * a class in an external stylesheet, `transform`, an ancestor's `clip-path`,
 * a field scrolled out of an overflow container, or a rendered size of zero.
 * Only meaningful where a layout engine has actually run; see `hasLayout`.
 */
function isRenderedOffScreen(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  if (view === null) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return true;
  if (rect.right <= 0 || rect.bottom <= 0) return true;
  if (rect.left >= view.innerWidth || rect.top >= view.innerHeight) return true;
  return false;
}

/**
 * Whether layer 2 can be trusted for this document. jsdom performs no layout,
 * so *every* rect it reports is zero -- including the root element's. A real
 * browser always gives the root a non-zero box. Probing the root once per
 * `findLoginFields` call therefore distinguishes "this field has no geometry"
 * from "this document has no geometry", and lets the geometry test be skipped
 * wholesale in the latter case rather than rejecting every field on the page.
 */
function hasLayout(doc: Document): boolean {
  const rect = doc.documentElement.getBoundingClientRect();
  return rect.width !== 0 || rect.height !== 0;
}

/**
 * Walks the element and every ancestor, rejecting if any of them is hidden
 * via the `hidden` attribute, `display: none`, `visibility: hidden`/
 * `collapse`, `opacity: 0`, or the off-screen/zero-size box patterns in
 * `isCssHiddenBox`. Checking only the element itself would miss the common
 * decoy pattern where the *wrapper* is hidden and the input inside it is not:
 * an off-screen or invisible field that still passes a plain per-element
 * check would silently receive the real credential instead of the field the
 * user can actually see.
 *
 * The CSSOM walk and the geometry check in `isRenderedOffScreen` are
 * complementary, not redundant. The walk sees only what the computed style
 * spells out, so it misses `transform`, clipping, scroll position, and any
 * rendered geometry; the geometry check sees all of those but exists only
 * where a layout engine ran. `layoutAvailable` is computed once per lookup by
 * `findLoginFields` and gates the geometry half accordingly -- under jsdom it
 * is false and layer 1 stands alone, which is why layer 1 must catch the
 * off-screen-by-position case on its own.
 */
function isVisible(el: Element, layoutAvailable: boolean): boolean {
  if (layoutAvailable && isRenderedOffScreen(el)) return false;

  let node: Element | null = el;
  const view = el.ownerDocument.defaultView;
  while (node !== null) {
    if (node instanceof HTMLElement && node.hidden) return false;
    const style = view?.getComputedStyle(node);
    if (style !== undefined) {
      if (style.display === "none") return false;
      if (style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (style.opacity === "0") return false;
      if (isCssHiddenBox(style)) return false;
    }
    node = node.parentElement;
  }
  return true;
}

function isUsable(el: HTMLInputElement, layoutAvailable: boolean): boolean {
  return (
    !el.disabled && !el.readOnly && el.type !== "hidden" && isVisible(el, layoutAvailable)
  );
}

export function findLoginFields(doc: Document): {
  username: HTMLInputElement | null;
  password: HTMLInputElement | null;
} {
  const layoutAvailable = hasLayout(doc);
  const usable = (el: HTMLInputElement): boolean => isUsable(el, layoutAvailable);

  const password =
    Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="password"]')).find(usable) ??
    null;

  const candidates = Array.from(doc.querySelectorAll<HTMLInputElement>(USERNAME_SELECTOR)).filter(
    usable,
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
