/**
 * The message the user is shown for a failure.
 *
 * `.message` only, never `.cause`: a rejected fetch/JSON.parse deep in the
 * background page carries server-controlled text in the cause's message, and
 * this popup is not the place to render it.
 *
 * Its own module rather than a helper in popup.ts, because both popup.ts and
 * screens.ts need it and screens.ts is imported BY popup.ts — putting it in
 * either one would make the pair circular.
 */
export function errorText(e: unknown): string {
  if (e instanceof Error && e.message !== "") return e.message;
  return "Something went wrong. Please try again.";
}

/**
 * A PIN the background page rejected, carrying the count the pad must now
 * show.
 *
 * The lockout warning is rendered from a number, and only the background page
 * knows the new one. Routing to a freshly rendered screen would show it, but
 * would also throw away the error the user needs to read and rebuild the form
 * under their thumb — so the count travels with the rejection instead.
 *
 * Lives here for the same reason `errorText` does: popup.ts throws it,
 * screens.ts catches it, and screens.ts is imported BY popup.ts.
 */
export class PinRejected extends Error {
  constructor(
    message: string,
    readonly attemptsLeft: number,
  ) {
    super(message);
    this.name = "PinRejected";
  }
}
