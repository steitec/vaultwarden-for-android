import { button, errorSlot, field, paragraph } from "./screens";
import { errorText } from "./errors";
import { generatePassword } from "./generator";
import type { ItemDraftMessage } from "../background/messages";

export type EditorModel = {
  mode: "create" | "edit";
  name: string;
  username: string;
  uri: string;
  /** How many URLs the single URL field is not showing. */
  otherUriCount: number;
  hasPassword: boolean;
};

export type EditorHandlers = {
  onSave: (draft: ItemDraftMessage) => Promise<void>;
  /** null when there is nothing to delete, i.e. in create mode. */
  onDelete: (() => Promise<void>) | null;
  onCancel: () => void;
};

/**
 * Swaps the button row for a question.
 *
 * Inline rather than `confirm()`, which is unreliable inside a popup on
 * Android and would also be a modal covering the form it is asking about. The
 * original buttons are kept and put back, so Back really is a return to where
 * the user was rather than a re-render that loses what they typed.
 */
function askConfirmation(
  actions: HTMLElement,
  question: string,
  proceedLabel: string,
  run: () => void,
): void {
  const original = [...actions.children];
  const restore = (): void => actions.replaceChildren(...original);

  const proceed = button("editor-confirm", proceedLabel, "button");
  proceed.className = "action action-primary";
  proceed.addEventListener("click", () => {
    restore();
    run();
  });

  const back = button("editor-back", "Back", "button");
  back.addEventListener("click", restore);

  // paragraph() sets textContent, never innerHTML: the question carries an
  // entry name, and an entry name is whatever the vault says it is.
  actions.replaceChildren(paragraph("confirm-question", question), proceed, back);
}

export function renderEditor(
  container: HTMLElement,
  model: EditorModel,
  handlers: EditorHandlers,
): void {
  container.replaceChildren();

  const form = document.createElement("form");
  form.className = "editor";
  // The browser's own validation bubbles are unreadable in a popup, and every
  // refusal is already reported in the form's own error slot.
  form.noValidate = true;

  const name = field("editor-name", { label: "Name", type: "text", value: model.name });
  const uri = field("editor-uri", {
    label: "Website",
    type: "url",
    value: model.uri,
    placeholder: "https://example.com",
    autocomplete: "off",
  });
  const username = field("editor-username", {
    label: "Username",
    type: "text",
    value: model.username,
    autocomplete: "off",
  });
  const password = field("editor-password", {
    // This label is the whole explanation of why the field is empty on an
    // entry that has a password. There is nowhere else the user could learn
    // it, because the popup is never told what the password is.
    label: model.hasPassword ? "New password (leave empty to keep the current one)" : "Password",
    type: "password",
    autocomplete: "new-password",
  });

  const generate = button("editor-generate", "Generate", "button");
  generate.addEventListener("click", () => {
    password.input.value = generatePassword();
    // Shown, because a password the user cannot read is one they cannot check
    // or write down — and they asked for it a moment ago.
    password.input.type = "text";
  });

  const error = errorSlot();
  const actions = document.createElement("div");
  actions.className = "actions";
  const save = button("editor-save", "Save", "submit");
  const cancel = button("editor-cancel", "Cancel", "button");
  cancel.addEventListener("click", handlers.onCancel);
  actions.append(save, cancel);

  const onDelete = handlers.onDelete;
  if (onDelete !== null) {
    const remove = button("editor-delete", "Delete", "button");
    remove.className = "action action-danger";
    remove.addEventListener("click", () => {
      askConfirmation(actions, `Move “${model.name}” to the trash?`, "Delete", () => {
        void (async () => {
          try {
            await onDelete();
          } catch (e) {
            error.textContent = errorText(e);
          }
        })();
      });
    });
    actions.append(remove);
  }

  form.append(name.row, uri.row, username.row, password.row, generate);
  if (model.otherUriCount > 0) {
    form.append(
      paragraph(
        "note",
        `+${model.otherUriCount} further URL${model.otherUriCount === 1 ? "" : "s"} stay unchanged.`,
      ),
    );
  }
  form.append(error, actions);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    error.textContent = "";

    const draft: ItemDraftMessage = {
      name: name.input.value.trim(),
      uri: uri.input.value.trim(),
      username: username.input.value.trim(),
      // An empty field means "leave the stored password alone" — never an
      // empty password, which the background would refuse anyway.
      password: password.input.value === "" ? null : password.input.value,
    };

    // Refused here as well as in the background, so the common mistakes cost
    // no round trip. The background still refuses them; this is convenience,
    // not the guard.
    if (draft.name === "") {
      error.textContent = "An entry needs a name.";
      return;
    }
    if (model.mode === "create" && draft.password === null) {
      error.textContent = "A new entry needs a password.";
      return;
    }

    const send = (): void => {
      void (async () => {
        save.disabled = true;
        try {
          await handlers.onSave(draft);
        } catch (e) {
          // Everything typed is still on screen, which is the whole point of
          // writing only when the server is reachable.
          error.textContent = errorText(e);
          save.disabled = false;
        }
      })();
    };

    if (model.hasPassword && draft.password !== null) {
      askConfirmation(actions, "The existing password will be replaced.", "Replace", send);
      return;
    }
    send();
  });

  container.append(form);
}

/**
 * Removes the editor, blanking its fields first.
 *
 * `replaceChildren` alone would leave a typed password sitting in a detached
 * input until the garbage collector got round to it. Called when the vault
 * locks while the form is open — which is precisely the case F-5 exists for,
 * and the one way this feature could have introduced the leak the rest of the
 * architecture argues against.
 */
export function teardownEditor(container: HTMLElement): void {
  for (const input of container.querySelectorAll("input")) input.value = "";
  container.replaceChildren();
}
