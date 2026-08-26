import { errorText, PinRejected } from "./errors";

/**
 * The screens that come before the vault list: signing in, unlocking, the
 * second factor, and the handful of account actions.
 *
 * Everything here is built with `createElement`/`textContent` — never
 * `innerHTML` — and none of it stores, logs, or echoes back a secret. The
 * master password and the PIN exist only between the submit event and the
 * `onSubmit` call, and the input nodes that held them are cleared as soon as
 * that call settles.
 *
 * These functions know nothing about `browser.runtime`. The caller decides
 * what a submission means; that is what lets the popup ask for the host
 * permission from inside the very same click, which is the only place
 * Firefox will allow it (see `renderSetup`).
 */

/**
 * Restated rather than imported from session/pin.ts: that module pulls in
 * hash-wasm's Argon2 implementation, and there is no reason for the popup
 * bundle to carry a KDF just to count characters. The two must agree —
 * setup fails at `wrapKeyWithPin` otherwise, after the password has already
 * been posted.
 */
const MIN_PIN_LENGTH = 6;

/** Below this, the unlock screen starts saying how little room is left. */
const ATTEMPT_WARNING_THRESHOLD = 3;

type FieldOptions = {
  label: string;
  type: string;
  value?: string;
  placeholder?: string;
  inputMode?: string;
  autocomplete?: string;
};

function field(id: string, o: FieldOptions): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = document.createElement("label");
  row.className = "field";
  row.htmlFor = id;

  const caption = document.createElement("span");
  caption.className = "field-label";
  caption.textContent = o.label;
  row.append(caption);

  const input = document.createElement("input");
  input.id = id;
  input.type = o.type;
  if (o.value !== undefined) input.value = o.value;
  if (o.placeholder !== undefined) input.placeholder = o.placeholder;
  // `inputmode` is what puts a numeric keypad under a PIN field on a phone.
  if (o.inputMode !== undefined) input.setAttribute("inputmode", o.inputMode);
  if (o.autocomplete !== undefined) input.setAttribute("autocomplete", o.autocomplete);
  row.append(input);

  return { row, input };
}

function errorSlot(): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "error";
  // role=alert so a screen reader announces a refusal the user did not
  // scroll to.
  p.setAttribute("role", "alert");
  return p;
}

function paragraph(className: string, text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

function button(id: string, label: string, type: "submit" | "button"): HTMLButtonElement {
  const b = document.createElement("button");
  b.id = id;
  b.type = type;
  b.className = type === "submit" ? "action action-primary" : "action";
  b.textContent = label;
  return b;
}

/** The values a completed sign-in form hands to its caller. */
export type SetupValues = {
  serverUrl: string;
  email: string;
  password: string;
  pin: string;
  /**
   * The match pattern for exactly the entered server's host — computed here
   * so the caller's handler can reach `browser.permissions.request()` without
   * parsing anything first. See `renderSetup` for why that matters down to
   * the statement.
   *
   * Host only, never `origin`: Firefox match patterns have no port component
   * (bug 1362809), so `https://host:8443/*` is not a narrower pattern, it is
   * an invalid one that `permissions.request()` rejects outright — which
   * would make a Vaultwarden on a non-standard port impossible to set up. A
   * portless host pattern is what Firefox accepts, and it must be identical
   * to the one `Controller.setup` checks with `permissions.contains()`.
   */
  originPattern: string;
};

export type SetupPrefill = {
  /**
   * `reauthenticate` is a vault that is still on the device but has no
   * usable PIN — the restart policy, or a lockout that dropped the wrapped
   * key. Presenting that as a fresh sign-in reads as "my vault is gone".
   */
  mode: "new" | "reauthenticate";
  serverUrl: string;
  email: string;
};

const NEW_PREFILL: SetupPrefill = { mode: "new", serverUrl: "", email: "" };

/**
 * The master-password sign-in form.
 *
 * The submit listener is deliberately NOT async and does not await anything
 * before calling `onSubmit`. Firefox grants `permissions.request()` only
 * while a user-input handler is still on the stack, and the caller's handler
 * asks for the host permission as its first act; one `await` here — even
 * `await Promise.resolve()` — spends the gesture and every real sign-in is
 * refused. The pre-checks below are therefore all synchronous, and so is the
 * URL parse that produces `originPattern`.
 */
export function renderSetup(
  container: HTMLElement,
  onSubmit: (v: SetupValues) => Promise<void>,
  prefill: SetupPrefill = NEW_PREFILL,
): void {
  container.replaceChildren();

  const form = document.createElement("form");
  form.className = "screen";

  const reauth = prefill.mode === "reauthenticate";
  form.append(
    paragraph("screen-title", reauth ? "Sign in again" : "Sign in to your vault"),
    paragraph(
      "screen-hint",
      reauth
        ? "Your vault is still on this device, but it needs your master password again before it will open."
        : "Enter the address of your Vaultwarden server and your account details.",
    ),
  );

  const server = field("setup-server", {
    label: "Server address",
    type: "url",
    value: prefill.serverUrl,
    placeholder: "https://vault.example.net",
    autocomplete: "url",
  });
  const email = field("setup-email", {
    label: "Email",
    type: "email",
    value: prefill.email,
    autocomplete: "username",
  });
  const password = field("setup-password", {
    label: "Master password",
    type: "password",
    autocomplete: "current-password",
  });
  const pin = field("setup-pin", {
    label: `PIN for unlocking on this device (${MIN_PIN_LENGTH}+ characters)`,
    type: "password",
    inputMode: "numeric",
    autocomplete: "new-password",
  });

  const err = errorSlot();
  form.append(server.row, email.row, password.row, pin.row, err, button("setup-submit", "Sign in", "submit"));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    err.textContent = "";

    const serverUrl = server.input.value.trim();
    const address = email.input.value.trim();
    // Not trimmed, either of them. Whitespace is legal in a master password,
    // and the PIN is wrapped and unwrapped byte for byte — trimming one side
    // only would turn a correct PIN into "Incorrect PIN" forever.
    const masterPassword = password.input.value;
    const chosenPin = pin.input.value;

    let parsed: URL | null = null;
    try {
      parsed = new URL(serverUrl);
    } catch {
      parsed = null;
    }
    // https is not a preference: setup posts the derived master password
    // hash to this address. Refuse here so nothing is asked for and nothing
    // is sent.
    if (parsed === null || parsed.protocol !== "https:") {
      err.textContent = "Enter your server address as a full https:// URL.";
      return;
    }

    if (chosenPin.length < MIN_PIN_LENGTH) {
      err.textContent = `Choose a PIN of at least ${MIN_PIN_LENGTH} (six) characters.`;
      return;
    }

    void onSubmit({
      serverUrl,
      email: address,
      password: masterPassword,
      pin: chosenPin,
      // The single configured host, never the manifest's wildcard. See
      // `SetupValues.originPattern` for why the port is left out.
      originPattern: `https://${parsed.hostname}/*`,
    })
      .catch((e: unknown) => {
        err.textContent = errorText(e);
      })
      .finally(() => {
        // Even a failed sign-in clears them. This is no defence against a
        // compromised popup process, but leaving a master password sitting
        // in a live DOM node for the lifetime of the panel is gratuitous.
        password.input.value = "";
        pin.input.value = "";
      });
  });

  container.append(form);
  (prefill.serverUrl === "" ? server.input : password.input).focus();
}

