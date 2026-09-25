import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderEditor, teardownEditor, type EditorModel } from "../../src/popup/editor";

const editModel: EditorModel = {
  mode: "edit",
  name: "GitHub",
  username: "octocat",
  uri: "https://github.com",
  otherUriCount: 2,
  hasPassword: true,
};

const createModel: EditorModel = {
  mode: "create",
  name: "",
  username: "",
  uri: "https://example.test",
  otherUriCount: 0,
  hasPassword: false,
};

let root: HTMLElement;
beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement("main");
  document.body.append(root);
});

function input(id: string): HTMLInputElement {
  const el = root.querySelector(`#${id}`);
  if (!(el instanceof HTMLInputElement)) throw new Error(`no input #${id}`);
  return el;
}

function click(selector: string): void {
  const el = root.querySelector(selector);
  if (!(el instanceof HTMLElement)) throw new Error(`no element ${selector}`);
  el.click();
}

function submit(): void {
  const form = root.querySelector("form");
  if (form === null) throw new Error("no form");
  form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
}

const noop = {
  onSave: async (): Promise<void> => {},
  onDelete: null,
  onCancel: (): void => {},
};

describe("renderEditor", () => {
  it("prefills the fields it was given and leaves the password empty", () => {
    renderEditor(root, editModel, noop);
    expect(input("editor-name").value).toBe("GitHub");
    expect(input("editor-username").value).toBe("octocat");
    expect(input("editor-uri").value).toBe("https://github.com");
    expect(input("editor-password").value).toBe("");
    expect(input("editor-password").type).toBe("password");
  });

  it("explains, in the label, why the password field is empty", () => {
    // The only way the user can learn this: the popup is never told the
    // password, so there is nothing to show and nothing else to say it.
    renderEditor(root, editModel, noop);
    expect(root.textContent).toContain("leave empty to keep");
  });

  it("says that the URLs it is not showing will survive", () => {
    renderEditor(root, editModel, noop);
    expect(root.textContent).toContain("2 further URLs");
  });

  it("says nothing about further URLs when there are none", () => {
    renderEditor(root, createModel, noop);
    expect(root.textContent).not.toContain("further URL");
  });

  it("sends null for a password left empty, so the stored one is kept", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor(root, editModel, { ...noop, onSave });
    input("editor-name").value = "GitHub renamed";
    submit();
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toEqual({
      name: "GitHub renamed",
      username: "octocat",
      uri: "https://github.com",
      password: null,
    });
  });

  it("trims what it sends", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor(root, editModel, { ...noop, onSave });
    input("editor-name").value = "  Spaced  ";
    submit();
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].name).toBe("Spaced");
  });

  it("asks before replacing a password that already exists", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor(root, editModel, { ...noop, onSave });
    input("editor-password").value = "new secret";
    submit();

    expect(onSave).not.toHaveBeenCalled();
    expect(root.textContent).toContain("existing password will be replaced");

    click("#editor-confirm");
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].password).toBe("new secret");
  });

  it("goes back from the confirmation without saving, and restores the buttons", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor(root, editModel, { ...noop, onSave });
    input("editor-password").value = "new secret";
    submit();
    click("#editor-back");
    expect(onSave).not.toHaveBeenCalled();
    expect(root.querySelector("#editor-save")).not.toBeNull();
    expect(root.querySelector("#editor-confirm")).toBeNull();
  });

  it("does not ask when the entry had no password yet", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor(root, { ...editModel, hasPassword: false }, { ...noop, onSave });
    input("editor-password").value = "first secret";
    submit();
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
  });

  it("refuses to save a new entry with no password, without asking the background", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor(root, { ...createModel, name: "Thing" }, { ...noop, onSave });
    submit();
    expect(onSave).not.toHaveBeenCalled();
    expect(root.textContent).toContain("needs a password");
  });

  it("refuses to save an entry with no name", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor(root, createModel, { ...noop, onSave });
    input("editor-password").value = "x";
    submit();
    expect(onSave).not.toHaveBeenCalled();
    expect(root.textContent).toContain("needs a name");
  });

  it("shows the reason a save was refused, keeps what was typed, and lets the user retry", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("The server could not save this change."));
    renderEditor(root, { ...createModel, name: "Thing" }, { ...noop, onSave });
    input("editor-password").value = "x";
    submit();

    await vi.waitFor(() => expect(root.textContent).toContain("could not save"));
    expect((root.querySelector("#editor-save") as HTMLButtonElement).disabled).toBe(false);
    expect(input("editor-password").value).toBe("x");
  });

  it("asks before deleting, naming the entry", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    renderEditor(root, editModel, { ...noop, onDelete });
    click("#editor-delete");
    expect(onDelete).not.toHaveBeenCalled();
    expect(root.textContent).toContain("GitHub");
    click("#editor-confirm");
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalled());
  });

  it("offers no delete button when there is nothing to delete", () => {
    renderEditor(root, createModel, noop);
    expect(root.querySelector("#editor-delete")).toBeNull();
  });

  it("calls back on cancel without saving", () => {
    const onCancel = vi.fn();
    const onSave = vi.fn();
    renderEditor(root, editModel, { ...noop, onSave, onCancel });
    click("#editor-cancel");
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("fills the password field from the generator and shows what it made", () => {
    renderEditor(root, createModel, noop);
    click("#editor-generate");
    expect(input("editor-password").value.length).toBeGreaterThanOrEqual(16);
    // A password the user cannot read is one they cannot check or write down,
    // and they asked for it a moment ago.
    expect(input("editor-password").type).toBe("text");
  });

  it("puts item names in as text, never as markup", () => {
    renderEditor(root, { ...editModel, name: "<img src=x onerror=alert(1)>" }, {
      ...noop,
      onDelete: async (): Promise<void> => {},
    });
    click("#editor-delete");
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x");
  });
});

describe("teardownEditor", () => {
  it("blanks every field before removing the form, so no typed password stays in a detached node", () => {
    renderEditor(root, createModel, noop);
    const password = input("editor-password");
    password.value = "typed but never saved";

    teardownEditor(root);

    expect(password.value).toBe("");
    expect(root.children).toHaveLength(0);
  });

  it("is harmless on a container that holds no editor", () => {
    root.append(document.createElement("p"));
    expect(() => teardownEditor(root)).not.toThrow();
    expect(root.children).toHaveLength(0);
  });
});
