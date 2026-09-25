# Saving credentials — creating, editing and deleting items — Design

Date: 2026-09-25
Status: Designed. Not implemented.

Closes two of the entries in `docs/BACKLOG.md` § 4 ("item creation and
editing"). It deliberately does **not** close the third one next to them,
save-password prompts; § 3 says why that separation is the point rather than an
oversight.

## 1. Motivation

Everything this add-on does today is a read path: sign in, sync, decrypt, fill.
There is no write call to the server anywhere in the source — the three `fetch`
sites are prelogin, token and sync. A user who signs up for a new account on
their phone has to reach for a second device, or for the web vault, to record
the credential they just invented. In daily use that is the point where the
add-on stops being the password manager and becomes a viewer.

This design gives it a write path: create a login, change one, delete one, from
the popup.

## 2. Goals

- Create a login item — name, URL, username, password — from the popup, with
  the URL prefilled from the active tab.
- Generate a strong password locally, into that form.
- Edit and delete an existing personal login item.
- Keep the guarantee that a decrypted password never crosses the message
  boundary into the popup. It holds literally after this change, in the same
  words `SECURITY.md` uses today.
- Lose nothing. A cipher edited through this add-on must keep every field this
  client does not model — notes, custom fields, TOTP secret, folder, favourite,
  password history, and any field a future server version adds.

## 3. Non-goals

- **Save-password prompts.** Deferred on purpose. That feature requires the
  content script to *read* a password out of an arbitrary page and send it to
  the background, which is the exact reverse of the direction credentials flow
  in today, and it deserves its own threat model rather than a subsection in
  someone else's design. This design is the foundation it will sit on: the
  encryption module, the API module and the controller methods are all reusable
  unchanged.
- **Writing to organizations.** Creating is always personal. Editing and
  deleting an organization item is refused, in the controller and in the
  interface. The server has a second endpoint for it (`/api/ciphers/create`
  with `collectionIds`), the interface would need a collection picker, and the
  server may refuse on permissions — three problems that are not this feature's.
- **Item types other than login.** Secure notes, cards and identities are
  neither read nor written by this client.
- **Offline writing.** § 6.
- **A TOTP field in the form.** `src/totp.ts` exists but nothing calls it; a
  field that can be saved and never displayed is a half-feature. It belongs with
  the TOTP display, in `docs/BACKLOG.md` § 4.
- **Folder selection, favourite toggling, notes editing.** Not modelled by the
  read path either. They are preserved on edit (§ 5.3), not exposed.

## 4. Modules

| New | Responsibility |
|---|---|
| `src/vault/encrypt.ts` | A draft plus a key becomes a cipher request body |
| `src/api/ciphers.ts` | `createCipher`, `updateCipher`, `deleteCipher` |
| `src/popup/editor.ts` | The form, its confirmations, its errors |
| `src/popup/generator.ts` | Password generation, a pure function |

| Changed | Change |
|---|---|
| `src/background/controller.ts` | `createItem` / `updateItem` / `deleteItem`; `withAccessToken` extracted (§ 8) |
| `src/background/messages.ts` | Four new request kinds, `ItemDraftView` |
| `src/background/index.ts` | Four new dispatcher cases |
| `src/vault/index.ts` | `VaultItem` gains `organizationId`; trashed items filtered (§ 7) |
| `src/popup/popup.ts` | Routes to the editor; tears it down on lock |

`src/vault/encrypt.ts` is the mirror of `decryptCipher` in `src/vault/index.ts`
and obeys the same rule: no `Session`, no `browser.*`, no API layer. It takes
plaintext and keys and returns a plain object. That is what makes it testable
against the existing decrypter with no state anywhere (§ 11).

New files rather than additions to `src/popup/screens.ts` (607 lines) and
`src/popup/popup.ts` (795 lines). Both are already at the size where a file is
doing too much.

## 5. The write paths

### 5.1 The wire format is not guessed

`tests/integration/seed.ts:231` already creates ciphers through
`POST /api/ciphers`, verified against `vaultwarden/server:1.37.1`, with the body
shape this design uses:

```jsonc
{
  "type": 1,
  "name": "<EncString>",
  "key": null,
  "folderId": null,
  "organizationId": null,
  "login": {
    "username": "<EncString>",
    "password": "<EncString>",
    "uris": [{ "uri": "<EncString>", "match": null }]
  }
}
```

The update and delete routes are **not** yet exercised anywhere in this
repository. `PUT /api/ciphers/{id}` and `PUT /api/ciphers/{id}/delete` are what
this design assumes, and the first implementation task is to confirm both
against the pinned container — along with whether 1.37.1 honours
`lastKnownRevisionDate` — before any code is written against them. An assumption
about a route is cheap to check and expensive to build on.

### 5.2 Creating

Draft → `encryptDraft(draft, userKey)` → `POST /api/ciphers` → **full sync** →
`loadFromCache()`.

The new item reaches the vault the same way every other item does: through a
cache that the server wrote. There is no second path by which `cipherCache`
comes into existence, so `isSyncResponse` remains its only validator and the
offline cache remains a verbatim copy of a server response. Splicing the
`POST` response into the cache was considered and rejected; it saves one round
trip on a self-hosted server and buys a second mechanism that has to agree with
the first forever. `controller.ts:440` rejects a second mechanism for the same
reason.

New items carry **no per-cipher key** (`key: null`): fields are encrypted
directly under the user key. `unwrapCipherKey` (`src/crypto/keys.ts:196`)
already returns the parent key for that case, every Bitwarden client accepts it,
and it is one key fewer whose lifetime has to be right.

### 5.3 Editing, and the data loss it must not cause

`PUT /api/ciphers/{id}` replaces the cipher completely. Built naively — encrypt
the four fields of a `VaultItem` and send them — every save silently destroys
notes, custom fields, the TOTP secret, the folder, the favourite flag and the
password history. That is the kind of loss noticed weeks later, by which time
every backup also has it.

So the request body is built **from the raw cached cipher, not from the
`VaultItem`**. `cipherCache` is the verbatim server response, so every field
this client does not model is present as an opaque string and is copied through
untouched. Exactly four values are overwritten.

Two consequences are load-bearing:

- **An item with its own cipher key is re-encrypted under that key**, and its
  `key` field is sent back unchanged. Encrypting under the user key instead
  would leave the item permanently undecryptable. `unwrapCipherKey` yields the
  right key for both cases; the encrypt path must take it as an argument rather
  than assuming the user key.
- **A field the user did not change is copied, not re-encrypted.** An untouched
  password is byte-identical afterwards. This is stronger than re-encrypting the
  same plaintext: it makes "I did not mean to change the password" impossible to
  get wrong, and it is directly assertable in a test.

### 5.4 The URL the form does not show

A login may have several URIs; the form has one field. Saving must not delete
the others.

The editor edits **the first URI**. Every further URI is copied verbatim with
its `match` type, and the form says so — "+2 further URLs stay unchanged" —
because a user who cannot see them has no other way to know they survived. An
unchanged first URI is copied verbatim too.

### 5.5 Deleting

`PUT /api/ciphers/{id}/delete` — the trash, not permanent deletion. A phone is
too easy to mistap, and the web vault can restore from the trash. Permanent
deletion is not offered by this add-on at all.

### 5.6 Password history

Replacing a password prepends the **old EncString**, verbatim, to the cipher's
`passwordHistory` with `lastUsedDate` set to now; existing entries are kept in
order behind it, and the list is capped at five, which is what Bitwarden's own
clients keep. The old string is already in hand from the raw cached cipher, so
this costs no decryption and no re-encryption. The cap is checked against the
container in case 1.37.1 enforces its own.

## 6. Writing requires the server

There is no offline queue. If the server cannot be reached, the save fails, the
form stays on screen with everything the user typed still in it, and the message
says the server could not be reached.

The alternative — park the item locally and send it at the next sync — would put
entries into `cipherCache` that no server ever acknowledged, which breaks the
one property the cache has today: it is exactly what the server sent. It would
also produce an item that the user believes is saved and that a lost phone takes
with it.

Reading stays offline exactly as it is now.

## 7. Trashed items are shown today

Found while designing this: `decryptVault` does not look at `deletedDate`. An
item moved to the trash in the web vault still appears in this add-on's list and
is still offered for filling.

That is a pre-existing defect, independent of this feature. It becomes
unavoidable here because deleting to the trash would otherwise visibly do
nothing. The fix is a filter in `decryptVault` alongside the `type !== 1` skip,
with its own test, and `RawCipher` gains an optional `deletedDate`.

## 8. Token handling is extracted, not copied

`syncAttempt` currently inlines two things that all three new calls need
(`controller.ts:370-431`): obtaining an access token, refreshing it from the
wrapped refresh token when there is none, and retrying once on a 401.

That becomes `withAccessToken(fn)`. `syncAttempt` uses it too, so there is one
implementation rather than four that drift. The refactor keeps `syncAttempt`'s
existing behaviour exactly, including the rationale recorded there about
refresh-token rotation, and is covered by the existing sync tests before any new
caller is added.

**Writes are retried only on 401.** A `POST` that reached the server and whose
response was lost — an ordinary event on a mobile connection — creates a
duplicate item when retried. A 401 is the one status that proves the request was
not applied, which is why it is the only one that may be retried.

## 9. The message boundary

Four new kinds, each validated field by field in `isRequest`, to the standard
`setup` already sets (`messages.ts:162`):

```
itemDetail  { itemId }         → ItemDraftView
createItem  { draft }          → void
updateItem  { itemId, draft }  → void
deleteItem  { itemId }         → void
```

```ts
type ItemDraftView = {
  id: string;
  name: string;
  username: string | null;
  uri: string | null;
  otherUriCount: number;
  hasPassword: boolean;
  editable: boolean;
};

type ItemDraft = {
  name: string;
  uri: string;
  username: string;
  /** null means "leave the stored password alone". Update only. */
  password: string | null;
};
```

`ItemDraftView` is the sibling of `ItemSummary` and keeps its rule: no password
field on the type. `hasPassword` carries one bit — that there is one — which is
what the overwrite confirmation in § 10 is built from. `editable` is false for
organization items; the controller refuses them as well, so the interface is not
the only guard.

Required on create: a non-empty `name` and a non-empty password. `password: null`
on create is rejected outright — `fill()` refuses an entry with no password
(`controller.ts:625`), so such an item would be useless from birth. `username`
and `uri` may be empty; both exist in real vaults (`SEEDED.noUsername`,
`SEEDED.noUris`), and an item with no URI is simply one the badge will never
offer. An empty field is sent as an omitted login sub-key, not as an EncString
of the empty string.

Every new controller method goes through `require("user")` — refusing on a
locked vault and settling the idle deadline like every other user action.

These four kinds are sent by the popup only. They are gated by the same single
sender check every other kind has (`index.ts:43`), and get no new mechanism of
their own: the content script is part of this extension and therefore passes
that check today for `unlock`, `list` and `fill` alike. Inventing a per-kind
sender policy for these four while leaving those three as they are would be
security theatre, and the place to revisit it is the whole check, not this
feature.

## 10. The interface

- **New:** a `+` in the list header. The URL is prefilled from the active tab's
  origin; the rest is empty.
- **Edit:** a small button at the right edge of an item row. Not the row tap
  itself — that fills today, and that must not become ambiguous.
- **Form:** name, URL, username, password with a generate button beside it.
  Save and Cancel; Delete as well when editing.
- **Overwrite confirmation:** when the entry already has a password
  (`hasPassword`) and the user has typed a new one, Save replaces the button row
  with "The existing password will be replaced." and *Replace* / *Back*. An
  entry with no password saves without asking.
- **Delete confirmation:** the same inline pattern, with the entry's name in the
  question.
- Inline confirmations, never `confirm()`, which is unreliable inside a popup on
  Android.
- **Organization item:** no edit button, and a line of explanation when it is
  opened.

**A lock mid-edit tears the form down.** The popup already subscribes to
`onLocked` (F-5). The editor must be removed and its fields cleared, not merely
covered: a typed password sitting in the popup's DOM after the vault locked
would be this feature introducing exactly the leak the rest of the architecture
argues against.

## 11. The generator

`src/popup/generator.ts`, a pure function: length (default 20), upper, lower,
digits, symbols. `crypto.getRandomValues` with **rejection sampling**, not
modulo — modulo over a non-power-of-two alphabet biases towards the first
characters of it. As a pure function over an injectable random source, the bias
is directly testable.

It runs in the popup. The password is typed there anyway; moving generation to
the background would not change what the popup holds.

## 12. Testing

Tests before code, as everywhere else in this project.

**`tests/vault/encrypt.test.ts`** — the existing decrypter is the oracle:
encrypt a draft, read it back with `decryptCipher`, compare. Then the four loss
cases, each on its own: unknown fields survive; an item key is used and returned
unchanged; an unchanged password is **byte-identical**; further URIs and their
`match` types survive. Plus password history: prepended, rest untouched, capped.

**`tests/api/ciphers.test.ts`** — stubbed `fetch`: 401 → `UnauthorizedError`,
5xx → the write error, a throwing fetch → `ServerUnreachableError`, and the
request body.

**`tests/background/controller.*`** — a locked vault refuses; an organization
item refuses; a full sync follows every successful write; a failed write leaves
the cache untouched.

**`tests/popup/generator.test.ts`** — length, character classes, and rejection
sampling against a rigged random source that would expose modulo bias.

**`tests/background/index.test.ts`** — the four new kinds joined to the
`ACCEPTED` table and to the request-validation table that already covers
malformed payloads kind by kind.

**`tests/vault/index.test.ts`** — trashed items no longer appear.

**`tests/integration/live.test.ts`** — the actual proof, against the pinned
container: create through the production path, sync, decrypt, assert the
plaintext. Seed an item **with notes and a custom field**, edit it through the
production path, and find the notes still there — the loss case of § 5.3 is only
visible against a real server. Then the trash, and the open route questions of
§ 5.1.

`tests/integration/seed.ts` keeps its own encryption and must not import
`src/vault/encrypt.ts`. A test whose fixture is built by the code under test
proves nothing about that code.

## 13. On the device

The verification checklist gains three items, none of which the unit suite can
reach:

1. Create an item on the phone, then fill it on a real page.
2. Add notes to an item in the web vault, edit that item in the add-on, then
   find the notes still present in the web vault. This is § 5.3's failure mode,
   and nothing short of a real server shows it.
3. Delete an item and find it in the web vault's trash.

`docs/BACKLOG.md` already carries two open device checks for PIN-less unlock;
these join them rather than replacing them.

## 14. Documentation

- `README.md`: "creating or editing items" leaves the not-implemented list;
  "What it does" gains the write path. Save-password prompts stay on the list.
- `SECURITY.md`: the write path, and an explicit statement that the
  password-never-reaches-the-popup guarantee is unchanged — including why the
  edit form can leave a password untouched without ever receiving it.
- `docs/BACKLOG.md` § 4: item creation and editing are removed. § 3 gains the
  trashed-items defect if it is fixed separately.

## 15. Risks

- **A full replace is the only update the API offers.** Every mitigation in
  § 5.3 rests on `cipherCache` being a verbatim server response. If that ever
  stops being true — an optimistic-update change, a cache rewrite — the
  preservation silently stops working. The integration test in § 12 is what
  would catch it.
- **Route assumptions.** § 5.1: two routes and one revision-date behaviour are
  assumed and must be confirmed against 1.37.1 first.
- **A duplicate on a lost response.** Accepted deliberately (§ 8). The user sees
  a failure, retries, and may end up with two items. The alternative — an
  idempotency key the server does not offer — does not exist.
- **The popup now holds a typed password for as long as the form is open.**
  Mitigated by the teardown in § 10, and bounded by the idle lock.
