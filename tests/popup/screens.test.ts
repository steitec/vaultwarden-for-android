import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  renderSetup,
  renderUnlock,
  renderTwoFactor,
  renderSettings,
} from "../../src/popup/screens";

// These screens are the only place in the add-on where a master password and
// a PIN are typed. Everything asserted below is either "the secret does not
// linger" or "the handler is not reached with something that cannot work" —
// there is nothing cosmetic here.

/**
 * Narrows instead of casting. `root.querySelector("#x") as HTMLInputElement`
 * would silently hand back `null` typed as an input and fail later on
 * `.value` with a message about undefined; this fails on the line that is
 * actually wrong.
 */
function input(scope: ParentNode, selector: string): HTMLInputElement {
  const found = scope.querySelector(selector);
  if (!(found instanceof HTMLInputElement)) throw new Error(`no input matching ${selector}`);
  return found;
}

function el(scope: ParentNode, selector: string): HTMLElement {
  const found = scope.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`no element matching ${selector}`);
  return found;
}

function submit(scope: ParentNode): void {
  const form = scope.querySelector("form");
  if (!(form instanceof HTMLFormElement)) throw new Error("no form to submit");
  form.dispatchEvent(new Event("submit", { cancelable: true }));
}

let root: HTMLElement;
beforeEach(() => {
  document.body.replaceChildren();
  const div = document.createElement("div");
  div.id = "root";
  document.body.append(div);
  root = div;
});

const GOOD_SETUP = {
  server: "https://vault.example.net",
  email: "a@b.com",
  password: "master",
  pin: "135790",
};

function fillSetup(over: Partial<typeof GOOD_SETUP> = {}): void {
  const v = { ...GOOD_SETUP, ...over };
  input(root, "#setup-server").value = v.server;
  input(root, "#setup-email").value = v.email;
  input(root, "#setup-password").value = v.password;
  input(root, "#setup-pin").value = v.pin;
}