/**
 * The PIN pad. This is where the popup opens on almost every launch.
 *
 * `attemptsLeft` comes from the session's real counter, never from a
 * constant here: the warning is the only notice the user gets before the
 * wrapped key is dropped and the master password becomes mandatory.
 */
export function renderUnlock(
  container: HTMLElement,
  onSubmit: (pin: string) => Promise<void>,
  attemptsLeft: number,
): void {
  container.replaceChildren();

  const form = document.createElement("form");
  form.className = "screen";
  form.append(
    // A locked vault is the normal state on open, not a failure, and must
    // not be dressed as one.
    paragraph("screen-title", "Your vault is locked."),
    paragraph("screen-hint", "Unlock with your PIN to see your entries."),
  );

  const pin = field("unlock-pin", {
    label: "PIN",
    type: "password",
    inputMode: "numeric",
    autocomplete: "current-password",
  });
  form.append(pin.row);

  const err = errorSlot();
  form.append(err, button("unlock-submit", "Unlock", "submit"));

  /**
   * Renders the warning for a given count, replacing whatever is there.
   *
   * Evaluating it once at first paint is what made C4 fail on the device: the
   * popup opens at five attempts, above the threshold, and a user who keeps
   * the panel open to type — which is the normal way to type a PIN — then
   * spends every attempt with no notice at all. Reopening the popup did show
   * it, because the counter is persisted, which is exactly why 606 tests
   * missed it. See F-2 in docs/VERIFICATION-2026-08-25.md.
   */
  let warning: HTMLElement | null = null;
  function showWarning(left: number): void {
    warning?.remove();
    warning = null;
    if (left > ATTEMPT_WARNING_THRESHOLD) return;
    const plural = left === 1 ? "1 attempt" : `${left} attempts`;
    warning = paragraph("warn", `${plural} remaining before your master password is required.`);
    form.insertBefore(warning, err);
  }
  showWarning(attemptsLeft);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    err.textContent = "";

    const entered = pin.input.value;
    if (entered === "") {
      // An empty submit would otherwise spend one of the few attempts the
      // user has left.
      err.textContent = "Enter your PIN to unlock.";
      return;
    }

    void onSubmit(entered)
      .catch((e: unknown) => {
        err.textContent = errorText(e);
        // The rejection carries the fresh count, so the warning moves with it
        // rather than staying at whatever the screen was painted with.
        if (e instanceof PinRejected) showWarning(e.attemptsLeft);
      })
      .finally(() => {
        pin.input.value = "";
      });
  });

  container.append(form);
  pin.input.focus();
}

export type TwoFactorValues = { token: string; provider: number };

