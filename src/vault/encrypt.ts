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
 * How many old passwords a cipher keeps.
 *
 * Five is what Bitwarden's own clients keep. The server does not enforce a
 * number, so the client is the only thing standing between this list and
 * unbounded growth inside every cipher it touches.
 */
export const PASSWORD_HISTORY_LIMIT = 5;

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

type RawLogin = Record<string, unknown>;
type RawUri = { uri: unknown; match: unknown };

function loginOf(raw: Record<string, unknown>): RawLogin {
  const login = raw.login;
  return typeof login === "object" && login !== null ? { ...(login as RawLogin) } : {};
}

function urisOf(login: RawLogin): RawUri[] {
  return Array.isArray(login.uris) ? [...(login.uris as RawUri[])] : [];
}

/**
 * The request body for `PUT /api/ciphers/{id}`, which REPLACES the cipher.
 *
 * Built from `raw` — the verbatim cached cipher — and not from a VaultItem.
 * That is the point of the whole design: notes, custom fields, the TOTP
 * secret, the folder, the favourite flag and any field a future server
 * version adds are present here as opaque strings and are copied through
 * untouched. Building this from the four fields the interface shows would
 * delete every one of them on every save, silently, and the loss would
 * surface weeks later when the backups had it too.
 *
 * `cipherKey` is what this item's fields are encrypted under — the user key,
 * or the item's own key when it has one. The caller obtains it with
 * `unwrapCipherKey(raw.key, userKey)`; `raw.key` itself is copied through
 * unchanged, so an item with its own key stays readable.
 *
 * `previous.uri` is the DECRYPTED first URI, which the caller has and this
 * module cannot obtain: ciphertext cannot be compared against what the user
 * typed. When it is unchanged, the stored EncString is copied rather than
 * re-encrypted.
 *
 * `lastKnownRevisionDate` is sent when the cache has one. Vaultwarden 1.37.1
 * answers a stale value with 400 (confirmed by the probe in
 * tests/integration/live.test.ts), so sending it turns a silent overwrite of
 * somebody else's change into a refusal the user can act on. It is omitted
 * rather than invented when the cached cipher carries no revision: an
 * unguarded write is better than one guarded by a value we made up.
 */
export async function encryptUpdatedCipher(
  raw: Record<string, unknown>,
  draft: ItemDraft,
  previous: { uri: string | null },
  cipherKey: SymKey,
  nowIso: string,
): Promise<Record<string, unknown>> {
  const name = draft.name.trim();
  if (name === "") throw new DraftIncompleteError("An entry needs a name.");

  const body: Record<string, unknown> = { ...raw };
  const login = loginOf(raw);

  body.name = await encryptToString(utf8(name), cipherKey);
  if (typeof raw.revisionDate === "string") body.lastKnownRevisionDate = raw.revisionDate;

  login.username =
    draft.username === "" ? null : await encryptToString(utf8(draft.username), cipherKey);

  // Copied, not re-encrypted. Re-encrypting the same plaintext would also be
  // correct, but copying makes "I did not mean to change the password"
  // impossible to get wrong, and lets a test assert it byte for byte.
  if (draft.password !== null) {
    const replaced = login.password;
    login.password = await encryptToString(utf8(draft.password), cipherKey);
    // The old ciphertext, verbatim — no decryption and no re-encryption,
    // because it is already in hand. Nothing is filed when there was no
    // password to replace: a history entry for a password that never existed
    // would be a lie the web vault then displays.
    if (typeof replaced === "string" && replaced !== "") {
      const existing = Array.isArray(raw.passwordHistory) ? raw.passwordHistory : [];
      body.passwordHistory = [{ password: replaced, lastUsedDate: nowIso }, ...existing].slice(
        0,
        PASSWORD_HISTORY_LIMIT,
      );
    }
  }

  const uris = urisOf(login);
  if (draft.uri !== (previous.uri ?? "")) {
    const encrypted = draft.uri === "" ? null : await encryptToString(utf8(draft.uri), cipherKey);
    if (encrypted === null) {
      uris.shift();
    } else if (uris.length === 0) {
      uris.push({ uri: encrypted, match: null });
    } else {
      // The match type belongs to the URL slot, not to the URL text: a user
      // correcting a typo has not asked for the matching rule to change.
      uris[0] = { uri: encrypted, match: uris[0]!.match };
    }
  }
  login.uris = uris;

  body.login = login;
  return body;
}
