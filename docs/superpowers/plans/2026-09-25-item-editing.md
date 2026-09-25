# Saving credentials (create / edit / delete) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the add-on a write path — create a login item, edit one, move one
to the trash — driven from the popup, without weakening any guarantee the read
path makes today.

**Architecture:** Every piece mirrors an existing read-path piece:
`src/vault/encrypt.ts` mirrors `decryptCipher`, `src/api/ciphers.ts` mirrors
`src/api/sync.ts`, and the controller gains three methods that each end in a full
sync so `cipherCache` stays a verbatim server response. An edit body is built
from the **raw cached cipher**, not from a `VaultItem`, so fields this client
does not model survive a full-replace PUT. A decrypted password never crosses
into the popup: an unchanged password is copied as ciphertext.

**Tech Stack:** TypeScript (strict), WebExtension MV2, vitest + jsdom, WebCrypto,
esbuild via `scripts/build.mjs`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-25-item-editing-design.md`

## Global Constraints

- **Node 22.12.0.** `npm test` = `tsc --noEmit` + `vitest run`; it must stay green after every task.
- **No new runtime dependencies.** `hash-wasm` remains the only one.
- **No `as` casts on unvalidated data.** Narrow with real runtime checks, as `isRequest` and `isSyncResponse` do.
- **Repository language is English** — code, comments, tests, docs, commit messages.
- **Passwords never cross the popup message boundary.** `ItemSummary` and `ItemDraftView` carry no password field. This is checked by a test, not only by review.
- **Every error message reaching the popup is a user-facing sentence**, because `errorText` renders `.message` verbatim (`src/popup/errors.ts`).
- **Writes are retried on 401 and on nothing else.** A 401 proves the request was not applied; any other retry risks a duplicate item.
- **Personal vault only.** Creating is always personal; editing and deleting an organization item is refused in the controller *and* in the interface.
- **Trash, never permanent deletion.**
- **Commit after every task**, with the attribution line the repository uses:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- Work happens on branch `feat/item-editing`, which already exists and holds the spec.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/vault/encrypt.ts` (new) | Plaintext draft + key → cipher request body. No `Session`, no `browser.*`, no API layer. |
| `src/api/ciphers.ts` (new) | Three HTTP calls and their error classification. No crypto. |
| `src/popup/generator.ts` (new) | Password generation. A pure function over an injectable random source. |
| `src/popup/editor.ts` (new) | The editor form, its two inline confirmations, its teardown. |
| `src/api/types.ts` | `RawCipher` learns `deletedDate`. |
| `src/vault/index.ts` | `VaultItem` learns `organizationId`; trashed ciphers are skipped. |
| `src/background/controller.ts` | `withAccessToken` extracted; `detailFor`, `createItem`, `updateItem`, `deleteItem`. |
| `src/background/messages.ts` | `ItemDraftView`, `ItemDraft`, four request kinds and their guards. |
| `src/background/index.ts` | Four dispatcher cases; editor-aware lock notice is popup-side only. |
| `src/popup/screens.ts` | Four private helpers exported so `editor.ts` can reuse them. |
| `src/popup/popup.ts` | Routing to the editor, the `+` and edit affordances, teardown on lock. |
| `src/popup/popup.html` | One `+` button in the header row. |
| `src/popup/popup.css` | Editor layout; `.action-danger` already exists. |
| `tests/integration/seed.ts` | `seedCipher` returns the created id; a notes/custom-field fixture. |

Task order is dependency order. Tasks 2, 10 and 1 are independent of everything
else and can be done in any order relative to each other.

---

### Task 1: Confirm the update and trash routes against Vaultwarden 1.37.1

The spec (§ 5.1) assumes `PUT /api/ciphers/{id}` and `PUT /api/ciphers/{id}/delete`
and assumes nothing about `lastKnownRevisionDate`. Nothing in this repository has
ever called either. Confirm both before writing code against them.

**Files:**
- Modify: `tests/integration/seed.ts` (`seedCipher` returns the new id)
- Test: `tests/integration/live.test.ts` (new `describe` block)
- Modify: `docs/superpowers/specs/2026-09-25-item-editing-design.md` (§ 5.1 status)

**Interfaces:**
- Consumes: nothing.
- Produces: `seedCipher(...)` now returns `Promise<string>` — the server id of the created cipher. Later tasks' integration tests depend on it.

- [ ] **Step 1: Make `seedCipher` return the created id**

In `tests/integration/seed.ts`, change the signature and the tail of the function:

```ts
export async function seedCipher(
  accessToken: string,
  userKey: SymKey,
  opts: SeedCipherOpts,
): Promise<string> {
```

and replace the final `if (!res.ok) throw ...` with:

```ts
  if (!res.ok) throw new Error(`Cipher creation failed: ${res.status} ${await res.text()}`);
  const created: unknown = await res.json();
  if (typeof created !== "object" || created === null || !("id" in created) || typeof created.id !== "string") {
    throw new Error("Cipher creation returned no id");
  }
  return created.id;
```

`seedVault` already ignores the return value, so it needs no change.

- [ ] **Step 2: Write the route-confirmation test**

Append to `tests/integration/live.test.ts`:

