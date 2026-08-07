import { describe, it, expect, beforeEach, vi } from "vitest";

// The module under test registers a browser.runtime.onMessage listener at
// import time (it is injected on demand by the background page). `browser`
// does not exist under jsdom. Static `import` declarations are hoisted
// ahead of any other statement per ES module semantics -- writing
// `vi.stubGlobal` textually above a static `import` does not run it first
// -- so the module must be loaded via a dynamic `import()` after the stub
// is in place. This is a test-environment shim only; the source module
// still assumes the real WebExtension `browser` global at runtime.
vi.stubGlobal("browser", { runtime: { onMessage: { addListener: () => {} } } });

const { findLoginFields, fillFields } = await import("../../src/content/autofill");

function setBody(html: string) {
  document.body.innerHTML = html;
}

beforeEach(() => setBody(""));

describe("findLoginFields", () => {
  it("finds a standard username and password pair", () => {
    setBody(`<form><input type="text" name="username"><input type="password" name="password"></form>`);
    const f = findLoginFields(document);
    expect(f.username!.getAttribute("name")).toBe("username");
    expect(f.password!.type).toBe("password");
  });

  it("recognises an email input as the username field", () => {
    setBody(`<form><input type="email" id="email"><input type="password"></form>`);
    expect(findLoginFields(document).username!.id).toBe("email");
  });

  it("handles a password-only step in a multi-step form", () => {
    setBody(`<form><input type="password" name="pass"></form>`);
    const f = findLoginFields(document);
    expect(f.username).toBeNull();
    expect(f.password).not.toBeNull();
  });

  it("handles an email-only first step", () => {
    setBody(`<form><input type="email" name="email"></form>`);
    const f = findLoginFields(document);
    expect(f.username).not.toBeNull();
    expect(f.password).toBeNull();
  });

  it("picks the input immediately before the password field when several text inputs exist", () => {
    setBody(`<form>
      <input type="text" name="search">
      <input type="text" name="user">
      <input type="password" name="pw">
    </form>`);
    expect(findLoginFields(document).username!.getAttribute("name")).toBe("user");
  });

  it("ignores hidden and disabled inputs", () => {
    setBody(`<form>
      <input type="hidden" name="csrf">
      <input type="text" name="user" disabled>
      <input type="text" name="realuser">
      <input type="password" name="pw">
    </form>`);
    expect(findLoginFields(document).username!.getAttribute("name")).toBe("realuser");
  });

  it("returns nulls when there is no login form", () => {
    setBody(`<div>no form here</div>`);
    const f = findLoginFields(document);
    expect(f.username).toBeNull();
    expect(f.password).toBeNull();
  });
});

describe("fillFields", () => {
  it("fills both fields and reports what it filled", () => {
    setBody(`<form><input type="text" name="u"><input type="password" name="p"></form>`);
    const r = fillFields(document, { username: "octocat", password: "hunter2" });
    expect(r).toEqual({ filledUsername: true, filledPassword: true });
    expect(document.querySelector<HTMLInputElement>('[name="u"]')!.value).toBe("octocat");
    expect(document.querySelector<HTMLInputElement>('[name="p"]')!.value).toBe("hunter2");
  });

  it("dispatches input and change events so frameworks observe the value", () => {
    setBody(`<form><input type="text" name="u"><input type="password" name="p"></form>`);
    const input = document.querySelector<HTMLInputElement>('[name="u"]')!;
    const seen: string[] = [];
    input.addEventListener("input", () => seen.push("input"));
    input.addEventListener("change", () => seen.push("change"));

    fillFields(document, { username: "octocat", password: null });
    expect(seen).toEqual(["input", "change"]);
  });

  it("uses the native value setter rather than assigning the property", () => {
    setBody(`<form><input type="text" name="u"><input type="password" name="p"></form>`);
    const input = document.querySelector<HTMLInputElement>('[name="u"]')!;

    // Emulate React's value tracking: shadow the property on the instance.
    let shadowed = "";
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => shadowed,
      set: () => { /* a framework would discard a direct assignment */ },
    });

    fillFields(document, { username: "octocat", password: null });

    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.get!;
    expect(native.call(input)).toBe("octocat");
  });

  it("reports false for a field that is not present", () => {
    setBody(`<form><input type="password" name="p"></form>`);
    expect(fillFields(document, { username: "octocat", password: "hunter2" }))
      .toEqual({ filledUsername: false, filledPassword: true });
  });

  it("skips a null credential without clearing the field", () => {
    setBody(`<form><input type="text" name="u" value="existing"><input type="password" name="p"></form>`);
    fillFields(document, { username: null, password: "hunter2" });
    expect(document.querySelector<HTMLInputElement>('[name="u"]')!.value).toBe("existing");
  });

  it("skips a null password without clearing an existing password field", () => {
    setBody(`<form><input type="text" name="u"><input type="password" name="p" value="oldpw"></form>`);
    fillFields(document, { username: "octocat", password: null });
    expect(document.querySelector<HTMLInputElement>('[name="p"]')!.value).toBe("oldpw");
  });

  it("does not throw and fills nothing when both credentials are null", () => {
    setBody(`<form><input type="text" name="u" value="existing"><input type="password" name="p" value="oldpw"></form>`);
    const r = fillFields(document, { username: null, password: null });
    expect(r).toEqual({ filledUsername: false, filledPassword: false });
    expect(document.querySelector<HTMLInputElement>('[name="u"]')!.value).toBe("existing");
    expect(document.querySelector<HTMLInputElement>('[name="p"]')!.value).toBe("oldpw");
  });
});