describe("renderSetup", () => {
  it("collects server url, email, master password, and pin", () => {
    renderSetup(root, async () => {});
    for (const id of ["setup-server", "setup-email", "setup-password", "setup-pin"]) {
      expect(root.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it("never shows the master password or the pin as readable text", () => {
    renderSetup(root, async () => {});
    expect(input(root, "#setup-password").type).toBe("password");
    expect(input(root, "#setup-pin").type).toBe("password");
    expect(input(root, "#setup-pin").getAttribute("inputmode")).toBe("numeric");
  });

  it("submits the entered values together with the origin to ask permission for", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderSetup(root, onSubmit);
    fillSetup();
    submit(root);
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith({
      serverUrl: "https://vault.example.net",
      email: "a@b.com",
      password: "master",
      pin: "135790",
    });
  });

  it("passes a server on a non-standard port through with its port intact", async () => {
    // Until 2026-08-27 this asserted the opposite for the permission
    // pattern: Firefox match patterns have no port (bug 1362809), so the
    // form also produced a portless `originPattern`. The grant is gone
    // (§ F-3) and only the server url is left, which keeps everything the
    // user typed.
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderSetup(root, onSubmit);
    fillSetup({ server: "https://vault.example.net:8443/vault/" });
    submit(root);
    await Promise.resolve();

    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      serverUrl: "https://vault.example.net:8443/vault/",
    });
  });

  it("trims the server url and the email but never the master password", async () => {
    // Leading/trailing whitespace is legal in a master password. Trimming it
    // produces a wrong-password error the user has no way to explain.
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderSetup(root, onSubmit);
    fillSetup({
      server: "  https://vault.example.net  ",
      email: "  a@b.com ",
      password: "  spaced out  ",
    });
    submit(root);
    await Promise.resolve();

    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      serverUrl: "https://vault.example.net",
      email: "a@b.com",
      password: "  spaced out  ",
    });
  });

  it("rejects a non-https server url before calling the handler", async () => {
    const onSubmit = vi.fn();
    for (const bad of ["http://vault.example.net", "ftp://vault.example.net"]) {
      renderSetup(root, onSubmit);
      fillSetup({ server: bad });
      submit(root);
      await Promise.resolve();
      expect(el(root, ".error").textContent).toMatch(/https/i);
    }
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("rejects an unparseable server url before calling the handler", async () => {
    const onSubmit = vi.fn();
    for (const bad of ["vault.example.net", "not a url", ""]) {
      renderSetup(root, onSubmit);
      fillSetup({ server: bad });
      submit(root);
      await Promise.resolve();
      expect(el(root, ".error").textContent).toMatch(/https/i);
    }
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("rejects a pin shorter than six characters before calling the handler", async () => {
    const onSubmit = vi.fn();
    renderSetup(root, onSubmit);
    fillSetup({ pin: "123" });
    submit(root);
    await Promise.resolve();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(el(root, ".error").textContent).toMatch(/six|6/i);
  });

  it("clears the master password and pin out of the DOM after a successful submit", async () => {
    // The panel outlives the submit. A master password sitting in a live
    // input for the rest of that lifetime is gratuitous.
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderSetup(root, onSubmit);
    const password = input(root, "#setup-password");
    const pin = input(root, "#setup-pin");
    fillSetup();
    submit(root);
    await vi.waitFor(() => expect(password.value).toBe(""));
    expect(pin.value).toBe("");
  });

  it("clears them after a failed submit too", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Email or password incorrect"));
    renderSetup(root, onSubmit);
    const password = input(root, "#setup-password");
    const pin = input(root, "#setup-pin");
    fillSetup();
    submit(root);
    await vi.waitFor(() => expect(el(root, ".error").textContent).toMatch(/incorrect/i));
    expect(password.value).toBe("");
    expect(pin.value).toBe("");
  });

  it("shows a rejection's message and never the server-controlled cause", async () => {
    const failure = new Error("The server returned a response this client could not parse.");
    failure.cause = new SyntaxError("Unexpected token < in JSON at position 0: <html>pwned</html>");
    renderSetup(root, vi.fn().mockRejectedValue(failure));
    fillSetup();
    submit(root);

    await vi.waitFor(() => expect(el(root, ".error").textContent).toMatch(/could not parse/i));
    expect(root.textContent).not.toContain("pwned");
  });

  it("prefills a re-authentication and says that is what it is", () => {
    // A locked vault with no usable PIN lands here. It is not a new account,
    // and presenting an empty form reads as one.
    renderSetup(root, async () => {}, {
      mode: "reauthenticate",
      serverUrl: "https://vault.example.net",
      email: "a@b.com",
      unlockMode: "pin",
    });

    expect(input(root, "#setup-server").value).toBe("https://vault.example.net");
    expect(input(root, "#setup-email").value).toBe("a@b.com");
    expect(root.textContent).toMatch(/again|re-?authenticat/i);
    // Still editable: the server may have moved.
    expect(input(root, "#setup-server").readOnly).toBe(false);
    expect(input(root, "#setup-email").readOnly).toBe(false);
  });

  // An account that unlocks per session comes back through this form after
  // every Firefox restart. Asking for a PIN there would be asking the user to
  // undo the setting they chose, once a day, without saying so.
  it("asks for no PIN when a session-mode account re-authenticates", () => {
    renderSetup(root, async () => {}, {
      mode: "reauthenticate",
      serverUrl: "https://vault.example.net",
      email: "a@b.com",
      unlockMode: "session",
    });

    expect(root.querySelector("#setup-pin")).toBeNull();
    expect(root.textContent).not.toMatch(/PIN/i);
  });

  it("signs a session-mode account in without one", async () => {
    const onSubmit = vi.fn(async () => {});
    renderSetup(root, onSubmit, {
      mode: "reauthenticate",
      serverUrl: "https://vault.example.net",
      email: "a@b.com",
      unlockMode: "session",
    });

    input(root, "#setup-password").value = "correct-horse";
    submit(root);
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith({
      serverUrl: "https://vault.example.net",
      email: "a@b.com",
      password: "correct-horse",
      pin: "",
    });
  });

  it("still asks for a PIN when a pin-mode account re-authenticates", () => {
    renderSetup(root, async () => {}, {
      mode: "reauthenticate",
      serverUrl: "https://vault.example.net",
      email: "a@b.com",
      unlockMode: "pin",
    });

    expect(root.querySelector("#setup-pin")).not.toBeNull();
  });

  it("replaces whatever the container held instead of appending to it", () => {
    renderSetup(root, async () => {});
    renderSetup(root, async () => {});
    expect(root.querySelectorAll("form")).toHaveLength(1);
  });
});

describe("renderUnlock", () => {
  it("shows a numeric pin field", () => {
    renderUnlock(root, async () => {}, 5);
    const pin = input(root, "#unlock-pin");
    expect(pin.type).toBe("password");
    expect(pin.getAttribute("inputmode")).toBe("numeric");
  });

  it("presents a locked vault as the normal state, not an error", () => {
    renderUnlock(root, async () => {}, 5);
    expect(root.textContent).toMatch(/locked/i);
    expect(root.querySelector(".message-error")).toBeNull();
  });

  it("warns as attempts run out", () => {
    renderUnlock(root, async () => {}, 2);
    expect(root.textContent).toMatch(/2 attempts/i);
    expect(root.textContent).toMatch(/master password/i);
  });

  it("counts the last attempt in the singular", () => {
    renderUnlock(root, async () => {}, 1);
    expect(root.textContent).toMatch(/1 attempt remaining/i);
  });

  it("does not warn when attempts are plentiful", () => {
    renderUnlock(root, async () => {}, 5);
    expect(root.textContent).not.toMatch(/attempts/i);
  });

  it("submits the pin", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderUnlock(root, onSubmit, 5);
    input(root, "#unlock-pin").value = "135790";
    submit(root);
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith("135790");
  });

  it("clears the pin out of the DOM afterwards, including after a wrong one", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Incorrect PIN"));
    renderUnlock(root, onSubmit, 4);
    const pin = input(root, "#unlock-pin");
    pin.value = "000000";
    submit(root);
    await vi.waitFor(() => expect(el(root, ".error").textContent).toMatch(/incorrect pin/i));
    expect(pin.value).toBe("");
  });

  it("does not call the handler with an empty pin", async () => {
    const onSubmit = vi.fn();
    renderUnlock(root, onSubmit, 5);
    submit(root);
    await Promise.resolve();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("renderTwoFactor", () => {
  it("labels the authenticator provider", () => {
    renderTwoFactor(root, [0], async () => {});
    expect(root.textContent).toMatch(/authenticator/i);
  });

  it("labels the email provider", () => {
    renderTwoFactor(root, [1], async () => {});
    expect(root.textContent).toMatch(/email/i);
  });

  it("submits the code with the only offered provider", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderTwoFactor(root, [1], onSubmit);
    input(root, "#tf-code").value = "123456";
    submit(root);
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith({ token: "123456", provider: 1 });
  });

  it("lets the user choose when more than one provider is usable", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderTwoFactor(root, [0, 1], onSubmit);

    const email = input(root, "#tf-provider-1");
    expect(email.type).toBe("radio");
    email.checked = true;
    input(root, "#tf-code").value = "123456";
    submit(root);
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith({ token: "123456", provider: 1 });
  });

  it("drops providers this add-on cannot complete", () => {
    // 7 is WebAuthn: there is no way to complete it from this panel, and
    // offering it renders a code box that can never be satisfied.
    renderTwoFactor(root, [7, 0], async () => {});
    expect(root.querySelector("#tf-provider-7")).toBeNull();
    expect(root.querySelector("#tf-code")).not.toBeNull();
  });

  it("says so plainly when no offered provider is usable, instead of a dead form", () => {
    renderTwoFactor(root, [7], async () => {});
    expect(root.querySelector("form")).toBeNull();
    expect(root.querySelector("#tf-code")).toBeNull();
    expect(root.textContent).toMatch(/cannot|can't|not supported/i);
  });

  it("does not call the handler with an empty code", async () => {
    const onSubmit = vi.fn();
    renderTwoFactor(root, [0], onSubmit);
    submit(root);
    await Promise.resolve();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows a rejection's message without the cause", async () => {
    const failure = new Error("That code was not accepted. Try again.");
    failure.cause = new Error("<html>pwned</html>");
    renderTwoFactor(root, [0], vi.fn().mockRejectedValue(failure));
    input(root, "#tf-code").value = "000000";
    submit(root);
    await vi.waitFor(() => expect(el(root, ".error").textContent).toMatch(/not accepted/i));
    expect(root.textContent).not.toContain("pwned");
  });
});

describe("renderSettings", () => {
  function handlers() {
    return {
      onSync: vi.fn().mockResolvedValue(undefined),
      onLock: vi.fn().mockResolvedValue(undefined),
      onSignOut: vi.fn().mockResolvedValue(undefined),
      onSetUnlockMode: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("offers sync, lock, and sign out", () => {
    renderSettings(root, "pin", handlers());
    expect(root.querySelector("#settings-sync")).not.toBeNull();
    expect(root.querySelector("#settings-lock")).not.toBeNull();
    expect(root.querySelector("#settings-signout")).not.toBeNull();
  });

  it("syncs on tap", async () => {
    const h = handlers();
    renderSettings(root, "pin", h);
    el(root, "#settings-sync").dispatchEvent(new Event("click", { bubbles: true }));
    await vi.waitFor(() => expect(h.onSync).toHaveBeenCalled());
  });

  it("locks on tap", async () => {
    const h = handlers();
    renderSettings(root, "pin", h);
    el(root, "#settings-lock").dispatchEvent(new Event("click", { bubbles: true }));
    await vi.waitFor(() => expect(h.onLock).toHaveBeenCalled());
  });

  it("does NOT sign out on the first tap", async () => {
    // One mistap on a phone must not wipe the device copy of the vault.
    const h = handlers();
    renderSettings(root, "pin", h);
    el(root, "#settings-signout").dispatchEvent(new Event("click", { bubbles: true }));
    await Promise.resolve();

    expect(h.onSignOut).not.toHaveBeenCalled();
    expect(root.textContent).toMatch(/deletes the vault copy on this device/i);
    expect(root.querySelector("#settings-signout-confirm")).not.toBeNull();
  });

  it("signs out only after the confirmation is tapped", async () => {
    const h = handlers();
    renderSettings(root, "pin", h);
    el(root, "#settings-signout").dispatchEvent(new Event("click", { bubbles: true }));
    el(root, "#settings-signout-confirm").dispatchEvent(new Event("click", { bubbles: true }));
    await vi.waitFor(() => expect(h.onSignOut).toHaveBeenCalledTimes(1));
  });

  it("backs out of the confirmation without signing out", async () => {
    const h = handlers();
    renderSettings(root, "pin", h);
    el(root, "#settings-signout").dispatchEvent(new Event("click", { bubbles: true }));
    el(root, "#settings-signout-cancel").dispatchEvent(new Event("click", { bubbles: true }));
    await Promise.resolve();

    expect(h.onSignOut).not.toHaveBeenCalled();
    expect(el(root, "#settings-signout").hidden).toBe(false);
  });

  it("reports a failed action instead of dropping it silently", async () => {
    const h = handlers();
    h.onLock.mockRejectedValue(new Error("The add-on is not responding."));
    renderSettings(root, "pin", h);
    el(root, "#settings-lock").dispatchEvent(new Event("click", { bubbles: true }));
    await vi.waitFor(() => expect(el(root, ".error").textContent).toMatch(/not responding/i));
  });
});

describe("the unlock-mode switch", () => {
  function handlers() {
    return {
      onSync: vi.fn().mockResolvedValue(undefined),
      onLock: vi.fn().mockResolvedValue(undefined),
      onSignOut: vi.fn().mockResolvedValue(undefined),
      onSetUnlockMode: vi.fn().mockResolvedValue(undefined),
    };
  }

  function tap(selector: string): void {
    el(root, selector).dispatchEvent(new Event("click", { bubbles: true }));
  }

  // Turning the PIN off lowers what protects the account. On a phone these
  // controls sit under a thumb, which is the same argument the sign-out
  // confirmation is built on.
  it("does not turn the PIN off on the first tap", async () => {
    const h = handlers();
    renderSettings(root, "pin", h);

    tap("#settings-pinless");
    await Promise.resolve();

    expect(h.onSetUnlockMode).not.toHaveBeenCalled();
    expect(root.textContent).toMatch(/only your master password/i);
    expect(root.textContent).toMatch(/stays open until you tap Lock/i);
    expect(root.textContent).toMatch(/stays in memory only/i);
    expect(root.textContent).toMatch(/PIN is discarded/i);
  });

  it("turns the PIN off on the second tap", async () => {
    const h = handlers();
    renderSettings(root, "pin", h);

    tap("#settings-pinless");
    tap("#settings-pinless-confirm");

    await vi.waitFor(() => expect(h.onSetUnlockMode).toHaveBeenCalledWith("session"));
  });

  it("backs out of the warning without changing anything", async () => {
    const h = handlers();
    renderSettings(root, "pin", h);

    tap("#settings-pinless");
    tap("#settings-pinless-cancel");
    await Promise.resolve();

    expect(h.onSetUnlockMode).not.toHaveBeenCalled();
    expect(el(root, "#settings-pinless").hidden).toBe(false);
  });

  it("offers no pinless switch to an account that already unlocks per session", () => {
    renderSettings(root, "session", handlers());
    expect(root.querySelector("#settings-pinless")).toBeNull();
    expect(root.querySelector("#settings-new-pin")).not.toBeNull();
  });

  // Checked here as well as in wrapKeyWithPin: reaching the KDF only to be
  // refused would spend seconds saying what a length check says at once.
  it("refuses a PIN under six characters without calling the handler", async () => {
    const h = handlers();
    renderSettings(root, "session", h);

    input(root, "#settings-new-pin").value = "12345";
    submit(root);
    await Promise.resolve();

    expect(h.onSetUnlockMode).not.toHaveBeenCalled();
    expect(el(root, ".error").textContent).toMatch(/six/i);
  });

  it("turns the PIN back on and does not leave it in the field", async () => {
    const h = handlers();
    renderSettings(root, "session", h);
    const pin = input(root, "#settings-new-pin");

    pin.value = "246810";
    submit(root);

    await vi.waitFor(() => expect(h.onSetUnlockMode).toHaveBeenCalledWith("pin", "246810"));
    await vi.waitFor(() => expect(pin.value).toBe(""));
  });

  it("clears the new PIN out of the DOM after a failed change too", async () => {
    const h = handlers();
    h.onSetUnlockMode.mockRejectedValue(new Error("The add-on is not responding."));
    renderSettings(root, "session", h);
    const pin = input(root, "#settings-new-pin");

    pin.value = "246810";
    submit(root);

    await vi.waitFor(() => expect(el(root, ".error").textContent).toMatch(/not responding/i));
    expect(pin.value).toBe("");
  });
});
