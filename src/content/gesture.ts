/**
 * Whether an event came from the user rather than from a script.
 *
 * The badge's host lives in the page's DOM, so the page's own scripts can
 * dispatch a click on it (`host.click()`). With exactly one match that would
 * fill without the tap that is the mitigation for running on every page
 * (2026-08-25 design §3, F-10). Firefox sets `isTrusted` only for events the
 * browser itself generated from real input; a page cannot forge it.
 *
 * Its own module so that tests, whose dispatched events are never trusted
 * under jsdom, can stand in for it — see tests/content/gesture.test.ts for
 * the real thing.
 */
export function isUserGesture(event: Event): boolean {
  return event.isTrusted;
}
