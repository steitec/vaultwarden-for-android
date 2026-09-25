import { encryptToString, type SymKey } from "../crypto/encstring";
import { utf8 } from "../crypto/bytes";

/**
 * What the user typed into the editor.
 *
 * `password: null` means "leave the stored password alone" and is legal only
 * on an update — `encryptNewCipher` refuses it, because `Controller.fill`
 * refuses an entry with no password and such an item would be useless from
 * birth.
 *
 * Every string here is plaintext. This module is the boundary where plaintext
 * becomes ciphertext, and it deliberately holds no session state and touches
 * neither `browser.*` nor the API layer — which is what lets its tests read
 * every result back through the production decrypter instead of asserting on
 * base64.
 */
export type ItemDraft = {
  name: string;
  username: string;
  uri: string;
  password: string | null;
};

/**
 * A draft the server would accept but the user could not use.
 *
 * Its own class rather than a bare Error so the controller and the popup can
 * tell "you left something out" apart from "the server said no", and its
 * messages are user-facing sentences because `errorText` renders `.message`
 * verbatim.
 */
export class DraftIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftIncompleteError";
  }
}

/**
 * The request body for `POST /api/ciphers`.
 *
 * New items carry no per-cipher key: fields are encrypted directly under the
 * user key. `unwrapCipherKey` already returns the parent key for that case,
 * every Bitwarden client accepts it, and it is one key fewer whose lifetime
 * has to be right.
 *
 * An empty username or URL is OMITTED rather than encrypted as an empty
 * string. Vaultwarden stores the login object roughly as it receives it, so an
 * encrypted empty string would come back as a username that decrypts to "" —
 * which `decryptVault`'s `maybe()` cannot tell from a value the user actually
 * typed.
 */
export async function encryptNewCipher(
  draft: ItemDraft,
  userKey: SymKey,
): Promise<Record<string, unknown>> {
  const name = draft.name.trim();
  if (name === "") throw new DraftIncompleteError("An entry needs a name.");
  if (draft.password === null || draft.password === "") {
    throw new DraftIncompleteError("A new entry needs a password.");
  }

  const login: Record<string, unknown> = {
    password: await encryptToString(utf8(draft.password), userKey),
  };
  if (draft.username !== "") {
    login.username = await encryptToString(utf8(draft.username), userKey);
  }
  if (draft.uri !== "") {
    login.uris = [{ uri: await encryptToString(utf8(draft.uri), userKey), match: null }];
  }

  return {
    type: 1,
    name: await encryptToString(utf8(name), userKey),
    key: null,
    folderId: null,
    organizationId: null,
    login,
  };
}
