import { mountBadge, BADGE_HOST_ATTR, type BadgeMode } from "./badge";
import { mountChooser, CHOOSER_HOST_ATTR } from "./chooser";
import type { ItemSummary, PageMatches } from "../background/messages";

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

/** A single-choice dropdown the user could operate. `multiple` is never a username. */
function isUsableSelect(el: HTMLSelectElement, layoutAvailable: boolean): boolean {
  return !el.disabled && !el.multiple && isVisible(el, layoutAvailable);
}

/** The field a username goes into: normally a text input, rarely a dropdown. */
export type UsernameField = HTMLInputElement | HTMLSelectElement;

export function findLoginFields(doc: Document): {
  username: UsernameField | null;
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
  const textField = before[before.length - 1] ?? inScopeCandidates[0] ?? null;
  if (textField !== null) return { username: textField, password };

  // A dropdown only when the form offers no text input at all: a FRITZ!Box
  // with FRITZ!Benutzer renders its users this way. Never ahead of a text
  // input, because a domain or language dropdown beside a real username field
  // is common, and filling that would break pages that work today. Same scope
  // and the same "last one before the password" rule as above.
  const selects = Array.from(doc.querySelectorAll("select")).filter(
    (s) =>
      isUsableSelect(s, layoutAvailable) &&
      (passwordForm === null || s.closest("form") === passwordForm),
  );
  const selectBefore = selects.filter(
    (s) => s.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  return { username: selectBefore[selectBefore.length - 1] ?? selects[0] ?? null, password };
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

/**
 * Picks the option carrying `username`, by value first and visible text
 * second, and reports whether there was one.
 *
 * The native-setter trick above does not apply: it exists for React's and
 * Vue's shadowed `value` on inputs. A select takes `selectedIndex` and the
 * same two events. Assigning a value no option carries selects nothing and
 * says nothing, so the match is looked up first and a miss leaves the
 * dropdown exactly as it was.
 */
function selectOption(el: HTMLSelectElement, username: string): boolean {
  const options = Array.from(el.options);
  const byValue = options.findIndex((o) => o.value === username);
  const index = byValue !== -1 ? byValue : options.findIndex((o) => o.text.trim() === username);
  if (index === -1) return false;

  el.selectedIndex = index;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/**
 * The `autocomplete` tokens that mark a field as the account identifier of a
 * login. `username` is the standard's token for it; `webauthn` is reserved for
 * credential fields and is what Amazon sets alone on its identifier step.
 * Names, ids and a bare `type="email"` never count: they also sit on
 * newsletter, search and sign-up fields.
 */
const IDENTIFIER_TOKENS = new Set(["username", "webauthn"]);

function hasIdentifierToken(el: HTMLInputElement): boolean {
  // getAttribute, not the `.autocomplete` IDL property: for a token list the
  // engine does not consider canonical, jsdom and Firefox disagree there.
  const raw = el.getAttribute("autocomplete");
  if (raw === null) return false;
  return raw
    .toLowerCase()
    .split(/\s+/)
    .some((token) => IDENTIFIER_TOKENS.has(token));
}

/**
 * The first screen of an email-first login: no usable password field, but a
 * usable field explicitly marked as the login identifier. Returns null on any
 * page with a usable password field, so an ordinary one-step login always
 * takes the password path.
 */
export function findIdentifierField(doc: Document): HTMLInputElement | null {
  if (findLoginFields(doc).password !== null) return null;
  const layoutAvailable = hasLayout(doc);
  return (
    Array.from(doc.querySelectorAll<HTMLInputElement>(USERNAME_SELECTOR)).find(
      (el) => isUsable(el, layoutAvailable) && hasIdentifierToken(el),
    ) ?? null
  );
}

export function fillFields(
  doc: Document,
  credentials: { username: string | null; password: string | null },
): { filledUsername: boolean; filledPassword: boolean } {
  const fields = findLoginFields(doc);
  // With no password field, prefer the field marked as the login identifier
  // over the first text input, which may be a search box above it.
  const usernameField =
    fields.password === null ? (findIdentifierField(doc) ?? fields.username) : fields.username;

  let filledUsername = false;
  if (usernameField !== null && credentials.username !== null) {
    if (usernameField instanceof HTMLSelectElement) {
      filledUsername = selectOption(usernameField, credentials.username);
    } else {
      setValue(usernameField, credentials.username);
      filledUsername = true;
    }
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

// Declared statically in manifest.json and running on every matched page; the
// background page sends the credentials to it by tab id.
//
// Page JavaScript cannot reach this listener under MV2 -- content scripts and
// pages are isolated worlds, so being present on every page does not make it
// reachable from one.
//
// The sender check is defence in depth. An earlier version of this comment
// claimed it closes a hole through which a *different installed extension*
// could send a forged { kind: "fill" }; that route does not exist as
// described. Firefox MV2 delivers a cross-extension message to
// `runtime.onMessageExternal`, not to `onMessage`, and nothing here registers
// `onMessageExternal`. The check is kept because it is one comparison and it
// pins the credential delivery to this extension's own background page no
// matter what else ends up able to message this frame.
browser.runtime.onMessage.addListener((msg: unknown, sender: browser.runtime.MessageSender) => {
  if (sender.id !== browser.runtime.id) return undefined;
  if (!isFillMessage(msg)) return undefined;
  return Promise.resolve(fillFields(document, { username: msg.username, password: msg.password }));
});


let unmountBadge: (() => void) | null = null;

/**
 * Decide what this page can offer, and offer it.
 *
 * The order matters. The password field (or, failing that, a field marked
 * as the login identifier) is looked for BEFORE the background page is asked
 * anything, so a page with no login form never produces a message at all:
 * the background page learns nothing about the ordinary browsing of someone
 * who is not signing in to something.
 */
export async function refreshBadge(doc: Document): Promise<void> {
  unmountBadge?.();
  unmountBadge = null;

  const target = badgeTarget(doc);
  if (target === null) return;

  let matches: PageMatches;
  try {
    matches = await browser.runtime.sendMessage({ kind: "matches" });
  } catch {
    // The background page is locked out, restarting, or gone. Leave the page
    // untouched: a content script must not surface this addon's errors onto
    // somebody else's site.
    return;
  }

  // On the identifier screen only the username can be filled, so an entry
  // without one has nothing to offer there.
  if (target.scope === "username" && matches.state === "unlocked") {
    matches = { ...matches, items: matches.items.filter((i) => i.username !== null) };
  }

  const mode = modeFor(matches);
  if (mode === null) return;

  if (matches.state === "locked") {
    // Nothing can be filled before the unlock, and the unlock happens in the
    // popup: hand off, and the background page records the pending fill.
    unmountBadge = mountBadge(target.field, "unlock", () => {
      void handOff(target.scope);
    });
    return;
  }

  const [only] = matches.items;
  if (mode === "fill" && only !== undefined) {
    unmountBadge = mountBadge(target.field, "fill", () => {
      void fillFromPage(target.scope, only.id);
    });
    return;
  }

  unmountBadge = mountChooserBadge(target, matches.items);
}

/**
 * Where the badge goes and what a tap on it may fill. A usable password field
 * always wins; only a page without one falls back to a field marked as the
 * login identifier (F-1), and that fill is username-only.
 */
type BadgeTarget = { field: HTMLInputElement; scope: "login" | "username" };

function badgeTarget(doc: Document): BadgeTarget | null {
  const { password } = findLoginFields(doc);
  if (password !== null) return { field: password, scope: "login" };
  const identifier = findIdentifierField(doc);
  if (identifier !== null) return { field: identifier, scope: "username" };
  return null;
}

/**
 * A badge for several matches: a tap opens the list of them on the page, a
 * second tap closes it, and a row tap fills that entry (F-9). The returned
 * unmount takes the list down with the badge, so a refresh never leaves a
 * list behind pointing at entries that may no longer match.
 */
function mountChooserBadge(target: BadgeTarget, items: ItemSummary[]): () => void {
  let closeList: (() => void) | null = null;
  let badgeHost: HTMLElement | null = null;

  const setExpanded = (open: boolean): void => {
    badgeHost?.setAttribute("aria-expanded", String(open));
  };

  const unmount = mountBadge(target.field, "chooser", (host) => {
    badgeHost = host;
    if (closeList !== null) {
      closeList();
      closeList = null;
      setExpanded(false);
      return;
    }
    closeList = mountChooser(
      target.field,
      items,
      (itemId) => {
        void fillFromPage(target.scope, itemId);
      },
      () => {
        closeList = null;
        setExpanded(false);
      },
    );
    setExpanded(true);
  });

  return () => {
    closeList?.();
    closeList = null;
    unmount();
  };
}

async function fillFromPage(scope: BadgeTarget["scope"], itemId: string): Promise<void> {
  const kind = scope === "username" ? "fillUsernameFromPage" : "fillFromPage";
  try {
    await browser.runtime.sendMessage({ kind, itemId });
  } catch {
    // A refused fill. The background page owns the user-facing report.
  }
}

/**
 * A locked vault gets a badge whether or not anything matches, because it
 * cannot be asked — see the 2026-08-25 design's §7. The cost is a badge on
 * login pages with no entry; the alternative is an unencrypted index of every
 * domain in the vault, which is worse.
 */
function modeFor(matches: PageMatches): BadgeMode | null {
  if (matches.state === "locked") return "unlock";
  if (matches.items.length === 0) return null;
  return matches.items.length === 1 ? "fill" : "chooser";
}

async function handOff(scope: BadgeTarget["scope"]): Promise<void> {
  // A bare handOff is a login fill; only the identifier screen says so.
  const msg = scope === "username" ? { kind: "handOff", scope } : { kind: "handOff" };
  try {
    await browser.runtime.sendMessage(msg);
  } catch {
    // A handOff whose handler does not exist yet. Nothing to do on the page.
  }
}

const REFRESH_DEBOUNCE_MS = 300;

/**
 * Watches for a login form that mounts after the page has settled.
 *
 * Single-page apps render their form well after document_idle, so a one-shot
 * lookup misses them entirely. Debounced hard, because a framework render
 * mutates the DOM dozens of times in a frame and one background message per
 * mutation would be a message storm on every page load — on a phone.
 *
 * The badge's own host is skipped. refreshBadge appends it to the document,
 * which is itself a mutation; reacting to that would schedule another lookup
 * after every render, forever.
 */
function isBadgeNode(n: Node): boolean {
  if (!(n instanceof Element)) return false;
  // The entry list a chooser badge opens is the same kind of node: ours.
  return [BADGE_HOST_ATTR, CHOOSER_HOST_ATTR].some(
    (attr) => n.hasAttribute(attr) || n.closest(`[${attr}]`) !== null,
  );
}

/** Whether a record describes nothing but the badge appearing or leaving. */
function isBadgeOnly(r: MutationRecord): boolean {
  const touched = [...r.addedNodes, ...r.removedNodes];
  return touched.length > 0 && touched.every(isBadgeNode);
}

export function startObserving(doc: Document): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const observer = new MutationObserver((records) => {
    // Mounting the badge appends its host to the document, which is itself a
    // mutation. Reacting to it would schedule another lookup after every
    // render, forever. The record's TARGET cannot distinguish this -- the
    // host is appended to `body`, exactly like any page-made node -- so the
    // added and removed nodes are what get inspected.
    if (records.every(isBadgeOnly)) return;

    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refreshBadge(doc);
    }, REFRESH_DEBOUNCE_MS);
  });

  observer.observe(doc.documentElement, { childList: true, subtree: true });

  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    observer.disconnect();
  };
}

// The content script's entry point.
//
// This MUST stay at the very bottom of the module. `refreshBadge` is a
// hoisted function declaration, so calling it from higher up compiles and
// looks fine -- but its first statement touches `unmountBadge`, a `let`
// declared above, and from anywhere before that declaration the call lands
// in the temporal dead zone. The ReferenceError is then swallowed by the
// `void` below, and the failure mode is a badge that silently never appears.
// That shipped once; `tests/content/autofill.test.ts` pins it now.
//
// Fire-and-forget is deliberate beyond that: a content script has nobody to
// report to, and refreshBadge already swallows its own failures rather than
// surfacing this addon's errors onto somebody else's page.
void refreshBadge(document);

/**
 * The document watch this content script installs, and its teardown.
 *
 * Exported because it is a live side effect of importing this module: nothing
 * in the extension ever calls it, but a test that imports this file inherits
 * a running MutationObserver on its document and has no other way to be rid
 * of it. Making that reachable is better than leaving each test to discover
 * it through interference.
 */
export const stopPageWatch = startObserving(document);
