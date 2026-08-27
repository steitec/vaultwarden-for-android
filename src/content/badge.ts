/**
 * The affordance rendered inside a login form's password field.
 *
 * It holds no credentials and never learns one. It knows that *something* is
 * offerable and reports a tap; everything else stays in the background page.
 * That is what makes a content script on every https page an acceptable trade
 * — see the 2026-08-25 design's §9.
 */

export const BADGE_HOST_ATTR = "data-vw-badge";

export type BadgeMode = "fill" | "chooser" | "unlock";

const LABEL: Record<BadgeMode, string> = {
  fill: "Fill from Vaultwarden",
  chooser: "Choose a Vaultwarden entry",
  unlock: "Unlock Vaultwarden to fill",
};

const SIZE_PX = 24;

/** The drawn glyph, inside the badge's box. */
const GLYPH_PX = 16;

/** How far the badge sits inside the field's right-hand edge. */
const INSET_PX = 4;

const SVG_NS = "http://www.w3.org/2000/svg";

/** One drawn shape: an element name, and the attributes that give it form. */
type Shape = [tag: string, attrs: Record<string, string>];

/**
 * The lock, shared by the two modes that mean "the vault has an entry here".
 *
 * Centred on x=7 rather than x=8, which is what leaves the chooser room for
 * its marker without redrawing the lock — the two must stay the same shape.
 */
const LOCK: Shape[] = [
  ["rect", { x: "2.5", y: "7", width: "9", height: "6.25", rx: "1.25" }],
  ["path", { d: "M4.75 7V5.25a2.25 2.25 0 0 1 4.5 0V7" }],
];

/**
 * The vertical ellipsis Android uses for an overflow menu.
 *
 * A chooser tap cannot finish on the page — it hands off to the popup, which
 * `browserAction.openPopup()` cannot raise on Firefox for Android, so nothing
 * visible happens and the user has to open the add-on. That is the one place
 * the badge can mislead, and it is why chooser is not simply the fill lock.
 */
const OVERFLOW_DOTS: Shape[] = [5.4, 8, 10.6].map((cy): Shape => [
  "circle",
  { cx: "14", cy: String(cy), r: "0.85", fill: "currentColor", stroke: "none" },
]);

/**
 * The key: a round bow at the lower left, a shaft to the upper right, two
 * teeth on its underside.
 *
 * Every point on the shaft satisfies x + y = 16, including where it leaves
 * the bow — that is what keeps the teeth sitting on the shaft rather than
 * beside it if the numbers are ever adjusted.
 */
const KEY: Shape[] = [
  ["circle", { cx: "5.5", cy: "10.5", r: "2.75" }],
  ["path", { d: "M7.45 8.55 13 3" }],
  ["path", { d: "M11 5l1.3 1.3" }],
  ["path", { d: "M12.3 3.7l1.3 1.3" }],
];

const GLYPH: Record<BadgeMode, { viewBox: string; shapes: Shape[] }> = {
  fill: { viewBox: "0 0 14 16", shapes: LOCK },
  chooser: { viewBox: "0 0 16 16", shapes: [...LOCK, ...OVERFLOW_DOTS] },
  unlock: { viewBox: "0 0 16 16", shapes: KEY },
};

/**
 * Draws the glyph for `mode`.
 *
 * Built node by node rather than assigned as markup: a page may enforce
 * Trusted Types, under which `innerHTML` in a content script throws instead
 * of rendering, and a badge that throws on some sites is worse than one that
 * is merely plain. Nothing here is drawn in a colour of its own — the shapes
 * take `currentColor` from the host, which is what makes the `color` on the
 * glyph element mean something. It did not, while these were colour emoji:
 * those are drawn by the device's emoji font, in that font's own colours and
 * in whatever shapes it happens to have.
 */
export function buildGlyph(doc: Document, mode: BadgeMode): SVGSVGElement {
  const { viewBox, shapes } = GLYPH[mode];
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("width", String(GLYPH_PX));
  svg.setAttribute("height", String(GLYPH_PX));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  for (const [tag, attrs] of shapes) {
    const el = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    svg.appendChild(el);
  }
  return svg;
}

/**
 * Mounts the badge beside `field` and returns its unmount.
 *
 * The click listener sits on the HOST, in the light DOM, not on the glyph
 * inside the shadow root. Clicks on the glyph are composed and retarget to
 * the host as they cross the boundary, so a real tap and a synthetic one
 * reach the same listener — which keeps the closed root closed while leaving
 * the behaviour reachable from a test.
 */
