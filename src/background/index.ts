import { Controller } from "./controller";
import { Session } from "../session/session";
import { browserStore } from "../session/store";
import { isRequest, type Response } from "./messages";

/**
 * Dispatches one runtime message to the controller.
 *
 * Returns `undefined` — not a rejected promise — for anything it declines
 * to handle, which is what tells the WebExtension runtime "this listener
 * has no answer" and leaves the sender's `sendMessage` unresolved rather
 * than handing back an error that confirms the extension is installed.
 *
 * The sender check narrows this listener to messages from this extension's
 * own pages. It is defence in depth, not the sole thing standing between an
 * attacker and the vault, and the comment that used to be here overstated it:
 * under Firefox MV2 a message from a DIFFERENT extension is delivered to
 * `runtime.onMessageExternal`, never to `onMessage`, and this extension
 * registers no `onMessageExternal` listener and declares no
 * `externally_connectable`. So there is no known cross-extension route into
 * this switch today.
 *
 * The check stays regardless, because it costs one comparison and the
 * capabilities behind this switch are exactly the ones worth protecting from
 * any sender that turns out to reach them: `{kind:"unlock",pin}` is a PIN
 * brute-force oracle running at native speed, `{kind:"list"}` enumerates the
 * vault, and `{kind:"fill"}` pushes a password into a tab. What it does
 * concretely defend against is a future manifest or listener change that
 * opens such a route, and any in-extension page that should not be talking to
 * the controller. The content script's listener carries the same check, for
 * the same reason.
 */
export function handleMessage(
  controller: Controller,
  msg: unknown,
  sender: browser.runtime.MessageSender,
): Promise<Response> | undefined {
  if (sender.id !== browser.runtime.id) return undefined;
  if (!isRequest(msg)) return undefined;

  switch (msg.kind) {
    case "status":
      return Promise.resolve(controller.status());
    case "unlock":
      return controller.unlock(msg.pin);
    case "lock":
      controller.lock();
      return Promise.resolve();
    case "signOut":
      return controller.signOut();
    case "list":
      return controller.list(msg.query);
    case "matches":
      return controller.matchesFor(msg.pageUrl);
    case "fill":
      return controller.fill(msg.tabId, msg.itemId);
    case "totp":
      return controller.totpFor(msg.itemId);
    case "setup":
      // Fields are forwarded explicitly rather than spreading `msg`, so the
      // message envelope (`kind`, and anything a future sender bolts on)
      // never reaches the login path.
      return controller.setup({
        serverUrl: msg.serverUrl,
        email: msg.email,
        password: msg.password,
        pin: msg.pin,
        twoFactor: msg.twoFactor,
      });
    case "sync":
      return controller.syncNow();
  }

  // Compile-time exhaustiveness check. A new Request kind added without a
  // case above fails to narrow to `never` here and breaks the build, rather
  // than falling into a runtime `default: throw` that nothing tests.
  const unhandled: never = msg;
  return unhandled;
}

const controller = new Controller(new Session(browserStore));
void controller.init();

browser.runtime.onMessage.addListener((msg: unknown, sender: browser.runtime.MessageSender) =>
  handleMessage(controller, msg, sender),
);
