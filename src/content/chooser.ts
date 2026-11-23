/**
 * The list a chooser badge opens: one row per entry matching the page.
 *
 * Several matches used to hand off to the popup, which Firefox for Android
 * cannot open from an extension — so the tap did nothing visible (F-9). The
 * choice is made here instead, on the page, and a row tap sends the same
 * `fillFromPage` the single-match badge sends. Every fill-time guard in the
 * background page still runs on it.
 *
 * What this shows — names and usernames — already reaches the content script
 * in the `matches` answer (2026-08-25 design §9). No secret ever does. The
 * closed shadow root keeps the page's own scripts from reading the names out
 * of the DOM.
 *
 * See docs/superpowers/specs/2026-11-23-inline-chooser-design.md.
 */

import { BADGE_HOST_ATTR } from "./badge";

export const CHOOSER_HOST_ATTR = "data-vw-chooser";

/** The fields of an entry the list needs; a subset of `ItemSummary`. */
export type ChooserEntry = {
  id: string;
  name: string;
  username: string | null;
  undecryptable: boolean;
};

/** Height of one row. Fixed, so the list's height is known before layout. */
export const ROW_PX = 48;

/** Rows visible before the list scrolls. */
const VISIBLE_ROWS = 5;

/** Padding above and below the rows, together. */
const PAD_PX = 8;

/** Gap between the field and the list. */
const GAP_PX = 4;

const MIN_WIDTH_PX = 220;

/** Kept clear at the viewport's right edge. */
const EDGE_PX = 8;

/**
 * Mounts the list under `field` and returns its unmount.
 *
 * `onPick` gets the id of a tapped row; `onClose` is told when the list
 * closes itself — after a pick, on a tap elsewhere, on Escape. An unmount
 * from outside reports nothing: whoever called it already knows.
 */
export function mountChooser(
  field: HTMLInputElement,
  entries: ChooserEntry[],
  onPick: (itemId: string) => void,
  onClose: () => void,
): () => void {
  const doc = field.ownerDocument;
  const view = doc.defaultView;

  const host = doc.createElement("div");
  host.setAttribute(CHOOSER_HOST_ATTR, "");
  host.style.cssText = "position:absolute;z-index:2147483647;margin:0;padding:0;";

  const root = host.attachShadow({ mode: "closed" });
  const menu = doc.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Choose a Vaultwarden entry");
  // `all:initial` first, as on the badge: nothing the page inherits through
  // the host may restyle the list.
  menu.style.cssText =
    "all:initial;display:block;box-sizing:border-box;" +
    `max-height:${VISIBLE_ROWS * ROW_PX + PAD_PX}px;overflow-y:auto;` +
    `padding:${PAD_PX / 2}px 0;border-radius:8px;background:#ffffff;` +
    "border:1px solid #c5cad6;box-shadow:0 4px 16px rgba(0,0,0,0.25);" +
    "font-family:sans-serif;color:#1f2b4d;";

  for (const entry of entries) {
    menu.appendChild(buildRow(doc, entry, () => {
      onPick(entry.id);
      close();
    }));
  }
  root.appendChild(menu);

  // Bubble phase on the host: rows inside the closed root have handled the
  // tap by the time it gets here, and it goes no further. The page never
  // learns the list was touched — no click on its body, none on its form.
  const swallow = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  host.addEventListener("click", swallow);

  // Capture on the document, so a page that stops propagation on its own
  // elements cannot keep the list open. A tap on the list itself, or on the
  // badge — which toggles the list on its own — is not "elsewhere".
  const onDocClick = (event: Event): void => {
    const target = event.target;
    if (target instanceof Element) {
      if (target === host) return;
      if (target.closest(`[${BADGE_HOST_ATTR}]`) !== null) return;
    }
    close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };
  doc.addEventListener("click", onDocClick, true);
  doc.addEventListener("keydown", onKey, true);

  doc.body.appendChild(host);

  const height = Math.min(entries.length, VISIBLE_ROWS) * ROW_PX + PAD_PX;
  const update = (): void => place(host, field, height);
  update();
  view?.addEventListener("scroll", update, { capture: true, passive: true });
  view?.addEventListener("resize", update, { passive: true });

  let mounted = true;
  function unmount(): void {
    if (!mounted) return;
    mounted = false;
    view?.removeEventListener("scroll", update, true);
    view?.removeEventListener("resize", update);
    doc.removeEventListener("click", onDocClick, true);
    doc.removeEventListener("keydown", onKey, true);
    // `swallow` stays on the host. A row tap closes the list from inside the
    // very click that is still on its way up to the host; removing the
    // listener here would let that click through to the page.
    host.remove();
  }
  function close(): void {
    if (!mounted) return;
    unmount();
    onClose();
  }
  return unmount;
}

function buildRow(doc: Document, entry: ChooserEntry, pick: () => void): HTMLElement {
  const row = doc.createElement("div");
  row.setAttribute("role", "menuitem");
  row.style.cssText =
    "all:initial;display:flex;flex-direction:column;justify-content:center;" +
    `box-sizing:border-box;height:${ROW_PX}px;padding:0 12px;` +
    "font-family:sans-serif;cursor:pointer;" +
    (entry.undecryptable ? "opacity:0.5;cursor:default;" : "");

  const name = doc.createElement("div");
  name.textContent = entry.name;
  name.style.cssText = LINE + "font-size:15px;font-weight:bold;color:#1f2b4d;";

  const detail = doc.createElement("div");
  detail.textContent = entry.undecryptable
    ? "Could not be decrypted"
    : (entry.username ?? "No username");
  detail.style.cssText = LINE + "font-size:13px;color:#5a6478;";

  row.append(name, detail);

  if (entry.undecryptable) {
    row.setAttribute("aria-disabled", "true");
  } else {
    row.tabIndex = 0;
    row.addEventListener("click", pick);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        pick();
      }
    });
  }
  return row;
}

/** One line of text, cut with an ellipsis rather than wrapped. */
const LINE =
  "all:initial;display:block;font-family:sans-serif;" +
  "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

/**
 * Parks the list under the field, or above it when the viewport has no room
 * below and does above — the on-screen keyboard takes the lower half of a
 * phone's screen, and a login field is often just above it.
 *
 * The list's height is computed, not measured: rows have a fixed height, and
 * jsdom (like a list not yet laid out) measures everything as zero.
 */
function place(host: HTMLElement, field: HTMLInputElement, height: number): void {
  const view = field.ownerDocument.defaultView;
  const rect = field.getBoundingClientRect();
  const viewWidth = view?.innerWidth ?? Number.POSITIVE_INFINITY;
  const viewHeight = view?.innerHeight ?? Number.POSITIVE_INFINITY;

  const width = Math.min(Math.max(rect.width, MIN_WIDTH_PX), viewWidth - 2 * EDGE_PX);
  const left = Math.max(EDGE_PX, Math.min(rect.left, viewWidth - EDGE_PX - width));

  const below = rect.bottom + GAP_PX;
  const above = rect.top - GAP_PX - height;
  const top = below + height > viewHeight && above >= 0 ? above : below;

  host.style.width = `${width}px`;
  host.style.left = `${left + (view?.scrollX ?? 0)}px`;
  host.style.top = `${top + (view?.scrollY ?? 0)}px`;
}
