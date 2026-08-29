# Vaultwarden for Android

A Firefox for Android add-on that unlocks a self-hosted Vaultwarden vault and
fills logins into pages.

> **Unofficial.** This project is not affiliated with, endorsed by, or connected
> to the Vaultwarden project or to Bitwarden, Inc. It is a third-party client
> that speaks the Bitwarden client API a Vaultwarden server implements.

## Status

Version 0.1.0. In daily use by its author since 2026-08-29, on release Firefox
for Android, from a build signed by Mozilla.

**It is not listed on addons.mozilla.org**, so there is no install button.
Running it means building it yourself and having Mozilla sign it for your own
use — an unlisted signature, which release Firefox for Android will install from
a file. [`docs/PRIVATE-INSTALL.md`](docs/PRIVATE-INSTALL.md) is the step-by-step
route and has been walked end to end.

Requires Firefox 121 or newer. Tested against Vaultwarden 1.37.1.

## What it does

- Signs in to a self-hosted Vaultwarden server with email and master password,
  including two-step login.
- Derives keys with PBKDF2 or Argon2id, whichever the server asks for.
- Unlocks with a PIN afterwards, so the master password is typed rarely.
- Draws a badge inside a page's password field and fills username and password
  on a tap.
- Matches entries by registrable domain, so an entry saved for `example.com` is
  offered on `login.example.com`.
- Keeps the last sync as ciphertext, so a vault stays readable with no network.
- Locks after 15 minutes idle by default, and the lock survives a phone that
  was asleep.

## What it does not do

These are true of the current build. They are here rather than in the issue
tracker because finding them yourself is worse than being told.

- **Email-first login pages get no badge on the first screen.** Where a provider
  asks for the address first and the password on a later screen — web.de,
  Google, Microsoft — the first screen has no password field, so the content
  script stays silent by design; and the second screen usually has no username
  field left to fill. Opening the add-on and tapping the entry still works.
- **A `<select>` username is never filled.** A FRITZ!Box with FRITZ!Benutzer
  configured renders a dropdown instead of a text field. The password is filled,
  the dropdown is not, and it looks like a partial success.
- **`http://[::1]` gets no badge.** It is a fillable origin that cannot be
  written as a manifest match pattern. Such pages keep the pop-up path.
- **TOTP codes are not shown.** Entries that carry a TOTP secret are marked
  `TOTP` in the list, and that is all the interface does with them today; the
  code generator exists but nothing calls it yet.

Not implemented at all, and not planned for this version: creating or editing
items, save-password prompts, Sends, attachments, card and identity item types,
passkeys, more than one account, and push sync.

## Security

The short version; [`SECURITY.md`](SECURITY.md) has the threat model and the
reporting route.

- Decryption happens only in the background page. The pop-up receives an item's
  id, name, username and whether it has a TOTP secret — there is no password
  field on the type that crosses that boundary.
- A password reaches a page only through the fill script, addressed to a single
  tab, in response to a tap.
- `browser.storage.local` holds the account record. Everything secret in it is
  ciphertext the server itself produced, plus the PIN-wrapped user key. Nothing
  is stored in plaintext that the server did not already send in plaintext.
- Five wrong PINs exhaust the PIN: the next attempt is refused rather than
  tried, the PIN-wrapped key is discarded, and the master password becomes the
  only way back in.
- Three `fetch` call sites exist in the whole source, all to the server URL you
  entered. No analytics, no telemetry, no third-party requests, no remote code.
  The manifest declares `data_collection_permissions: { "required": ["none"] }`.

No third-party security audit has been done. See `SECURITY.md`.

## How this was built

The implementation is agent-assisted, written spec-first and plan-first with
tests before code. That is stated here rather than left to be discovered,
because for a password client being discovered is the worse version of this
sentence.

What is offered instead of trust: around thirty test files covering the
cryptography, the API layer, the session and the pop-up; an integration suite
that runs against a pinned Vaultwarden container rather than mocks; and
[`docs/VERIFICATION-2026-08-25.md`](docs/VERIFICATION-2026-08-25.md), a manual
run on a real device that records what passed, what failed, and the three
defects it found.

## Build

```bash
npm ci
npm test          # typecheck and unit tests; no network, no Docker
npm run build     # writes dist/
npm run lint:ext  # addons-linter against dist/
```

Node 22.12.0 is what this is developed and built on.

`npm run test:integration` starts a pinned Vaultwarden container, runs the live
suite against it and tears it down. It needs Docker. It talks only to the
container it starts, never to a real vault.

To get it onto a phone, see [`docs/PRIVATE-INSTALL.md`](docs/PRIVATE-INSTALL.md).
Development notes, the manual verification checklist and the known gaps in full
are in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security reports go through
[`SECURITY.md`](SECURITY.md), not the issue tracker.

## Licence

GPL-3.0-only. See [`LICENSE`](LICENSE). Bundled third-party components and their
notices are listed in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
