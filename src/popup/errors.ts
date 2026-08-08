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
