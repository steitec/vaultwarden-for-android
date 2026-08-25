/**
 * A fill the user asked for while the vault was locked, waiting for the
 * unlock that makes it possible.
 *
 * Held in memory only and never written to storage: a background-page restart
 * must lose it, which is the safe direction to fail.
 */
export type PendingFill = { tabId: number; origin: string; at: number };

/** How long a tap stays redeemable. Long enough to type a PIN, not to walk away. */
export const PENDING_TTL_MS = 120_000;

/**
 * Whether a recorded tap may still be turned into a fill.
 *
 * The origin comparison is the load-bearing one. Between the tap and the
 * unlock the tab is free to navigate, and without re-reading its URL here the
 * credentials would land wherever it ended up. Origin rather than host: a
 * downgrade to http or a move to another port is a different security context
 * and must not inherit the user's tap.
 */
export function isRedeemable(
  pending: PendingFill,
  tabUrl: string | undefined,
  now: number,
): boolean {
  const age = now - pending.at;
  if (age < 0 || age > PENDING_TTL_MS) return false;
  if (tabUrl === undefined) return false;

  let parsed: URL;
  try {
    parsed = new URL(tabUrl);
  } catch {
    return false;
  }

  // `about:blank` and friends parse but report the opaque origin "null",
  // which must never compare equal to a recorded one.
  if (parsed.origin === "null") return false;
  return parsed.origin === pending.origin;
}