export function mountBadge(
  field: HTMLInputElement,
  mode: BadgeMode,
  onTap: () => void,
): () => void {
  const doc = field.ownerDocument;

  const host = doc.createElement("div");
  host.setAttribute(BADGE_HOST_ATTR, mode);
  host.setAttribute("aria-label", LABEL[mode]);
  host.setAttribute("role", "button");
  host.style.cssText =
    `position:absolute;z-index:2147483647;width:${SIZE_PX}px;height:${SIZE_PX}px;` +
    "cursor:pointer;margin:0;padding:0;";

  const root = host.attachShadow({ mode: "closed" });
  const glyph = doc.createElement("div");
  // `all:initial` first, so nothing the page inherits through the host can
  // reach in and restyle the glyph out of visibility.
  glyph.style.cssText =
    "all:initial;display:flex;align-items:center;justify-content:center;" +
    `width:${SIZE_PX}px;height:${SIZE_PX}px;` +
    "border-radius:4px;background:#1f2b4d;color:#ffffff;";
  glyph.appendChild(buildGlyph(doc, mode));
  root.appendChild(glyph);

  // Capture phase and full suppression. A page that listens for clicks on its
  // own form must not observe this one: on a login form that would submit the
  // still-empty form before the fill has landed.
  const handler = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    onTap();
  };
  host.addEventListener("click", handler, true);

  doc.body.appendChild(host);

  // The badge is parked at document coordinates, so anything that moves the
  // field leaves it behind. A page does that constantly and mostly without
  // touching the DOM: a menu expands and pushes the form down, the on-screen
  // keyboard resizes the viewport, an image finishes loading. The content
  // script's MutationObserver sees none of it — it watches childList only,
  // and a menu toggled through one attribute produces no record at all.
  //
  // Capture, because a scroll event from a scrolling container does not
  // bubble to the window; passive, because this never calls preventDefault
  // and a non-passive scroll listener costs scrolling performance on a phone.
  const view = doc.defaultView;
  const update = (): void => reposition(host, field);
  update();
  view?.addEventListener("scroll", update, { capture: true, passive: true });
  view?.addEventListener("resize", update, { passive: true });

  // Layout changes that are neither a scroll nor a resize — the reported menu
  // is exactly one. Observing the field alone is not enough: what changed
  // size there is the header above it, and the field only moved.
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
  resize?.observe(field);
  resize?.observe(doc.documentElement);

  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    view?.removeEventListener("scroll", update, true);
    view?.removeEventListener("resize", update);
    resize?.disconnect();
    host.removeEventListener("click", handler, true);
    host.remove();
  };
}

/**
 * Parks the badge at the right-hand inside edge of the field, and shows it
 * only where the field is what is actually drawn there.
 *
 * Under jsdom no layout engine runs and every rect is zero, so the badge
 * lands at the origin; tests place the field by faking its rect rather than
 * asserting on a real one. The same reasoning already governs
 * `isRenderedOffScreen` in autofill.ts.
 */
function reposition(host: HTMLElement, field: HTMLInputElement): void {
  const view = field.ownerDocument.defaultView;
  const rect = field.getBoundingClientRect();
  const centreX = rect.right - INSET_PX - SIZE_PX / 2;
  const centreY = rect.top + rect.height / 2;
  host.style.left = `${centreX + (view?.scrollX ?? 0) - SIZE_PX / 2}px`;
  host.style.top = `${centreY + (view?.scrollY ?? 0) - SIZE_PX / 2}px`;
  host.style.display = fieldIsDrawnAt(host, field, centreX, centreY) ? "" : "none";
}

/**
 * Whether the field is what is drawn under every corner of the badge.
 *
 * `z-index: 2147483647` beats anything a page can declare, which is what
 * keeps the badge from being buried — and also what would paint it over a
 * menu that has covered the field. The points are derived from the FIELD's
 * rect, never the host's, so the answer stays right while the badge is
 * hidden and its own rect has collapsed to nothing.
 *
 * `elementsFromPoint` returns the whole stack at a point, topmost first and
 * everything underneath it after — including what is covered. So asking
 * whether the field is *in* the list answers yes even when a menu is painted
 * over it (measured on the device: a field behind an open menu was still
 * reported at every corner). Only the FIRST entry says what is actually
 * drawn there, and the badge's own host is skipped because it is the thing
 * doing the asking.
 *
 * All four corners, not the centre alone: the badge is 24px tall and a
 * menu's lower edge can fall across it, leaving the centre clear while the
 * top half is painted over the menu. Partly covered is covered.
 *
 * Two answers are deliberately read as "visible" rather than "covered": an
 * engine with no `elementsFromPoint` cannot be asked at all, and a stack
 * holding nothing but the badge means the point is off-screen, where the
 * badge is not visible either way and hiding it would only fight the scroll
 * that is about to reveal it.
 */
function fieldIsDrawnAt(
  host: HTMLElement,
  field: HTMLInputElement,
  centreX: number,
  centreY: number,
): boolean {
  const doc = field.ownerDocument;
  if (typeof doc.elementsFromPoint !== "function") return true;

  // A pixel inside each corner. Exactly on the edge is ambiguous — the point
  // belongs to the box beside it as readily as to this one.
  const reach = SIZE_PX / 2 - 1;
  return [
    [-reach, -reach],
    [reach, -reach],
    [-reach, reach],
    [reach, reach],
  ].every(([dx, dy]) => {
    const stack = doc.elementsFromPoint(centreX + (dx ?? 0), centreY + (dy ?? 0));
    const topmost = stack.find((el) => el !== host);
    return topmost === undefined || topmost === field;
  });
}
