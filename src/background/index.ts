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
 * The sender check is the whole security boundary of the background page.
 * `browser.runtime.onMessage` is reachable by any OTHER installed extension
 * that knows this extension's ID (it is visible in about:debugging), and
 * every capability behind this switch is one it would otherwise get for
 * free: `{kind:"unlock",pin}` is an offline PIN brute-force oracle running
 * at native speed, `{kind:"list"}` enumerates the vault, and
 * `{kind:"fill"}` exfiltrates a password into any tab it likes. The same
 * check guards the content script's listener, for the same reason; this one
 * is a layer deeper and strictly more valuable to an attacker.
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