```ts
describe("write routes on vaultwarden 1.37.1", () => {
  it("updates a cipher with PUT /api/ciphers/{id} and keeps fields the body repeats", async () => {
    const account = await seedAccount();
    const id = await seedCipher(account.accessToken, account.userKey, {
      name: "Route Probe",
      username: "probe-user",
      password: "probe-pass",
      uris: ["https://probe.example"],
    });

    // Read the cipher back exactly as the client will: from /api/sync.
    const before = await sync(SERVER, account.accessToken);
    const raw = before.ciphers.find((c) => c.id === id);
    expect(raw).toBeDefined();

    // A full replace that changes the name and repeats everything else.
    const body = { ...raw, name: await encryptForTest("Renamed", account.userKey) };
    const res = await fetch(`${SERVER}/api/ciphers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${account.accessToken}` },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);

    const after = await sync(SERVER, account.accessToken);
    const updated = after.ciphers.find((c) => c.id === id);
    expect(updated?.login?.username).toBe(raw?.login?.username);
  });

  it("moves a cipher to the trash with PUT /api/ciphers/{id}/delete, and sync then carries deletedDate", async () => {
    const account = await seedAccount();
    const id = await seedCipher(account.accessToken, account.userKey, {
      name: "Trash Probe",
      password: "probe-pass",
    });

    const res = await fetch(`${SERVER}/api/ciphers/${id}/delete`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${account.accessToken}` },
    });
    expect(res.status).toBe(200);

    const after = await sync(SERVER, account.accessToken);
    const trashed: unknown = after.ciphers.find((c) => c.id === id);
    expect(trashed).toBeDefined();
    expect(trashed).toHaveProperty("deletedDate");
    expect((trashed as { deletedDate: unknown }).deletedDate).not.toBeNull();
  });

  it("records what lastKnownRevisionDate does here", async () => {
    const account = await seedAccount();
    const id = await seedCipher(account.accessToken, account.userKey, {
      name: "Revision Probe",
      password: "probe-pass",
    });
    const before = await sync(SERVER, account.accessToken);
    const raw = before.ciphers.find((c) => c.id === id);

    const res = await fetch(`${SERVER}/api/ciphers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${account.accessToken}` },
      body: JSON.stringify({ ...raw, lastKnownRevisionDate: "2000-01-01T00:00:00.000Z" }),
    });

    // Not an assertion about which answer is right — a recording of which
    // answer this server gives, so §5.1 of the spec can stop guessing.
    // eslint-disable-next-line no-console
    console.log(`lastKnownRevisionDate stale PUT → ${res.status}`);
    expect([200, 400]).toContain(res.status);
  });
});
```

Add at the top of the file, beside the existing imports, the helper the first
test uses (the suite has no shared one):

```ts
async function encryptForTest(text: string, key: SymKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ck = await crypto.subtle.importKey("raw", key.encKey, "AES-CBC", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ck, new TextEncoder().encode(text)));
  const mk = await crypto.subtle.importKey("raw", key.macKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", mk, concat(iv, ct)));
  return `2.${toBase64(iv)}|${toBase64(ct)}|${toBase64(mac)}`;
}
```

Import whatever of `SymKey`, `concat`, `toBase64`, `sync`, `seedAccount`,
`seedCipher`, `SERVER` the file does not already import.

- [ ] **Step 3: Run it**

Run: `npm run test:integration`
Expected: all three pass. If a route 404s, **stop and report** — the spec's
assumption is wrong and § 5.1 has to be redecided before any further task.

- [ ] **Step 4: Record the finding in the spec**

In § 5.1 of the spec, replace the sentence beginning "The update and delete
routes are **not** yet exercised" with what the run actually showed, including
the `lastKnownRevisionDate` status code printed in step 3.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/seed.ts tests/integration/live.test.ts docs/superpowers/specs/2026-09-25-item-editing-design.md
git commit -m "$(cat <<'MSG'
test: confirm the update and trash routes against vaultwarden 1.37.1

Both routes were assumed by the design and called by nothing in this
repository. Now they are called by something, so the assumption is
evidence.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: The read path learns about the trash and about ownership

Two small read-path changes the write path needs. The trash filter is a
pre-existing defect (spec § 7): an item trashed in the web vault is listed and
filled here today.

**Files:**
- Modify: `src/api/types.ts` (`RawCipher`, `isRawCipher`)
- Modify: `src/vault/index.ts` (`VaultItem`, `decryptCipher`, `undecryptablePlaceholder`, `decryptVault`)
- Test: `tests/vault/index.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VaultItem.organizationId: string | null`; `decryptVault` skips ciphers whose `deletedDate` is set.

- [ ] **Step 1: Write the failing tests**

Append to `tests/vault/index.test.ts`, inside the `describe("decryptVault")` block:

```ts
  it("skips ciphers that are in the trash", async () => {
    const p = await payload({ deletedDate: "2026-09-01T10:00:00.000Z" });
    expect(await decryptVault(p, userKey, new Map())).toEqual([]);
  });

  it("keeps ciphers whose deletedDate is explicitly null", async () => {
    const p = await payload({ deletedDate: null });
    expect((await decryptVault(p, userKey, new Map())).length).toBe(1);
  });

  it("reports which organization an item belongs to", async () => {
    const [personal] = await decryptVault(await payload(), userKey, new Map());
    expect(personal!.organizationId).toBeNull();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/vault/index.test.ts`
Expected: FAIL — the trash tests return one item, and `organizationId` is
`undefined` (plus a typecheck error on `deletedDate` not existing on `RawCipher`).

- [ ] **Step 3: Teach `RawCipher` about `deletedDate`**

In `src/api/types.ts`, add the field to the type, directly under `key`:

```ts
  key?: string | null;
  /**
   * Set when the item is in the trash. Optional because vaultwarden omits it
   * for an item that has never been trashed, and `null` for one that was
   * restored — both mean "not trashed", and `decryptVault` treats them alike.
   */
  deletedDate?: string | null;
```

and validate it in `isRawCipher`, beside the existing `isOptionalString(v.key)`:

```ts
    isOptionalString(v.key) &&
    isOptionalString(v.deletedDate) &&
```

- [ ] **Step 4: Filter the trash and carry the owner**

In `src/vault/index.ts`, add to `VaultItem`:

```ts
  /**
   * The organization that owns this item, or null for the personal vault.
   * The write path refuses organization items (see Controller.updateItem):
   * they need a different endpoint and a collection the user has not been
   * asked for.
   */
  organizationId: string | null;
```

Set it in `decryptCipher`'s returned object, beside `favorite`:

```ts
    organizationId: raw.organizationId,
```

and in `undecryptablePlaceholder`, beside `favorite`:

```ts
    organizationId: raw.organizationId,
```

In `decryptVault`, immediately after the existing type skip:

```ts
    if (raw.type !== 1) continue; // logins only in v1
    // An item in the trash is not part of the vault. Without this it is
    // listed and offered for filling, which is what the add-on did until
    // 2026-09; see §7 of the 2026-09-25 design.
    if (raw.deletedDate != null) continue;
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS, including the whole existing suite — several fixtures construct
`VaultItem` values and will need `organizationId` added; fix each one rather than
loosening the type.

- [ ] **Step 6: Commit**

```bash
git add src/api/types.ts src/vault/index.ts tests/vault/index.test.ts
git commit -m "$(cat <<'MSG'
fix: stop listing items that are in the trash

decryptVault never looked at deletedDate, so an item trashed in the web
vault stayed in this add-on's list and was still offered for filling.
VaultItem also gains organizationId, which the write path needs to refuse
organization items.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: `encryptNewCipher` — the create body

**Files:**
- Create: `src/vault/encrypt.ts`
- Test: `tests/vault/encrypt.test.ts`

**Interfaces:**
- Consumes: `encryptToString`, `SymKey` (`src/crypto/encstring.ts`); `utf8` (`src/crypto/bytes.ts`).
- Produces:
  - `type ItemDraft = { name: string; username: string; uri: string; password: string | null }`
  - `class DraftIncompleteError extends Error`
  - `encryptNewCipher(draft: ItemDraft, userKey: SymKey): Promise<Record<string, unknown>>`

- [ ] **Step 1: Write the failing test**

Create `tests/vault/encrypt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { encryptNewCipher, DraftIncompleteError, type ItemDraft } from "../../src/vault/encrypt";
import { decryptVault } from "../../src/vault/index";
import type { SymKey } from "../../src/crypto/encstring";
import type { SyncResponse } from "../../src/api/types";

const userKey: SymKey = { encKey: new Uint8Array(32).fill(1), macKey: new Uint8Array(32).fill(2) };

const draft: ItemDraft = {
  name: "GitHub",
  username: "octocat",
  uri: "https://github.com",
  password: "hunter2",
};

/**
 * Reads a request body back through the production decrypter. The decrypter
 * is the oracle: if it cannot read what the encrypter wrote, the encrypter is
 * wrong, and no assertion about base64 could tell us that.
 */
async function readBack(body: Record<string, unknown>): Promise<ReturnType<typeof decryptVault>> {
  const payload = {
    profile: { organizations: null },
    folders: [],
    ciphers: [{ ...body, id: "c1" }],
  } as unknown as SyncResponse;
  return decryptVault(payload, userKey, new Map());
}

describe("encryptNewCipher", () => {
  it("produces a login cipher the vault decrypter reads back field for field", async () => {
    const [item] = await readBack(await encryptNewCipher(draft, userKey));
    expect(item!.name).toBe("GitHub");
    expect(item!.username).toBe("octocat");
    expect(item!.password).toBe("hunter2");
    expect(item!.uris[0]!.uri).toBe("https://github.com");
    expect(item!.undecryptable).toBe(false);
  });

  it("is a personal login with no per-cipher key", async () => {
    const body = await encryptNewCipher(draft, userKey);
    expect(body.type).toBe(1);
    expect(body.key).toBeNull();
    expect(body.organizationId).toBeNull();
    expect(body.folderId).toBeNull();
  });

  it("omits an empty username instead of encrypting an empty string", async () => {
    const body = await encryptNewCipher({ ...draft, username: "" }, userKey);
    expect(body.login).not.toHaveProperty("username");
    const [item] = await readBack(body);
    expect(item!.username).toBeNull();
  });

  it("omits the uris array entirely when no URL was given", async () => {
    const body = await encryptNewCipher({ ...draft, uri: "" }, userKey);
    expect(body.login).not.toHaveProperty("uris");
    const [item] = await readBack(body);
    expect(item!.uris).toEqual([]);
  });

  it("encrypts the same draft to different ciphertext each time", async () => {
    const a = await encryptNewCipher(draft, userKey);
    const b = await encryptNewCipher(draft, userKey);
    expect(a.name).not.toBe(b.name);
  });

  it("refuses a draft with no name", async () => {
    await expect(encryptNewCipher({ ...draft, name: "   " }, userKey)).rejects.toBeInstanceOf(
      DraftIncompleteError,
    );
  });

  it("refuses a new entry with no password, because fill() would refuse it", async () => {
    await expect(encryptNewCipher({ ...draft, password: null }, userKey)).rejects.toBeInstanceOf(
      DraftIncompleteError,
    );
    await expect(encryptNewCipher({ ...draft, password: "" }, userKey)).rejects.toBeInstanceOf(
      DraftIncompleteError,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/vault/encrypt.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/vault/encrypt"`.

- [ ] **Step 3: Write the module**

Create `src/vault/encrypt.ts`:

```ts
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
 * becomes ciphertext, and it holds no session state so it can be tested
 * against the production decrypter with nothing else in the room.
 */
export type ItemDraft = {
  name: string;
  username: string;
  uri: string;
  password: string | null;
};

/** A draft missing something the server would accept but the user cannot use. */
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
 * string. Vaultwarden stores the login object roughly as it receives it, so
 * an encrypted empty string would come back as a username that decrypts to
 * "" — which `decryptVault`'s `maybe()` cannot tell from a real value.
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
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/encrypt.ts tests/vault/encrypt.test.ts
git commit -m "$(cat <<'MSG'
feat: encrypt a new login item into a cipher request body

The mirror of decryptCipher, and tested against it: every assertion reads
the body back through decryptVault rather than inspecting base64.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: `encryptUpdatedCipher` — the edit body that loses nothing

The task the whole design exists for. `PUT /api/ciphers/{id}` is a full replace,
so the body is built from the raw cached cipher and exactly four values are
overwritten.

**Files:**
- Modify: `src/vault/encrypt.ts`
- Test: `tests/vault/encrypt.test.ts`

**Interfaces:**
- Consumes: `ItemDraft`, `DraftIncompleteError` (Task 3).
- Produces:
  `encryptUpdatedCipher(raw: Record<string, unknown>, draft: ItemDraft, previous: { uri: string | null }, cipherKey: SymKey, nowIso: string): Promise<Record<string, unknown>>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/vault/encrypt.test.ts`:

```ts
import { encryptUpdatedCipher } from "../../src/vault/encrypt";
import { encryptToString } from "../../src/crypto/encstring";
import { utf8 } from "../../src/crypto/bytes";

/** A cached cipher as /api/sync delivers it, plus fields this client never models. */
async function cached(): Promise<Record<string, unknown>> {
  return {
    id: "c1",
    organizationId: null,
    folderId: "f1",
    type: 1,
    name: await encryptToString(utf8("GitHub"), userKey),
    favorite: true,
    key: null,
    notes: await encryptToString(utf8("recovery codes in the safe"), userKey),
    fields: [{ type: 0, name: await encryptToString(utf8("PIN"), userKey), value: await encryptToString(utf8("1234"), userKey) }],
    reprompt: 0,
    revisionDate: "2026-09-01T08:00:00.000Z",
    login: {
      username: await encryptToString(utf8("octocat"), userKey),
      password: await encryptToString(utf8("hunter2"), userKey),
      totp: await encryptToString(utf8("JBSWY3DPEHPK3PXP"), userKey),
      uris: [
        { uri: await encryptToString(utf8("https://github.com"), userKey), match: null },
        { uri: await encryptToString(utf8("https://gist.github.com"), userKey), match: 3 },
      ],
    },
  };
}

const NOW = "2026-09-25T12:00:00.000Z";
const unchanged: ItemDraft = { name: "GitHub", username: "octocat", uri: "https://github.com", password: null };

describe("encryptUpdatedCipher", () => {
  it("keeps every field this client does not model", async () => {
    const raw = await cached();
    const body = await encryptUpdatedCipher(raw, unchanged, { uri: "https://github.com" }, userKey, NOW);

    expect(body.notes).toBe(raw.notes);
    expect(body.fields).toEqual(raw.fields);
    expect(body.folderId).toBe("f1");
    expect(body.favorite).toBe(true);
    expect(body.reprompt).toBe(0);
    expect((body.login as Record<string, unknown>).totp).toBe(
      (raw.login as Record<string, unknown>).totp,
    );
  });

  it("copies an unchanged password byte for byte instead of re-encrypting it", async () => {
    const raw = await cached();
    const body = await encryptUpdatedCipher(raw, unchanged, { uri: "https://github.com" }, userKey, NOW);
    const before = (raw.login as Record<string, unknown>).password;
    expect((body.login as Record<string, unknown>).password).toBe(before);
  });

  it("replaces the password when one was typed", async () => {
    const raw = await cached();
    const body = await encryptUpdatedCipher(
      raw,
      { ...unchanged, password: "correct horse" },
      { uri: "https://github.com" },
      userKey,
      NOW,
    );
    expect((body.login as Record<string, unknown>).password).not.toBe(
      (raw.login as Record<string, unknown>).password,
    );
    const [item] = await readBack(body);
    expect(item!.password).toBe("correct horse");
  });

  it("keeps further URLs and their match types, and copies an unchanged first URL verbatim", async () => {
    const raw = await cached();
    const body = await encryptUpdatedCipher(raw, unchanged, { uri: "https://github.com" }, userKey, NOW);
    const uris = (body.login as { uris: { uri: string; match: number | null }[] }).uris;
    const original = (raw.login as { uris: { uri: string; match: number | null }[] }).uris;
    expect(uris).toHaveLength(2);
    expect(uris[0]).toEqual(original[0]);
    expect(uris[1]).toEqual(original[1]);
  });

  it("replaces only the first URL when it changed, keeping the rest", async () => {
    const raw = await cached();
    const body = await encryptUpdatedCipher(
      raw,
      { ...unchanged, uri: "https://github.example" },
      { uri: "https://github.com" },
      userKey,
      NOW,
    );
    const original = (raw.login as { uris: { uri: string; match: number | null }[] }).uris;
    const [item] = await readBack(body);
    expect(item!.uris[0]!.uri).toBe("https://github.example");
    expect(item!.uris[1]!.uri).toBe("https://gist.github.com");
    expect((body.login as { uris: { match: number | null }[] }).uris[1]).toEqual(original[1]);
  });

  it("adds a first URL to an item that had none", async () => {
    const raw = await cached();
    const login = { ...(raw.login as Record<string, unknown>) };
    delete login.uris;
    const body = await encryptUpdatedCipher(
      { ...raw, login },
      { ...unchanged, uri: "https://new.example" },
      { uri: null },
      userKey,
      NOW,
    );
    const [item] = await readBack(body);
    expect(item!.uris.map((u) => u.uri)).toEqual(["https://new.example"]);
  });

  it("clears a username the user emptied", async () => {
    const raw = await cached();
    const body = await encryptUpdatedCipher(raw, { ...unchanged, username: "" }, { uri: "https://github.com" }, userKey, NOW);
    expect((body.login as Record<string, unknown>).username).toBeNull();
    const [item] = await readBack(body);
    expect(item!.username).toBeNull();
  });

  it("encrypts under the item's own key when it has one", async () => {
    const itemKeyRaw = new Uint8Array(64).fill(9);
    const itemKey: SymKey = { encKey: itemKeyRaw.slice(0, 32), macKey: itemKeyRaw.slice(32) };
    const raw = {
      ...(await cached()),
      key: await encryptToString(itemKeyRaw, userKey),
      name: await encryptToString(utf8("GitHub"), itemKey),
      login: { password: await encryptToString(utf8("hunter2"), itemKey) },
    };

    const body = await encryptUpdatedCipher(raw, { ...unchanged, name: "Renamed" }, { uri: null }, itemKey, NOW);

    expect(body.key).toBe(raw.key);
    const [item] = await readBack(body);
    expect(item!.name).toBe("Renamed");
  });

  it("refuses an update with no name", async () => {
    await expect(
      encryptUpdatedCipher(await cached(), { ...unchanged, name: " " }, { uri: null }, userKey, NOW),
    ).rejects.toBeInstanceOf(DraftIncompleteError);
  });
});
```

`readBack` has to cope with an item key for the last test; change its helper
(defined in Task 3) so the cipher it builds keeps whatever `key` the body
carries — it already spreads `...body`, so no change is needed as long as the
outer `decryptVault` is given `userKey`, which unwraps `body.key`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/vault/encrypt.test.ts`
Expected: FAIL — `encryptUpdatedCipher is not exported`.

- [ ] **Step 3: Implement it**

Append to `src/vault/encrypt.ts`:

```ts
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
 * That is the whole point: notes, custom fields, the TOTP secret, the folder,
 * the favourite flag and any field a future server version adds are present
 * here as opaque strings and are copied through untouched. Building this from
 * the four fields the interface shows would delete all of them on every save,
 * silently, and the loss would only surface weeks later.
 *
 * `cipherKey` is what the item's fields are encrypted under — the user key,
 * or the item's own key when it has one. The caller obtains it with
 * `unwrapCipherKey(raw.key, userKey)`; `raw.key` itself is copied through
 * unchanged, so an item with its own key stays readable.
 *
 * `previous.uri` is the DECRYPTED first URI, which the caller has and this
 * module cannot obtain: ciphertext cannot be compared against what the user
 * typed. When it is unchanged the stored EncString is copied rather than
 * re-encrypted.
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

  login.username =
    draft.username === "" ? null : await encryptToString(utf8(draft.username), cipherKey);

  // Copied, not re-encrypted. Re-encrypting the same plaintext would also be
  // correct, but copying makes "I did not mean to change the password"
  // impossible to get wrong, and a test can assert it byte for byte.
  if (draft.password !== null) {
    login.password = await encryptToString(utf8(draft.password), cipherKey);
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
      // who corrects a typo has not asked for the matching rule to change.
      uris[0] = { uri: encrypted, match: uris[0]!.match };
    }
  }
  login.uris = uris;

  body.login = login;
  return body;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/encrypt.ts tests/vault/encrypt.test.ts
git commit -m "$(cat <<'MSG'
feat: build the edit body from the raw cached cipher

PUT /api/ciphers/{id} is a full replace. Built from a VaultItem it would
delete notes, custom fields, the TOTP secret, the folder and the
favourite flag on every save. Built from the cached cipher, exactly four
values change and everything else is copied through as opaque text.

An unchanged password is copied byte for byte rather than re-encrypted,
and the tests assert that identity.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 5: Password history

**Files:**
- Modify: `src/vault/encrypt.ts`
- Test: `tests/vault/encrypt.test.ts`

**Interfaces:**
- Consumes: `encryptUpdatedCipher` (Task 4) — this task changes its body, not its signature.
- Produces: `PASSWORD_HISTORY_LIMIT = 5` exported from `src/vault/encrypt.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `describe("encryptUpdatedCipher")` in `tests/vault/encrypt.test.ts`:

```ts
  it("files the replaced password into passwordHistory, newest first", async () => {
    const raw = await cached();
    const body = await encryptUpdatedCipher(raw, { ...unchanged, password: "new one" }, { uri: "https://github.com" }, userKey, NOW);
    const history = body.passwordHistory as { password: string; lastUsedDate: string }[];
    expect(history).toHaveLength(1);
    expect(history[0]!.password).toBe((raw.login as Record<string, unknown>).password);
    expect(history[0]!.lastUsedDate).toBe(NOW);
  });

  it("keeps existing history behind the new entry", async () => {
    const raw = { ...(await cached()), passwordHistory: [{ password: "2.older", lastUsedDate: "2026-01-01T00:00:00.000Z" }] };
    const body = await encryptUpdatedCipher(raw, { ...unchanged, password: "new one" }, { uri: "https://github.com" }, userKey, NOW);
    const history = body.passwordHistory as { password: string }[];
    expect(history).toHaveLength(2);
    expect(history[1]!.password).toBe("2.older");
  });

  it("caps the history at five", async () => {
    const older = Array.from({ length: 9 }, (_, i) => ({ password: `2.old${i}`, lastUsedDate: NOW }));
    const raw = { ...(await cached()), passwordHistory: older };
    const body = await encryptUpdatedCipher(raw, { ...unchanged, password: "new one" }, { uri: "https://github.com" }, userKey, NOW);
    expect((body.passwordHistory as unknown[]).length).toBe(PASSWORD_HISTORY_LIMIT);
  });

  it("does not touch the history when the password was left alone", async () => {
    const raw = await cached();
    const body = await encryptUpdatedCipher(raw, unchanged, { uri: "https://github.com" }, userKey, NOW);
    expect(body.passwordHistory).toBeUndefined();
  });

  it("writes no history entry when the item had no password to keep", async () => {
    const raw = await cached();
    const login = { ...(raw.login as Record<string, unknown>) };
    delete login.password;
    const body = await encryptUpdatedCipher({ ...raw, login }, { ...unchanged, password: "first one" }, { uri: "https://github.com" }, userKey, NOW);
    expect(body.passwordHistory).toBeUndefined();
  });
```

Add `PASSWORD_HISTORY_LIMIT` to the file's import from `../../src/vault/encrypt`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/vault/encrypt.test.ts`
Expected: FAIL — `body.passwordHistory` is `undefined` in the first three.

- [ ] **Step 3: Implement it**

In `src/vault/encrypt.ts`, add the constant near the top:

```ts
/**
 * How many old passwords a cipher keeps. Five is what Bitwarden's own clients
 * keep; the server does not enforce a number, so the client is the only thing
 * stopping this list from growing without bound.
 */
export const PASSWORD_HISTORY_LIMIT = 5;
```

and, in `encryptUpdatedCipher`, replace the password branch with:

```ts
  if (draft.password !== null) {
    const replaced = login.password;
    login.password = await encryptToString(utf8(draft.password), cipherKey);
    // The old ciphertext, verbatim — no decryption, no re-encryption. Nothing
    // is filed when there was no password to replace.
    if (typeof replaced === "string" && replaced !== "") {
      const existing = Array.isArray(raw.passwordHistory) ? raw.passwordHistory : [];
      body.passwordHistory = [{ password: replaced, lastUsedDate: nowIso }, ...existing].slice(
        0,
        PASSWORD_HISTORY_LIMIT,
      );
    }
  }
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/encrypt.ts tests/vault/encrypt.test.ts
git commit -m "$(cat <<'MSG'
feat: file a replaced password into the cipher's history

The old EncString is already in hand from the cached cipher, so this
costs no decryption: it is prepended verbatim and the list is capped at
five, as Bitwarden's own clients cap it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 6: `src/api/ciphers.ts`

**Files:**
- Create: `src/api/ciphers.ts`
- Test: `tests/api/ciphers.test.ts`

**Interfaces:**
- Consumes: `ServerUnreachableError` (`src/api/identity.ts`), `UnauthorizedError` (`src/api/sync.ts`).
- Produces:
  - `class CipherWriteFailedError extends Error { status: number }`
  - `createCipher(server: string, accessToken: string, body: Record<string, unknown>): Promise<void>`
  - `updateCipher(server: string, accessToken: string, id: string, body: Record<string, unknown>): Promise<void>`
  - `deleteCipher(server: string, accessToken: string, id: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/api/ciphers.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createCipher,
  updateCipher,
  deleteCipher,
  CipherWriteFailedError,
} from "../../src/api/ciphers";
import { UnauthorizedError } from "../../src/api/sync";
import { ServerUnreachableError } from "../../src/api/identity";

function stubFetch(status: number) {
  const spy = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    text: async () => "",
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

const body = { type: 1, name: "2.aaa|bbb|ccc" };

describe("createCipher", () => {
  it("posts the body to /api/ciphers with a bearer token", async () => {
    const spy = stubFetch(200);
    await createCipher("https://vault.example.net", "tok", body);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://vault.example.net/api/ciphers");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(body);
  });

  it("strips a trailing slash from the server url", async () => {
    const spy = stubFetch(200);
    await createCipher("https://vault.example.net/", "tok", body);
    expect(spy.mock.calls[0]![0]).toBe("https://vault.example.net/api/ciphers");
  });

  it("raises UnauthorizedError for a 401, which is what the retry keys on", async () => {
    stubFetch(401);
    const err = await createCipher("https://v.test", "tok", body).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it("raises CipherWriteFailedError carrying the status for anything else", async () => {
    stubFetch(500);
    const err = await createCipher("https://v.test", "tok", body).catch((e) => e);
    expect(err).toBeInstanceOf(CipherWriteFailedError);
    expect((err as CipherWriteFailedError).status).toBe(500);
    expect(err).not.toBeInstanceOf(UnauthorizedError);
  });

  it("raises ServerUnreachableError when fetch itself rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("NetworkError")));
    const err = await createCipher("https://v.test", "tok", body).catch((e) => e);
    expect(err).toBeInstanceOf(ServerUnreachableError);
  });

  it("says something a user can act on", async () => {
    stubFetch(500);
    const err = await createCipher("https://v.test", "tok", body).catch((e) => e);
    expect((err as Error).message).toMatch(/could not save/i);
  });
});

describe("updateCipher", () => {
  it("puts the body to /api/ciphers/{id}", async () => {
    const spy = stubFetch(200);
    await updateCipher("https://v.test", "tok", "abc-123", body);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://v.test/api/ciphers/abc-123");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual(body);
  });

  it("escapes an id that would otherwise change the path", async () => {
    const spy = stubFetch(200);
    await updateCipher("https://v.test", "tok", "../accounts/profile", body);
    expect(spy.mock.calls[0]![0]).toBe("https://v.test/api/ciphers/..%2Faccounts%2Fprofile");
  });
});

describe("deleteCipher", () => {
  it("puts to the trash route with no body", async () => {
    const spy = stubFetch(200);
    await deleteCipher("https://v.test", "tok", "abc-123");
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://v.test/api/ciphers/abc-123/delete");
    expect(init.method).toBe("PUT");
    expect(init.body).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/api/ciphers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `src/api/ciphers.ts`:

```ts
import { ServerUnreachableError } from "./identity";
import { UnauthorizedError } from "./sync";

/**
 * The server refused a write. Carries the status for diagnosis, and a message
 * the popup can render verbatim — `errorText` shows `.message` to the user, so
 * every message that can reach it is a sentence rather than a code.
 */
export class CipherWriteFailedError extends Error {
  constructor(readonly status: number) {
    super(`The server could not save this change (status ${status}). Try again in a moment.`);
    this.name = "CipherWriteFailedError";
  }
}

/**
 * One authenticated write, with the same error classification `sync()` uses.
 *
 * 401 becomes UnauthorizedError BEFORE the generic !ok, because
 * `Controller.withAccessToken` keys its refresh-and-retry on exactly that
 * class — and on nothing else. A write is not idempotent: a POST that reached
 * the server and lost its response would create a second item if it were
 * retried. A 401 is the one status that proves the request was not applied.
 *
 * The id goes through encodeURIComponent: it comes from a message and, though
 * it should always be a server-issued UUID, this is the place where a string
 * becomes a URL path, and a path is not the place to trust a caller.
 */
async function write(
  server: string,
  accessToken: string,
  path: string,
  method: "POST" | "PUT",
  body?: Record<string, unknown>,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${server.replace(/\/+$/, "")}${path}`, {
      method,
      headers:
        body === undefined
          ? { Authorization: `Bearer ${accessToken}` }
          : { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new ServerUnreachableError(e);
  }
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new CipherWriteFailedError(res.status);
}

export async function createCipher(
  server: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<void> {
  await write(server, accessToken, "/api/ciphers", "POST", body);
}

export async function updateCipher(
  server: string,
  accessToken: string,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  await write(server, accessToken, `/api/ciphers/${encodeURIComponent(id)}`, "PUT", body);
}

/**
 * Moves an item to the trash. Not permanent deletion, which this add-on does
 * not offer at all: a phone is too easy to mistap, and the web vault can
 * restore from the trash.
 */
export async function deleteCipher(server: string, accessToken: string, id: string): Promise<void> {
  await write(server, accessToken, `/api/ciphers/${encodeURIComponent(id)}/delete`, "PUT");
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/ciphers.ts tests/api/ciphers.test.ts
git commit -m "$(cat <<'MSG'
feat: add the cipher write endpoints

Create, update and trash, with sync.ts's error classification: 401 stays
its own class because it is the only status a write may be retried on.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 7: Extract `withAccessToken` from `syncAttempt`

A pure refactor. No behaviour changes, and the existing sync tests are the
proof. Do it before the new callers exist, so a regression here cannot be
blamed on them.

**Files:**
- Modify: `src/background/controller.ts:366-438`
- Test: `tests/background/controller.test.ts` (existing tests must stay green; one new test)

**Interfaces:**
- Consumes: `sync`, `UnauthorizedError`, `refreshToken`, `decryptToString`, `parseEncString`, `encryptToString`, `utf8` — all already imported by `controller.ts`.
- Produces: `private withAccessToken<T>(fn: (token: string, settings: StoredState) => Promise<T>): Promise<T>` and `private syncAttempt(): Promise<void>` (the `mayRetry` parameter is gone).

- [ ] **Step 1: Write the test that pins the retry**

`describe("syncNow")` in `tests/background/controller.test.ts` already holds the
two helpers this needs: `unlockedWithRefreshToken()` — a `makeController` whose
`wrappedRefreshToken` is set, unlocked with `PIN` — and `stubServer`. Add one
test to that block, with its own fetch stub, because `stubServer` always answers
the same status:

```ts
    it("refreshes and retries exactly once when the server rejects the access token", async () => {
      const h = await unlockedWithRefreshToken();
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          calls.push(url);
          if (!url.includes("/api/sync")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ access_token: "at", refresh_token: "rt2", expires_in: 3600 }),
              text: async () => "",
            };
          }
          const firstSync = calls.filter((c) => c.includes("/api/sync")).length === 1;
          return firstSync
            ? { ok: false, status: 401, json: async () => ({}), text: async () => "" }
            : {
                ok: true,
                status: 200,
                json: async () => JSON.parse(await cacheOf(DEFAULT_SEEDS)),
                text: async () => "",
              };
        }),
      );

      await h.controller.syncNow();

      // Twice, never three times: a retry that can recurse is a server that
      // rejects every token turning into an infinite loop.
      expect(calls.filter((c) => c.includes("/api/sync"))).toHaveLength(2);
      expect(calls.filter((c) => c.includes("/identity/connect/token")).length).toBeGreaterThanOrEqual(1);
    }, 20000);
```

- [ ] **Step 2: Run the suite to see it pass against the current code**

Run: `npx vitest run tests/background/controller.test.ts`
Expected: PASS. This test describes behaviour that already exists; it is here so
the refactor in step 3 cannot silently drop it.

- [ ] **Step 3: Do the extraction**

In `src/background/controller.ts`, replace `syncNow` and `syncAttempt` with:

```ts
  async syncNow(): Promise<void> {
    await this.syncAttempt();
  }

  /**
   * Runs one authenticated call against the configured server.
   *
   * The single place that knows how this client gets an access token: from
   * the session if it has one, otherwise by unwrapping the refresh token
   * under the user key. It also owns the one retry this client performs — on
   * a 401 and on nothing else.
   *
   * That restriction is load-bearing now that writes go through here. A POST
   * that reached the server and whose response was lost creates a duplicate
   * item when retried; a 401 is the one status that proves the request was
   * not applied.
   *
   * `lockIfExpired` first, like `require()` and `matchesFor`: this reads
   * session state directly and would otherwise mint a fresh refresh token
   * against a vault whose deadline had passed (F-4).
   */
  private async withAccessToken<T>(
    fn: (accessToken: string, settings: StoredState) => Promise<T>,
  ): Promise<T> {
    this.session.lockIfExpired();

    // One read: `settings` returns a fresh clone per access. Writes go through
    // session.update() — assigning to this clone would persist nothing.
    const settings = this.session.settings;
    const userKey = this.session.userKey;
    if (this.session.state !== "unlocked" || settings === null || userKey === null) {
      throw new LockedError();
    }

    // Held in a local across the awaits rather than re-read from the session:
    // the idle lock can fire between any two awaits and null it out
    // mid-flight, which would hand `null` straight into the header.
    const first = this.session.accessToken ?? (await this.mintAccessToken(settings, userKey));
    try {
      return await fn(first, settings);
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      this.session.accessToken = null;
      return await fn(await this.mintAccessToken(settings, userKey), settings);
    }
  }

  /**
   * Trades the wrapped refresh token for an access token and persists whatever
   * came back.
   *
   * The write happens immediately, before the caller's request can fail. On
   * 1.37.1 it is a no-op — the integration suite proved the refresh token is
   * returned byte-identical (`does NOT rotate the refresh token`) — but a
   * server that DOES rotate would sign the user out at the next unlock if the
   * new token were dropped here, and upstream Bitwarden rotates.
   */
  private async mintAccessToken(settings: StoredState, userKey: SymKey): Promise<string> {
    if (settings.wrappedRefreshToken == null) {
      throw new Error("Sign in with your master password to sync.");
    }
    const rt = await decryptToString(parseEncString(settings.wrappedRefreshToken), userKey);
    const t = await refreshToken(settings.serverUrl, rt);
    this.session.accessToken = t.access_token;
    await this.session.update({
      wrappedRefreshToken: await encryptToString(utf8(t.refresh_token), userKey),
    });
    return t.access_token;
  }

  private async syncAttempt(): Promise<void> {
    const payload = await this.withAccessToken((token, settings) =>
      sync(settings.serverUrl, token),
    );
    await this.session.update({
      cipherCache: JSON.stringify(payload),
      lastSyncMs: Date.now(),
    });
    await this.loadFromCache();
  }
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS, with no test file changed except the addition in step 1. If any
existing sync test fails, the refactor changed behaviour — fix the code, not the
test.

- [ ] **Step 5: Commit**

```bash
git add src/background/controller.ts tests/background/controller.test.ts
git commit -m "$(cat <<'MSG'
refactor: extract withAccessToken from syncAttempt

Three write calls are about to need exactly what syncAttempt had inlined:
obtain a token, refresh it when absent, retry once on a 401. Extracted
before those callers exist, so the existing sync tests are the proof that
nothing moved.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 8: The controller's write methods

**Files:**
- Modify: `src/background/controller.ts`
- Test: `tests/background/controller.test.ts`

**Interfaces:**
- Consumes: `encryptNewCipher`, `encryptUpdatedCipher`, `ItemDraft` (Tasks 3-5); `createCipher`, `updateCipher`, `deleteCipher` (Task 6); `withAccessToken` (Task 7); `unwrapCipherKey` (`src/crypto/keys.ts`); `VaultItem.organizationId` (Task 2).
- Produces:
  - `detailFor(itemId: string): ItemDraftView`
  - `createItem(draft: ItemDraft): Promise<void>`
  - `updateItem(itemId: string, draft: ItemDraft): Promise<void>`
  - `deleteItem(itemId: string): Promise<void>`
  - `ItemDraftView` (the type) is added to `src/background/messages.ts` by **this** task, because the controller returns it. Task 9 adds only the request kinds that carry it.

- [ ] **Step 1: Write the failing tests**

This file's fixtures are `makeController(overrides)` → `Harness { controller,
session, stored }`, `cacheOf(seeds, orgs)`, `makeOrg(id)`, the `PIN` constant
and `DEFAULT_SEEDS` (one item, `c1`, "GitHub", `https://github.com`, password
`hunter2`). A seed names an organization with `orgId`. Append a new top-level
`describe` to `tests/background/controller.test.ts`:

```ts
describe("writing items", () => {
  const draft = { name: "Renamed", username: "octocat", uri: "https://github.com", password: null };

  /** The default vault plus one organization item, unlocked and able to reach a server. */
  async function writable(): Promise<Harness> {
    const org = await makeOrg("o1");
    const h = await makeController({
      wrappedRefreshToken: await encryptToString(utf8("rt"), userKey),
      cipherCache: await cacheOf(
        [...DEFAULT_SEEDS, { id: "org1", name: "Org Item", uris: ["https://org.example"], orgId: "o1" }],
        [org],
      ),
    });
    await h.controller.unlock(PIN);
    return h;
  }

  /** Answers the token endpoint and /api/sync, and records every call. */
  function recordingServer(calls: { url: string; method?: string }[], writeStatus = 200) {
    return vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method });
      const isWrite = url.includes("/api/ciphers");
      const ok = isWrite ? writeStatus >= 200 && writeStatus < 300 : true;
      return {
        ok,
        status: isWrite ? writeStatus : 200,
        json: async () =>
          url.includes("/identity/")
            ? { access_token: "at", refresh_token: "rt2", expires_in: 3600 }
            : JSON.parse(await cacheOf(DEFAULT_SEEDS)),
        text: async () => "",
      };
    });
  }

  it("refuses every write on a locked vault", async () => {
    const h = await makeController();
    await expect(h.controller.createItem({ ...draft, password: "p" })).rejects.toBeInstanceOf(LockedError);
    await expect(h.controller.updateItem("c1", draft)).rejects.toBeInstanceOf(LockedError);
    await expect(h.controller.deleteItem("c1")).rejects.toBeInstanceOf(LockedError);
    expect(() => h.controller.detailFor("c1")).toThrow(LockedError);
  });

  it("creates an item and then syncs, so the cache stays the server's own answer", async () => {
    const h = await writable();
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal("fetch", recordingServer(calls));

    await h.controller.createItem({ name: "New", username: "u", uri: "https://e.test", password: "p" });

    const write = calls.find((c) => c.url.endsWith("/api/ciphers"));
    expect(write?.method).toBe("POST");
    expect(calls[calls.length - 1]!.url).toContain("/api/sync");
  }, 20000);

  it("leaves the cache untouched when the write fails", async () => {
    const h = await writable();
    const before = h.stored()?.cipherCache;
    vi.stubGlobal("fetch", recordingServer([], 500));

    await expect(
      h.controller.createItem({ name: "New", username: "u", uri: "https://e.test", password: "p" }),
    ).rejects.toThrow();

    expect(h.stored()?.cipherCache).toBe(before);
  }, 20000);

  it("refuses to change or delete an organization item", async () => {
    const h = await writable();
    await expect(h.controller.updateItem("org1", draft)).rejects.toThrow(/organization/i);
    await expect(h.controller.deleteItem("org1")).rejects.toThrow(/organization/i);
  }, 20000);

  it("marks an organization item as not editable in its detail view", async () => {
    const h = await writable();
    expect(h.controller.detailFor("org1").editable).toBe(false);
    expect(h.controller.detailFor("c1").editable).toBe(true);
  }, 20000);

  it("hands the editor no password, only whether there is one", async () => {
    const h = await writable();
    const detail = h.controller.detailFor("c1");
    expect(detail.hasPassword).toBe(true);
    expect(Object.keys(detail)).not.toContain("password");
    // DEFAULT_SEEDS' password. If it ever appears here, the whitelist leaked.
    expect(JSON.stringify(detail)).not.toContain("hunter2");
  }, 20000);

  it("reports the first URL and how many the form is not showing", async () => {
    const h = await writable();
    const detail = h.controller.detailFor("c1");
    expect(detail.uri).toBe("https://github.com");
    expect(detail.otherUriCount).toBe(0);
  }, 20000);

  it("sends the trash route for a delete", async () => {
    const h = await writable();
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal("fetch", recordingServer(calls));

    await h.controller.deleteItem("c1");

    const write = calls.find((c) => c.url.includes("/api/ciphers/c1/delete"));
    expect(write?.method).toBe("PUT");
  }, 20000);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/background/controller.test.ts`
Expected: FAIL — `controller.createItem is not a function`.

- [ ] **Step 3: Implement the methods**

Add to the imports in `src/background/controller.ts`:

```ts
import { encryptNewCipher, encryptUpdatedCipher, type ItemDraft } from "../vault/encrypt";
import { createCipher, updateCipher, deleteCipher } from "../api/ciphers";
import { unwrapCipherKey, unwrapOrgKeyMap } from "../crypto/keys";
import type { ItemDraftView } from "./messages";
```

(the existing `unwrapOrgKeyMap` import is merged into that line), and add the
methods to the class:

```ts
  /**
   * What the editor is allowed to know about an entry.
   *
   * No password — only `hasPassword`, one bit, which is what the overwrite
   * confirmation is built from. This is a whitelist for the same reason
   * `summarize` is one: spreading a VaultItem and deleting fields would
   * silently start leaking whatever a future field adds.
   */
  detailFor(itemId: string): ItemDraftView {
    const item = this.require("user").find((i) => i.id === itemId);
    if (item === undefined) throw new Error("Item not found");
    return {
      id: item.id,
      name: item.name,
      username: item.username,
      uri: item.uris[0]?.uri ?? null,
      otherUriCount: Math.max(0, item.uris.length - 1),
      hasPassword: item.password !== null,
      editable: item.organizationId === null && !item.undecryptable,
    };
  }

  async createItem(draft: ItemDraft): Promise<void> {
    this.require("user");
    const userKey = this.session.userKey;
    if (userKey === null) throw new LockedError();

    const body = await encryptNewCipher(draft, userKey);
    await this.withAccessToken((token, settings) => createCipher(settings.serverUrl, token, body));
    // A full sync rather than splicing the response into the cache: the cache
    // stays a verbatim server response, with one way of coming into existence
    // and one validator.
    await this.syncAttempt();
  }

  async updateItem(itemId: string, draft: ItemDraft): Promise<void> {
    const item = this.editableItem(itemId);
    const userKey = this.session.userKey;
    if (userKey === null) throw new LockedError();

    const raw = this.rawCipherFor(itemId);
    // The item's own key when it has one, the user key otherwise. Encrypting
    // an item with its own key under the user key instead would leave it
    // permanently undecryptable.
    const cipherKey = await unwrapCipherKey(
      typeof raw.key === "string" ? raw.key : null,
      userKey,
    );
    const body = await encryptUpdatedCipher(
      raw,
      draft,
      { uri: item.uris[0]?.uri ?? null },
      cipherKey,
      new Date().toISOString(),
    );

    await this.withAccessToken((token, settings) =>
      updateCipher(settings.serverUrl, token, itemId, body),
    );
    await this.syncAttempt();
  }

  /** Moves an item to the trash. The web vault can restore it. */
  async deleteItem(itemId: string): Promise<void> {
    this.editableItem(itemId);
    await this.withAccessToken((token, settings) =>
      deleteCipher(settings.serverUrl, token, itemId),
    );
    await this.syncAttempt();
  }

  /**
   * The item a write is about, or a refusal.
   *
   * An organization item is refused here and not only in the interface: the
   * popup is not a security boundary, and writing one needs an endpoint and a
   * collection this client does not ask for.
   */
  private editableItem(itemId: string): VaultItem {
    const item = this.require("user").find((i) => i.id === itemId);
    if (item === undefined) throw new Error("Item not found");
    if (item.organizationId !== null) {
      throw new Error(
        "This entry belongs to an organization. Change it in the web vault.",
      );
    }
    if (item.undecryptable) {
      throw new Error("This entry could not be decrypted, so it cannot be changed.");
    }
    return item;
  }

  /**
   * The raw, still-encrypted cipher as the server last sent it.
   *
   * The update body is built from this rather than from a VaultItem, so every
   * field this client does not model survives a full-replace PUT. Re-parsed
   * from `cipherCache` rather than kept in memory: the cache is the only copy
   * that is guaranteed to be what the server said.
   */
  private rawCipherFor(itemId: string): Record<string, unknown> {
    const unavailable = new Error("This entry cannot be changed until the next sync.");
    const cache = this.session.settings?.cipherCache;
    if (cache == null) throw unavailable;

    let parsed: unknown;
    try {
      parsed = JSON.parse(cache);
    } catch {
      throw unavailable;
    }
    if (typeof parsed !== "object" || parsed === null) throw unavailable;
    const ciphers: unknown = (parsed as Record<string, unknown>).ciphers;
    if (!Array.isArray(ciphers)) throw unavailable;

    for (const c of ciphers) {
      if (typeof c === "object" && c !== null && (c as Record<string, unknown>).id === itemId) {
        return { ...(c as Record<string, unknown>) };
      }
    }
    throw new Error("This entry is no longer in the vault. Sync and try again.");
  }
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/controller.ts src/background/messages.ts tests/background/controller.test.ts
git commit -m "$(cat <<'MSG'
feat: create, change and trash items from the controller

Every write ends in a full sync, so cipherCache stays a verbatim server
response. Organization items are refused here and not only in the
interface, and the editor's detail view carries whether there is a
password, never the password.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 9: The message boundary

**Files:**
- Modify: `src/background/messages.ts`
- Modify: `src/background/index.ts` (dispatcher)
- Modify: `src/popup/popup.ts:60-97` (`REQUEST_TIMEOUT_MS`)
- Test: `tests/background/index.test.ts`

**Interfaces:**
- Consumes: `detailFor`, `createItem`, `updateItem`, `deleteItem` (Task 8); `ItemDraft` (Task 3).
- Produces: request kinds `itemDetail`, `createItem`, `updateItem`, `deleteItem`; `ItemDraftView`; `isItemDraft`.

- [ ] **Step 1: Write the failing tests**

In `tests/background/index.test.ts`, add to the `ACCEPTED` table:

```ts
  { kind: "itemDetail", itemId: "c1" },
  { kind: "createItem", draft: { name: "n", username: "u", uri: "https://e.test", password: "p" } },
  { kind: "updateItem", itemId: "c1", draft: { name: "n", username: "u", uri: "https://e.test", password: null } },
  { kind: "deleteItem", itemId: "c1" },
```

and to the rejection table:

```ts
  ["itemDetail with no itemId", { kind: "itemDetail" }],
  ["createItem with no draft", { kind: "createItem" }],
  ["createItem with a non-object draft", { kind: "createItem", draft: "n" }],
  ["createItem with a missing draft field", { kind: "createItem", draft: { name: "n", username: "u", uri: "https://e.test" } }],
  ["createItem with a non-string draft field", { kind: "createItem", draft: { name: 7, username: "u", uri: "https://e.test", password: "p" } }],
  ["createItem with an undefined password instead of null", { kind: "createItem", draft: { name: "n", username: "u", uri: "https://e.test", password: undefined } }],
  ["updateItem with no itemId", { kind: "updateItem", draft: { name: "n", username: "u", uri: "https://e.test", password: null } }],
  ["updateItem with a non-string itemId", { kind: "updateItem", itemId: 7, draft: { name: "n", username: "u", uri: "https://e.test", password: null } }],
  ["deleteItem with no itemId", { kind: "deleteItem" }],
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/background/index.test.ts`
Expected: FAIL — the accepted kinds are rejected.

- [ ] **Step 3: Extend the contract**

In `src/background/messages.ts`, add after `ItemSummary`:

```ts
/**
 * What the editor is given for an existing entry.
 *
 * The sibling of `ItemSummary`, and it keeps the same rule: no password field
 * on the type. `hasPassword` carries exactly one bit — that there is one —
 * which is what the overwrite confirmation is built from. Anything more would
 * mean a decrypted password crossing this boundary, which is the guarantee
 * SECURITY.md makes.
 *
 * `uri` is the FIRST uri and `otherUriCount` is how many the form is not
 * showing, so the editor can say they will survive rather than leaving the
 * user to guess.
 */
export type ItemDraftView = {
  id: string;
  name: string;
  username: string | null;
  uri: string | null;
  otherUriCount: number;
  hasPassword: boolean;
  /** False for an organization item and for one that will not decrypt. */
  editable: boolean;
};

/**
 * What the editor sends back.
 *
 * Structurally identical to `ItemDraft` in vault/encrypt.ts, and deliberately
 * re-declared rather than imported: this module is the wire contract and must
 * not drag the crypto layer into the popup bundle's type graph. `isItemDraft`
 * below is what makes the two agree at runtime.
 */
export type ItemDraftMessage = {
  name: string;
  username: string;
  uri: string;
  /** null means "leave the stored password alone". */
  password: string | null;
};
```

Add to the `Request` union:

```ts
  | { kind: "itemDetail"; itemId: string }
  | { kind: "createItem"; draft: ItemDraftMessage }
  | { kind: "updateItem"; itemId: string; draft: ItemDraftMessage }
  | { kind: "deleteItem"; itemId: string }
```

Add `ItemDraftView` to `Response`:

```ts
export type Response = Status | ItemSummary[] | ItemDraftView | PageMatches | TotpCode | SetupResult | void;
```

Add the guard beside `isTwoFactor`:

```ts
/**
 * Every field checked, not just presence. These strings go into the KDF-free
 * but equally unforgiving encryption path and into a URL comparison; a
 * non-string `name` would reach `String.prototype.trim` and a non-string
 * `password` would reach `TextEncoder.encode`. `password` is `string | null`
 * and `undefined` is NOT accepted: "absent" and "leave it alone" must be the
 * same explicit value on the wire, or a dropped field would silently mean
 * "keep the old password" on a create.
 */
function isItemDraft(v: unknown): v is ItemDraftMessage {
  if (typeof v !== "object" || v === null) return false;
  if (!("name" in v) || !("username" in v) || !("uri" in v) || !("password" in v)) return false;
  return (
    isString(v.name) &&
    isString(v.username) &&
    isString(v.uri) &&
    (v.password === null || isString(v.password))
  );
}
```

and the cases in `isRequest`:

```ts
    case "itemDetail":
    case "deleteItem":
      return "itemId" in v && isString(v.itemId);
    case "createItem":
      return "draft" in v && isItemDraft(v.draft);
    case "updateItem":
      return "itemId" in v && isString(v.itemId) && "draft" in v && isItemDraft(v.draft);
```

- [ ] **Step 4: Dispatch them**

In `src/background/index.ts`, add to the `switch` in `dispatch`:

```ts
    case "itemDetail":
      return Promise.resolve(controller.detailFor(msg.itemId));
    case "createItem":
      return controller.createItem(msg.draft);
    case "updateItem":
      return controller.updateItem(msg.itemId, msg.draft);
    case "deleteItem":
      return controller.deleteItem(msg.itemId);
```

- [ ] **Step 5: Give each kind a timeout budget**

`REQUEST_TIMEOUT_MS` is typed `Record<Request["kind"], number>`, so this is a
compile error until it is done. In `src/popup/popup.ts`:

```ts
  // Answered from the decrypted vault already in memory.
  itemDetail: 4000,

  // Encrypt, one write round trip, then a full sync and a full re-decrypt of
  // the vault. The sync alone is budgeted at 20 s, and these do that plus a
  // write, on mobile data.
  createItem: 30000,
  updateItem: 30000,
  deleteItem: 30000,
```

- [ ] **Step 6: Run everything**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/background/messages.ts src/background/index.ts src/popup/popup.ts tests/background/index.test.ts
git commit -m "$(cat <<'MSG'
feat: carry the four editor requests across the message boundary

ItemDraftView is the sibling of ItemSummary and keeps its rule: no
password field on the type, only whether there is one. password is
string | null on the wire and undefined is refused, so a dropped field
cannot silently mean "keep the old password" on a create.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 10: The password generator

**Files:**
- Create: `src/popup/generator.ts`
- Test: `tests/popup/generator.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `generatePassword(length?: number, random?: RandomBytes): string`, `DEFAULT_LENGTH = 20`, `MIN_LENGTH = 8`, `type RandomBytes = (n: number) => Uint8Array`.

- [ ] **Step 1: Write the failing test**

Create `tests/popup/generator.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  generatePassword,
  DEFAULT_LENGTH,
  MIN_LENGTH,
  type RandomBytes,
} from "../../src/popup/generator";

/** A random source that walks 0,1,2,... so sampling is exactly reproducible. */
function counter(start = 0): RandomBytes {
  let next = start;
  return (n) => Uint8Array.from({ length: n }, () => next++ & 0xff);
}

describe("generatePassword", () => {
  it("returns the requested length", () => {
    expect(generatePassword(24, counter())).toHaveLength(24);
    expect(generatePassword(MIN_LENGTH, counter())).toHaveLength(MIN_LENGTH);
  });

  it("defaults to a length worth having", () => {
    expect(DEFAULT_LENGTH).toBeGreaterThanOrEqual(16);
    expect(generatePassword(undefined, counter())).toHaveLength(DEFAULT_LENGTH);
  });

  it("always contains a lower, an upper, a digit and a symbol", () => {
    for (let seed = 0; seed < 40; seed++) {
      const p = generatePassword(DEFAULT_LENGTH, counter(seed));
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^a-zA-Z0-9]/);
    }
  });

  it("refuses a length too short to hold one of each class", () => {
    expect(() => generatePassword(MIN_LENGTH - 1, counter())).toThrow();
  });

  it("rejects the bytes that would bias the alphabet rather than folding them", () => {
    // The alphabet has 88 characters, so 256 % 88 = 80 byte values (176..255)
    // must be DISCARDED. A modulo implementation would map 176 to the same
    // character as 0 and make the first 80 characters likelier.
    const biased: RandomBytes = (n) => Uint8Array.from({ length: n }, () => 176);
    // Every byte is rejected, so a bounded implementation must give up rather
    // than loop forever or fold the value in.
    expect(() => generatePassword(DEFAULT_LENGTH, biased)).toThrow(/random/i);
  });

  it("draws different passwords from different random streams", () => {
    expect(generatePassword(DEFAULT_LENGTH, counter(0))).not.toBe(
      generatePassword(DEFAULT_LENGTH, counter(7)),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/popup/generator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `src/popup/generator.ts`:

```ts
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
/**
 * No quotes, backslash, backtick, space or angle brackets. Not for safety —
 * the password is never interpolated into anything here — but because those
 * are the characters that break when a user has to retype the password into a
 * terminal, a config file or a form that mangles them.
 */
const SYMBOLS = "!#$%&()*+,-./:;=?@[]^_{|}~";

const ALPHABET = LOWER + UPPER + DIGITS + SYMBOLS;

/** One of each class, so a site that demands all four accepts the first try. */
const CLASSES = [LOWER, UPPER, DIGITS, SYMBOLS];

export const DEFAULT_LENGTH = 20;
export const MIN_LENGTH = CLASSES.length * 2;

/** Injectable so the sampling can be tested against a known byte stream. */
export type RandomBytes = (n: number) => Uint8Array;

const fromCrypto: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/**
 * The largest multiple of the alphabet size that fits in a byte. Every byte at
 * or above it is DISCARDED, not folded in with `%`.
 *
 * Modulo over an alphabet that does not divide 256 makes the first
 * `256 % ALPHABET.length` characters likelier than the rest — a small bias,
 * but a free one to avoid, and the kind of thing that is embarrassing to find
 * in a password manager later.
 */
const LIMIT = 256 - (256 % ALPHABET.length);

/**
 * Drawn in one go and then checked, rather than placing one character per
 * class at a chosen position: placing would need a second unbiased random
 * draw for the positions, and a re-draw is simpler to read and to test. At
 * twenty characters the chance of a draw missing a class is under one in a
 * thousand, so the loop effectively never runs twice.
 */
export function generatePassword(
  length: number = DEFAULT_LENGTH,
  random: RandomBytes = fromCrypto,
): string {
  if (!Number.isInteger(length) || length < MIN_LENGTH) {
    throw new Error(`A generated password needs at least ${MIN_LENGTH} characters.`);
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = draw(length, random);
    if (CLASSES.every((cls) => [...candidate].some((c) => cls.includes(c)))) return candidate;
  }
  throw new Error("Could not generate a password. Try again.");
}

function draw(length: number, random: RandomBytes): string {
  let out = "";
  // Bounded rather than `while (true)`: a random source that only ever returns
  // rejected bytes must fail loudly instead of hanging the popup. 64 bytes per
  // character accepted is generous — the real rejection rate is 80/256.
  let budget = length * 64;
  while (out.length < length) {
    const bytes = random(length);
    for (const b of bytes) {
      if (out.length === length) break;
      if (b < LIMIT) out += ALPHABET[b % ALPHABET.length];
      if (--budget <= 0) throw new Error("The random source produced nothing usable.");
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/popup/generator.ts tests/popup/generator.test.ts
git commit -m "$(cat <<'MSG'
feat: generate passwords without modulo bias

Rejection sampling over an 88-character alphabet, with the random source
injectable so the rejection is testable rather than asserted. One
character of each class is guaranteed, because a site that demands all
four should accept the first try.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 11: The editor screen

**Files:**
- Create: `src/popup/editor.ts`
- Modify: `src/popup/screens.ts` (export four helpers)
- Modify: `src/popup/popup.css`
- Test: `tests/popup/editor.test.ts`

**Interfaces:**
- Consumes: `generatePassword` (Task 10); `errorText` (`src/popup/errors.ts`); `field`, `button`, `errorSlot`, `paragraph` (`src/popup/screens.ts`, exported by this task); `ItemDraftMessage` (Task 9).
- Produces:
  - `type EditorModel = { mode: "create" | "edit"; name: string; username: string; uri: string; otherUriCount: number; hasPassword: boolean }`
  - `type EditorHandlers = { onSave: (draft: ItemDraftMessage) => Promise<void>; onDelete: (() => Promise<void>) | null; onCancel: () => void }`
  - `renderEditor(container: HTMLElement, model: EditorModel, handlers: EditorHandlers): void`
  - `teardownEditor(container: HTMLElement): void`

- [ ] **Step 1: Export the four shared helpers from `screens.ts`**

In `src/popup/screens.ts`, change four declarations to exports and give each a
one-line reason, e.g. above `field`:

```ts
/** Exported for `editor.ts`, so the two forms cannot drift apart visually. */
export function field(id: string, o: FieldOptions): { row: HTMLLabelElement; input: HTMLInputElement } {
```

Do the same for `errorSlot`, `paragraph`, `button`, and export `type FieldOptions`.

- [ ] **Step 2: Write the failing test**

Create `tests/popup/editor.test.ts`:

```ts
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

function click(id: string): void {
  const el = root.querySelector(`#${id}`);
  if (!(el instanceof HTMLElement)) throw new Error(`no button #${id}`);
  el.click();
}

function submit(): void {
  const form = root.querySelector("form");
  form!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
}

const noop = { onSave: async () => {}, onDelete: null, onCancel: () => {} };

describe("renderEditor", () => {
  it("prefills the fields it was given and leaves the password empty", () => {
    renderEditor(root, editModel, noop);
    expect(input("editor-name").value).toBe("GitHub");
    expect(input("editor-username").value).toBe("octocat");
    expect(input("editor-uri").value).toBe("https://github.com");
    expect(input("editor-password").value).toBe("");
    expect(input("editor-password").type).toBe("password");
  });

  it("says that the URLs it is not showing will survive", () => {
    renderEditor(root, editModel, noop);
    expect(root.textContent).toContain("2 further URL");
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

  it("asks before replacing a password that already exists", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor(root, editModel, { ...noop, onSave });
    input("editor-password").value = "new secret";
    submit();

    expect(onSave).not.toHaveBeenCalled();
    expect(root.textContent).toContain("existing password will be replaced");

    click("editor-confirm");
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].password).toBe("new secret");
  });

  it("goes back from the confirmation without saving", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor(root, editModel, { ...noop, onSave });
    input("editor-password").value = "new secret";
    submit();
    click("editor-back");
    expect(onSave).not.toHaveBeenCalled();
    expect(root.querySelector("#editor-save")).not.toBeNull();
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

  it("shows the reason a save was refused and lets the user try again", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("The server could not save this change."));
    renderEditor(root, { ...createModel, name: "Thing" }, { ...noop, onSave });
    input("editor-password").value = "x";
    submit();
    await vi.waitFor(() => expect(root.textContent).toContain("could not save"));
    expect((root.querySelector("#editor-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks before deleting, naming the entry", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    renderEditor(root, editModel, { ...noop, onDelete });
    click("editor-delete");
    expect(onDelete).not.toHaveBeenCalled();
    expect(root.textContent).toContain("GitHub");
    click("editor-confirm");
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalled());
  });

  it("offers no delete button when there is nothing to delete", () => {
    renderEditor(root, createModel, noop);
    expect(root.querySelector("#editor-delete")).toBeNull();
  });

  it("fills the password field from the generator", () => {
    renderEditor(root, createModel, noop);
    click("editor-generate");
    expect(input("editor-password").value.length).toBeGreaterThanOrEqual(16);
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
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/popup/editor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the editor**

Create `src/popup/editor.ts`:

```ts
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
 * Android — and which would also be a modal the user cannot read the form
 * behind. The original buttons are kept and put back, so Back is genuinely a
 * return to where they were.
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
  // The browser's own validation bubbles are unreadable in a popup, and the
  // form already reports every refusal in its own error slot.
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
    // The label is the whole explanation of why this field is empty on an
    // entry that has a password. There is no other way for the user to know,
    // because the popup is never told the password.
    label: model.hasPassword ? "New password (leave empty to keep the current one)" : "Password",
    type: "password",
    autocomplete: "new-password",
  });

  const generate = button("editor-generate", "Generate", "button");
  generate.addEventListener("click", () => {
    password.input.value = generatePassword();
    // Shown, because a password the user cannot read is one they cannot write
    // down or check, and they asked for it a moment ago.
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
          // Everything the user typed is still on screen, which is the whole
          // point of writing only when the server is reachable.
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
 * Removes the editor and blanks its fields first.
 *
 * `replaceChildren` alone would leave a typed password sitting in a detached
 * input until the garbage collector got to it. Called when the vault locks
 * while the form is open, which is exactly the case F-5 exists for.
 */
export function teardownEditor(container: HTMLElement): void {
  for (const input of container.querySelectorAll("input")) input.value = "";
  container.replaceChildren();
}
```

- [ ] **Step 5: Style it**

Append to `src/popup/popup.css`:

```css
.editor {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.editor .note {
  margin: 0;
  font-size: 0.85em;
  opacity: 0.8;
}

.editor .actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.confirm-question {
  flex-basis: 100%;
  margin: 0;
}
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/popup/editor.ts src/popup/screens.ts src/popup/popup.css tests/popup/editor.test.ts
git commit -m "$(cat <<'MSG'
feat: add the item editor screen

The password field is empty on an existing entry and its label says why,
because the popup is never told the password. Replacing one asks first;
deleting asks first and names the entry. teardownEditor blanks the
fields before removing them, so a lock mid-edit leaves nothing typed in
a detached node.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 12: Wire the editor into the popup

**Files:**
- Modify: `src/popup/popup.html`
- Modify: `src/popup/popup.ts`
- Modify: `src/popup/popup.css`
- Test: `tests/popup/main.test.ts`

**Interfaces:**
- Consumes: `renderEditor`, `teardownEditor`, `EditorModel` (Task 11); the four request kinds (Task 9).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing tests**

Two files, because the popup suite is split by harness: `tests/popup/main.test.ts`
drives `main()` through `install(responder, tabs)` and `defaultResponder`, while
`tests/popup/lock-notice.test.ts` is the only one that stubs
`browser.runtime.connect` and can therefore deliver a lock.

**First**, three existing fixtures have to learn the new shapes, or every test
in the file throws:

- `item(id, name, undecryptable)` builds an `ItemSummary`; add `editable: !undecryptable` to what it returns.
- `defaultResponder` throws on an unknown kind. Add four cases:

```ts
      case "itemDetail":
        return {
          id: "l1",
          name: "Listed",
          username: "octocat",
          uri: "https://listed.example",
          otherUriCount: 0,
          hasPassword: true,
          editable: true,
        };
      case "createItem":
      case "updateItem":
      case "deleteItem":
        return undefined;
```

- The `SKELETON` markup at the top of the file mirrors `popup.html`; give it the toolbar and the `+` button exactly as step 3 gives them to the real file.

**Then** append to `tests/popup/main.test.ts`:

```ts
describe("the editor", () => {
  it("opens empty from the + button, with the active tab's origin prefilled", async () => {
    install(defaultResponder(), [{ url: "https://example.test/login" }]);
    await main();

    tap(document, "#new-item");

    await vi.waitFor(() => expect(document.getElementById("editor-name")).not.toBeNull());
    expect(requireInput("editor-uri").value).toBe("https://example.test");
    expect(requireInput("editor-name").value).toBe("");
    expect(requireInput("editor-password").value).toBe("");
  });

  it("sends createItem with exactly what was typed, then returns to the list", async () => {
    install(defaultResponder(), [{ url: "https://example.test/login" }]);
    await main();
    tap(document, "#new-item");
    await vi.waitFor(() => expect(document.getElementById("editor-name")).not.toBeNull());

    requireInput("editor-name").value = "New";
    requireInput("editor-password").value = "secret";
    submitForm(document);

    await vi.waitFor(() => expect(sentKinds()).toContain("createItem"));
    expect(sentOf("createItem")[0]).toEqual({
      kind: "createItem",
      draft: { name: "New", username: "", uri: "https://example.test", password: "secret" },
    });
    await vi.waitFor(() => expect(document.querySelector(".item")).not.toBeNull());
  });

  it("opens the editor from its own affordance, and fills nothing", async () => {
    install(defaultResponder(), [{ url: "https://example.test/login" }]);
    await main();
    await vi.waitFor(() => expect(document.querySelector(".item-edit")).not.toBeNull());

    tap(document, ".item-edit");

    await vi.waitFor(() => expect(sentKinds()).toContain("itemDetail"));
    expect(sentKinds()).not.toContain("fill");
  });

  it("draws no edit affordance for an entry the background says is not editable", async () => {
    install(
      defaultResponder({ list: () => [{ ...item("org1", "Org Item"), editable: false }] }),
      [{ url: "https://example.test/login" }],
    );
    await main();

    await vi.waitFor(() => expect(document.querySelector(".item")).not.toBeNull());
    expect(document.querySelector(".item-edit")).toBeNull();
  });

  it("sends updateItem with a null password when the field was left empty", async () => {
    install(defaultResponder(), [{ url: "https://example.test/login" }]);
    await main();
    await vi.waitFor(() => expect(document.querySelector(".item-edit")).not.toBeNull());
    tap(document, ".item-edit");
    await vi.waitFor(() => expect(document.getElementById("editor-name")).not.toBeNull());

    requireInput("editor-name").value = "Renamed";
    submitForm(document);

    await vi.waitFor(() => expect(sentKinds()).toContain("updateItem"));
    expect(sentOf("updateItem")[0]).toMatchObject({
      itemId: "l1",
      draft: { name: "Renamed", password: null },
    });
  });

  it("hides the + button when the vault is not unlocked", async () => {
    install(defaultResponder({ status: () => LOCKED }), []);
    await main();
    expect(requireEl("new-item").hidden).toBe(true);
  });
});
```

**And** one test in `tests/popup/lock-notice.test.ts`, the only file whose
`connect` stub (line 80-89) captures the port listener:

```ts
  it("tears the editor down, blanking what was typed, when the vault locks", async () => {
    await main();
    tap(document, "#new-item");
    await vi.waitFor(() => expect(document.getElementById("editor-password")).not.toBeNull());
    const password = document.getElementById("editor-password") as HTMLInputElement;
    password.value = "typed but never saved";

    // The same postMessage the background sends from controller.onLocked.
    // Deliver it through the listener this file's connect stub captured;
    // there is exactly one such mechanism in the file — use it, do not add
    // a second.
    notifyLocked();

    await vi.waitFor(() => expect(document.getElementById("editor-password")).toBeNull());
    // The node is detached by now. Its value must not have gone with it.
    expect(password.value).toBe("");
  });
```

`notifyLocked()` is whatever that file already calls to fire the captured
listener; read lines 30-95 and use it under its real name.

`ItemSummary` gains `editable` as part of this task: add the field in
`src/background/messages.ts`, set it in `summarize()` in `controller.ts`
(`editable: i.organizationId === null && !i.undecryptable`), and add one
controller test asserting `list("")` reports `editable: false` for `org1` and
`true` for `c1`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/popup/main.test.ts`
Expected: FAIL — there is no `#new-item`.

- [ ] **Step 3: Add the button to the markup**

In `src/popup/popup.html`, replace the search line with:

```html
    <div class="toolbar">
      <input id="search" class="search" type="search" placeholder="Search vault" autocomplete="off" />
      <button id="new-item" class="new-item" type="button" title="New entry" hidden>+</button>
    </div>
```

and append to `src/popup/popup.css`:

```css
.toolbar {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.toolbar .search {
  flex: 1;
}

.new-item {
  flex: 0 0 auto;
  font-size: 1.25rem;
  line-height: 1;
  padding: 0.35rem 0.7rem;
}

.item-edit {
  margin-left: auto;
  opacity: 0.7;
}
```

- [ ] **Step 4: Carry `editable` on a list row**

In `src/background/messages.ts`, add to `ItemSummary`:

```ts
  /** False for an organization item: the write path refuses it. */
  editable: boolean;
```

In `src/background/controller.ts`, add to `summarize`:

```ts
    editable: i.organizationId === null && !i.undecryptable,
```

In `src/popup/popup.ts`, extend `isItemSummary` to require it:

```ts
  if (typeof v.editable !== "boolean") return false;
```

and draw the affordance in `renderList`, after the TOTP marker:

```ts
    if (item.editable) {
      // A span inside the row button, not a nested <button>, which is invalid
      // HTML and does not receive clicks reliably. The row's click handler
      // tells the two apart by target.
      const edit = document.createElement("span");
      edit.className = "item-edit";
      edit.textContent = "Edit";
      edit.setAttribute("role", "button");
      row.append(edit);
    }
```

- [ ] **Step 5: Route to the editor**

In `src/popup/popup.ts`, add the imports:

```ts
import { renderEditor, teardownEditor, type EditorModel } from "./editor";
import type { ItemDraftView } from "../background/messages";
```

a guard beside the others:

```ts
function isItemDraftView(v: unknown): v is ItemDraftView {
  if (typeof v !== "object" || v === null) return false;
  return (
    typeof (v as ItemDraftView).id === "string" &&
    typeof (v as ItemDraftView).name === "string" &&
    ((v as ItemDraftView).username === null || typeof (v as ItemDraftView).username === "string") &&
    ((v as ItemDraftView).uri === null || typeof (v as ItemDraftView).uri === "string") &&
    typeof (v as ItemDraftView).otherUriCount === "number" &&
    typeof (v as ItemDraftView).hasPassword === "boolean" &&
    typeof (v as ItemDraftView).editable === "boolean"
  );
}
```

inside `main()`, beside the other element lookups:

```ts
  const newItem = document.getElementById("new-item");
```

in `showVault`, beside the `search` unhide:

```ts
    if (newItem !== null) newItem.hidden = false;
```

and in the route that leaves the vault screen, hide it again next to the search
field, wherever `search.hidden = true` is set.

Then the editor route itself, as a function declaration inside `main()` beside
`showVault`:

```ts
  /**
   * The editor replaces the whole of #root, exactly as the unlock and setup
   * screens do, and claims the route so a list paint issued before it cannot
   * land on top.
   */
  async function showEditor(itemId: string | null): Promise<void> {
    const current = claimRoute();
    let model: EditorModel;
    let onDelete: (() => Promise<void>) | null = null;

    if (itemId === null) {
      const tab = await activeTab();
      let origin = "";
      try {
        origin = tab?.url === undefined ? "" : new URL(tab.url).origin;
      } catch {
        // about:blank and friends. An empty URL field is the right answer.
      }
      model = { mode: "create", name: "", username: "", uri: origin, otherUriCount: 0, hasPassword: false };
    } else {
      const answer = await request({ kind: "itemDetail", itemId });
      if (!isItemDraftView(answer)) throw new UnexpectedResponseError();
      model = {
        mode: "edit",
        name: answer.name,
        username: answer.username ?? "",
        uri: answer.uri ?? "",
        otherUriCount: answer.otherUriCount,
        hasPassword: answer.hasPassword,
      };
      onDelete = async () => {
        await request({ kind: "deleteItem", itemId });
        await route();
      };
    }

    if (!current()) return;
    renderEditor(root, model, {
      onSave: async (draft) => {
        await request(itemId === null ? { kind: "createItem", draft } : { kind: "updateItem", itemId, draft });
        // Back to the list, which the write's own sync has already refreshed.
        await route();
      },
      onDelete,
      onCancel: () => void route(),
    });
  }
```

Wire the two entry points in `wire()`:

```ts
    newItem?.addEventListener("click", () => {
      void (async () => {
        try {
          await showEditor(null);
        } catch (e) {
          showBanner(banner, errorText(e));
        }
      })();
    });
```

and, at the very top of the existing `root` click handler, before the
undecryptable check:

```ts
        if (target.classList.contains("item-edit")) {
          // An edit tap is not a fill tap. Stop before anything reads tabId.
          void (async () => {
            try {
              await showEditor(itemId);
            } catch (e) {
              showBanner(banner, errorText(e));
            }
          })();
          return;
        }
```

- [ ] **Step 6: Tear the editor down on a lock**

In `src/popup/popup.ts`, change the port listener at the bottom of `main()`:

```ts
    port.onMessage.addListener(() => {
      // Before the re-route, not after: `route()` awaits a status request, and
      // a typed password must not sit in the DOM across that await. See F-5.
      teardownEditor(root);
      void route();
    });
```

- [ ] **Step 7: Run everything**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Build and lint the extension**

Run: `npm run build && npm run lint:ext`
Expected: a clean build and no new addons-linter warnings.

- [ ] **Step 9: Commit**

```bash
git add src/popup/popup.html src/popup/popup.ts src/popup/popup.css src/background/messages.ts src/background/controller.ts tests/popup/main.test.ts tests/background/controller.test.ts
git commit -m "$(cat <<'MSG'
feat: reach the editor from the vault list

A + button in the toolbar for a new entry, prefilled with the active
tab's origin, and a separate Edit affordance per row — separate because
the row tap fills, and that must not become ambiguous. A lock while the
form is open tears it down before the re-route, so nothing typed
survives the await.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 13: End to end against a real Vaultwarden

The unit suite proves the shapes. This proves the feature.

**Files:**
- Modify: `tests/integration/seed.ts` (a notes/custom-field fixture)
- Test: `tests/integration/live.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3-8.
- Produces: nothing.

- [ ] **Step 1: Seed an item with the fields this client does not model**

In `tests/integration/seed.ts`, add to `SeedCipherOpts`:

```ts
  /** Plaintext notes, so the update path can be shown not to destroy them. */
  notes?: string;
  /** One custom field, for the same reason. */
  customField?: { name: string; value: string };
```

and in `seedCipher`, before the request is built:

```ts
  if (opts.notes !== undefined) body.notes = await encrypt(utf8(opts.notes), key);
  if (opts.customField !== undefined) {
    body.fields = [
      {
        type: 0,
        name: await encrypt(utf8(opts.customField.name), key),
        value: await encrypt(utf8(opts.customField.value), key),
      },
    ];
  }
```

- [ ] **Step 2: Write the end-to-end tests**

Append to `tests/integration/live.test.ts`:

```ts
describe("the write path against a live server", () => {
  it("creates an item that syncs back and decrypts to what was typed", async () => {
    const account = await seedAccount();
    const body = await encryptNewCipher(
      { name: "Created Live", username: "live-user", uri: "https://live.example", password: "live-pass" },
      account.userKey,
    );
    await createCipher(SERVER, account.accessToken, body);

    const payload = await sync(SERVER, account.accessToken);
    const items = await decryptVault(payload, account.userKey, new Map());
    const created = items.find((i) => i.name === "Created Live");

    expect(created).toBeDefined();
    expect(created!.username).toBe("live-user");
    expect(created!.password).toBe("live-pass");
    expect(created!.uris.map((u) => u.uri)).toEqual(["https://live.example"]);
  });

  it("changes a name without destroying notes, custom fields or the TOTP secret", async () => {
    const account = await seedAccount();
    const id = await seedCipher(account.accessToken, account.userKey, {
      name: "Rich Item",
      username: "rich-user",
      password: "rich-pass",
      totp: "JBSWY3DPEHPK3PXP",
      uris: ["https://rich.example"],
      notes: "recovery codes are in the safe",
      customField: { name: "Account number", value: "12345" },
    });

    const before = await sync(SERVER, account.accessToken);
    const raw = before.ciphers.find((c) => c.id === id) as unknown as Record<string, unknown>;

    const body = await encryptUpdatedCipher(
      { ...raw },
      { name: "Rich Item renamed", username: "rich-user", uri: "https://rich.example", password: null },
      { uri: "https://rich.example" },
      account.userKey,
      new Date().toISOString(),
    );
    await updateCipher(SERVER, account.accessToken, id, body);

    const after = await sync(SERVER, account.accessToken);
    const updated = after.ciphers.find((c) => c.id === id) as unknown as Record<string, unknown>;

    expect(updated.notes).toBe(raw.notes);
    expect(updated.fields).toEqual(raw.fields);
    expect((updated.login as Record<string, unknown>).totp).toBe(
      (raw.login as Record<string, unknown>).totp,
    );
    // And the password really is untouched, not merely present.
    expect((updated.login as Record<string, unknown>).password).toBe(
      (raw.login as Record<string, unknown>).password,
    );

    const [item] = await decryptVault(
      { ...after, ciphers: after.ciphers.filter((c) => c.id === id) },
      account.userKey,
      new Map(),
    );
    expect(item!.name).toBe("Rich Item renamed");
    expect(item!.password).toBe("rich-pass");
  });

  it("files the old password into the history when it is replaced", async () => {
    const account = await seedAccount();
    const id = await seedCipher(account.accessToken, account.userKey, {
      name: "History Item",
      password: "first-pass",
    });
    const before = await sync(SERVER, account.accessToken);
    const raw = before.ciphers.find((c) => c.id === id) as unknown as Record<string, unknown>;

    const body = await encryptUpdatedCipher(
      { ...raw },
      { name: "History Item", username: "", uri: "", password: "second-pass" },
      { uri: null },
      account.userKey,
      new Date().toISOString(),
    );
    await updateCipher(SERVER, account.accessToken, id, body);

    const after = await sync(SERVER, account.accessToken);
    const updated = after.ciphers.find((c) => c.id === id) as unknown as Record<string, unknown>;
    expect(Array.isArray(updated.passwordHistory)).toBe(true);
    expect((updated.passwordHistory as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("removes a trashed item from the decrypted vault", async () => {
    const account = await seedAccount();
    const id = await seedCipher(account.accessToken, account.userKey, {
      name: "Doomed Item",
      password: "doomed-pass",
    });

    await deleteCipher(SERVER, account.accessToken, id);

    const payload = await sync(SERVER, account.accessToken);
    const items = await decryptVault(payload, account.userKey, new Map());
    expect(items.find((i) => i.name === "Doomed Item")).toBeUndefined();
    // Still on the wire — this is the trash, not deletion.
    expect(payload.ciphers.find((c) => c.id === id)).toBeDefined();
  });
});
```

Import `encryptNewCipher`, `encryptUpdatedCipher`, `createCipher`,
`updateCipher`, `deleteCipher` and `decryptVault` at the top of the file.
`seed.ts` keeps its own `encrypt` and must not import `src/vault/encrypt.ts`: a
fixture built by the code under test proves nothing about that code.

- [ ] **Step 3: Run the integration suite**

Run: `npm run test:integration`
Expected: PASS. This needs Docker and takes a few minutes.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/seed.ts tests/integration/live.test.ts
git commit -m "$(cat <<'MSG'
test: prove the write path against a real vaultwarden

Creating, changing and trashing, through the production modules. The
notes-and-custom-fields case is the one that matters: it is the failure
the design exists to prevent, and only a real server shows it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 14: Documentation, and the device checks this owes

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `docs/BACKLOG.md`
- Modify: `docs/DEVELOPMENT.md`
- Modify: `docs/superpowers/specs/2026-09-25-item-editing-design.md` (status)

- [ ] **Step 1: README**

In "What it does", add:

```markdown
- Creates, changes and trashes a login from the panel, with a password
  generator. Writing needs the server: there is no offline queue, so what the
  vault holds is always what the server acknowledged.
```

In "What it does not do", remove `creating or editing items` from the final
paragraph's list, leaving save-password prompts and the rest, and add:

```markdown
- **Editing is for your own vault only.** An entry that belongs to an
  organization can be read and filled here, but changing or deleting it needs
  the web vault.
- **Deleting means the trash.** The web vault can restore it; this add-on
  cannot delete permanently.
```

- [ ] **Step 2: SECURITY.md**

Add a subsection under the storage/data-flow discussion:

```markdown
### Writing

Three write calls exist, all to the server address you entered: create,
update and trash. Each one encrypts in the background page and then
re-syncs, so the offline cache is never anything but a response the server
sent.

The guarantee about the pop-up is unchanged, word for word: no decrypted
password crosses the message boundary. The editor shows an empty password
field on an entry that already has one, because it is never told what the
old password is — leaving it empty copies the stored ciphertext into the
new cipher without ever decrypting it. The pop-up learns one bit about a
password: whether there is one.

A write is retried on a 401 and on nothing else. Any other retry risks a
second copy of an item the server already stored.
```

- [ ] **Step 3: BACKLOG**

In § 4, remove "item creation and editing" from the deferred list, leaving
save-password prompts and the others. Add to § 3, under the existing gaps:

```markdown
- **The editor has never run on a phone.** Three checks, all on the device:
  create an item and fill it on a real page; add notes to an item in the web
  vault, change that item here, and find the notes still there; delete an item
  and find it in the web vault's trash. The second is the one that matters —
  it is the failure mode the 2026-09-25 design was written around, and only a
  real server shows it.
```

- [ ] **Step 4: DEVELOPMENT.md**

Add to the manual verification checklist the three device checks named above,
in the same format the existing items use.

- [ ] **Step 5: Mark the spec implemented**

Change the spec's `Status:` line to name the branch and the date, in the form
the 2026-08-25 design uses.

- [ ] **Step 6: Run the full suite one last time**

Run: `npm test && npm run build && npm run lint:ext`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add README.md SECURITY.md docs/BACKLOG.md docs/DEVELOPMENT.md docs/superpowers/specs/2026-09-25-item-editing-design.md
git commit -m "$(cat <<'MSG'
docs: say that the add-on can now write, and what that costs

The pop-up guarantee is restated rather than removed, because it still
holds: the editor is never told a password, and an untouched one is
copied as ciphertext.

Three device checks are owed and recorded as owed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## After the plan

Do **not** merge to `main` on the strength of a green unit suite. The three
device checks in Task 14 are the ones the suite cannot reach, and the two open
PIN-less-unlock checks in `docs/BACKLOG.md` are still owed as well. Use the
`superpowers:finishing-a-development-branch` skill to decide how this branch
lands.
