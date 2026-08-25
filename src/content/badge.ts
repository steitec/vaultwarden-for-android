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

const GLYPH: Record<BadgeMode, string> = {
  fill: "\u{1F512}",
  chooser: "\u{1F512}",
  unlock: "\u{1F513}",
};

const SIZE_PX = 24;

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
    `width:${SIZE_PX}px;height:${SIZE_PX}px;font-size:14px;line-height:1;` +
    "border-radius:4px;background:#1f2b4d;color:#ffffff;";
  glyph.textContent = GLYPH[mode];
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
  position(host, field);

  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    host.removeEventListener("click", handler, true);
    host.remove();
  };
}

/**
 * Parks the badge at the right-hand inside edge of the field.
 *
 * Under jsdom no layout engine runs, every rect is zero, and this lands the
 * badge at the origin — which is why no test asserts on the result. Only a
 * real layout engine makes it meaningful; the same reasoning already governs
 * `isRenderedOffScreen` in autofill.ts.
 */
function position(host: HTMLElement, field: HTMLInputElement): void {
  const view = field.ownerDocument.defaultView;
  const rect = field.getBoundingClientRect();
  const scrollX = view?.scrollX ?? 0;
  const scrollY = view?.scrollY ?? 0;
  host.style.left = `${rect.right + scrollX - SIZE_PX - 4}px`;
  host.style.top = `${rect.top + scrollY + (rect.height - SIZE_PX) / 2}px`;
}