/**
 * The providers this add-on can actually complete. Vaultwarden also offers
 * WebAuthn (7), Duo (2/6) and YubiKey (3), none of which can be satisfied
 * from a panel with a text box in it — rendering a code field for one of
 * those is a form that cannot succeed no matter what is typed into it.
 */
const PROVIDERS: { id: number; name: string; prompt: string }[] = [
  { id: 0, name: "Authenticator app", prompt: "Enter the code from your authenticator app." },
  { id: 1, name: "Email", prompt: "Enter the code sent to your email address." },
];

export function renderTwoFactor(
  container: HTMLElement,
  providers: number[],
  onSubmit: (v: TwoFactorValues) => Promise<void>,
): void {
  container.replaceChildren();

  const usable = PROVIDERS.filter((p) => providers.includes(p.id));

  if (usable.length === 0) {
    container.append(
      paragraph("screen-title", "Two-factor sign-in needed"),
      paragraph(
        "screen-hint",
        "Your account requires a two-factor method this add-on cannot complete, such as " +
          "a security key. Sign in with a full Bitwarden client once, or enable the " +
          "authenticator-app or email method on your account, then try again.",
      ),
    );
    return;
  }

  const form = document.createElement("form");
  form.className = "screen";
  form.append(paragraph("screen-title", "Two-factor sign-in"));

  // Element/provider pairs rather than parsing a radio's string value back
  // into a number: the id stays a number the whole way to the server.
  const choices: { input: HTMLInputElement; id: number }[] = [];

  if (usable.length === 1) {
    const only = usable[0];
    if (only !== undefined) form.append(paragraph("screen-hint", only.prompt));
  } else {
    form.append(paragraph("screen-hint", "Choose how you want to confirm this sign-in."));
    for (const [index, p] of usable.entries()) {
      const row = document.createElement("label");
      row.className = "choice";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "tf-provider";
      radio.id = `tf-provider-${String(p.id)}`;
      radio.checked = index === 0;
      row.append(radio);

      const caption = document.createElement("span");
      caption.textContent = p.name;
      row.append(caption);

      form.append(row);
      choices.push({ input: radio, id: p.id });
    }
  }

  const code = field("tf-code", {
    label: "Code",
    type: "text",
    inputMode: "numeric",
    autocomplete: "one-time-code",
  });
  const err = errorSlot();
  form.append(code.row, err, button("tf-submit", "Verify", "submit"));

  function chosenProvider(): number {
    for (const c of choices) {
      if (c.input.checked) return c.id;
    }
    return usable[0]?.id ?? 0;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    err.textContent = "";

    const token = code.input.value.trim();
    if (token === "") {
      err.textContent = "Enter the code to continue.";
      return;
    }

    void onSubmit({ token, provider: chosenProvider() }).catch((e: unknown) => {
      err.textContent = errorText(e);
    });
  });

  container.append(form);
  code.input.focus();
}

export type SettingsHandlers = {
  onSync: () => Promise<void>;
  onLock: () => Promise<void>;
  onSignOut: () => Promise<void>;
};

/**
 * The account actions for an unlocked vault.
 *
 * `signOut` is the only way to get `protectedUserKey`, `pinWrapped`, the
 * wrapped refresh token and the cipher cache off the device short of
 * uninstalling the add-on — and it is also the only irreversible thing in
 * this panel. Hence the second tap: on a phone these controls sit under a
 * thumb, and one mistap must not wipe the vault copy.
 */
export function renderSettings(container: HTMLElement, handlers: SettingsHandlers): void {
  container.replaceChildren();

  const err = errorSlot();

  const row = document.createElement("div");
  row.className = "settings-row";

  const sync = button("settings-sync", "Sync now", "button");
  const lock = button("settings-lock", "Lock", "button");
  const signOut = button("settings-signout", "Sign out", "button");
  signOut.classList.add("action-danger");
  row.append(sync, lock, signOut);

  const confirm = document.createElement("div");
  confirm.className = "settings-confirm";
  confirm.hidden = true;
  const yes = button("settings-signout-confirm", "Sign out", "button");
  yes.classList.add("action-danger");
  const no = button("settings-signout-cancel", "Cancel", "button");
  confirm.append(
    paragraph("warn", "This deletes the vault copy on this device. Sign out?"),
    yes,
    no,
  );

  function run(handler: () => Promise<void>): void {
    err.textContent = "";
    // The caller reports what it wants to report — a failed sync belongs in
    // the list banner, not here — but a rejection it does not handle must
    // still land somewhere visible instead of in an unhandled promise.
    void handler().catch((e: unknown) => {
      err.textContent = errorText(e);
    });
  }

  sync.addEventListener("click", () => {
    run(handlers.onSync);
  });
  lock.addEventListener("click", () => {
    run(handlers.onLock);
  });
  signOut.addEventListener("click", () => {
    err.textContent = "";
    signOut.hidden = true;
    confirm.hidden = false;
  });
  no.addEventListener("click", () => {
    confirm.hidden = true;
    signOut.hidden = false;
  });
  yes.addEventListener("click", () => {
    run(handlers.onSignOut);
  });

  container.append(row, confirm, err);
}
