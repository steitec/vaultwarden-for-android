import { Controller } from "./controller";
import { Session } from "../session/session";
import { browserStore } from "../session/store";
import { isRequest, type Request, type Response } from "./messages";

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
 * Both of those checks are synchronous, and stay that way even though every
 * accepted message then waits on `ready`: a declined message must produce
 * `undefined` immediately, not a promise. See `dispatch` below.
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
  ready: Promise<void>,
): Promise<Response> | undefined {
  if (sender.id !== browser.runtime.id) return undefined;
  if (!isRequest(msg)) return undefined;
  return dispatch(controller, msg, ready);
}

/**
 * Runs one accepted request, once the controller has finished loading.
 *
 * `ready` is threaded in as a parameter rather than read from module state
 * so that this file's only mutable startup value stays at the bottom, next
 * to the listener registration, and so the tests drive the same code path
 * the runtime does.
 *
 * Waiting matters for `status` above all: until `store.load()` resolves the
 * session reports "empty", so a status answered in that window sends the
 * popup to "Sign in to your vault" for an account that exists. Opening the
 * popup immediately after Firefox starts is exactly that window.
 *
 * A failed load is reported, not swallowed. The sender gets an Error whose
 * message the popup renders verbatim (see popup/errors.ts, which never
 * renders `.cause`), so it says what the user can do and nothing about what
 * actually failed.
 */
async function dispatch(
  controller: Controller,
  msg: Request,
  ready: Promise<void>,
): Promise<Response> {
  try {
    await ready;
  } catch {
    throw new Error("The add-on could not read its saved data. Restart Firefox and try again.");
  }

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

// Held, not fire-and-forget. The listener is registered on the next line and
// messages can arrive before the stored account has been read; every accepted
// one waits on this promise (see `dispatch`), and a rejection reaches the
// popup as an error rather than disappearing.
const ready = controller.init();

// If no message ever arrives, nothing awaits `ready`, and a rejected startup
// would be reported as an unhandled rejection. This handler exists only to
// mark it as observed. It does not consume the rejection: `ready` itself is
// unaffected and still rejects for the dispatcher that awaits it.
void ready.catch(() => {});

browser.runtime.onMessage.addListener((msg: unknown, sender: browser.runtime.MessageSender) =>
  handleMessage(controller, msg, sender, ready),
);
