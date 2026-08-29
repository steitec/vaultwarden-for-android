# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: **Security → Report a
vulnerability** on this repository. That opens a report only the maintainer can
see. Please do not open a public issue for anything that would let someone read
a vault they should not.

There is no PGP key and no security mailing list. This is a one-person project.
Expect an acknowledgement within a week, and say in the report if you are
working to a disclosure deadline.

## No audit has been done

No third-party security audit of this add-on has taken place, and nothing here
should be read as one. What exists instead is in the repository and can be
checked: the unit suites over the cryptography, key hierarchy, session and URI
matching; an integration suite that runs against a pinned Vaultwarden container
rather than against mocks; and `docs/VERIFICATION-2026-08-25.md`, a manual run
on a device that records the three defects it found and the checklist items it
could not close.

## What the add-on is built to protect

- **The vault is decrypted only in the background page.** The pop-up receives an
  item's id, name, username, whether it has a TOTP secret and whether it failed
  to decrypt. There is no password field on the type that crosses that boundary.
- **A password reaches a page only on a tap**, through the fill script, in a
  message addressed to a single tab.
- **A locked vault is inert.** No key material survives a lock, and the refresh
  token is itself stored wrapped under the user key — so a locked vault cannot
  even refresh its own session, let alone decrypt an entry.
- **The idle lock is a deadline, not a timer.** It stores the moment it expires,
  and every path that reads session state settles that deadline first. A process
  frozen by Android for eight hours therefore wakes up locked: nothing has to
  fire, so nothing can fail to fire. This replaced a `setTimeout` that
  measurably never ran on a sleeping device — the measurement is in
  `docs/VERIFICATION-2026-08-25.md` § F-4.
- **PIN guessing is bounded.** Five wrong PINs exhaust the PIN. The next attempt
  is refused rather than tried, the PIN-wrapped key is discarded, and the master
  password becomes the only way back in. The attempt is charged and persisted
  *before* it is tried, so killing the browser mid-guess does not buy a free one.
- **One server, no third parties.** Three `fetch` call sites exist in the whole
  source and all three go to the server URL you entered. No host is hard-coded.
  No analytics, no telemetry, no remote code.
- **The content script holds no credentials.** It runs on every page it is
  allowed on, looks for a visible password field, and only then asks the
  background page whether anything matches. What it gets back is entry ids and
  display names.
- **Filling into third-party frames is not done.** The content script does not
  declare `all_frames`, and a test asserts that absence, because a fill inside
  an attacker-controlled iframe is the classic exfiltration route for autofill.

## What it does not protect against

- **A compromised device.** Anything that can read another process's memory can
  read an unlocked vault. Nothing in a browser extension changes that.
- **An offline attack on an extracted storage image.** The five-attempt PIN
  counter defends against guessing on the device. It is a counter in storage,
  not a rate limit in hardware, and an attacker holding a copy of your storage
  is not subject to it. Your master password is what protects that copy.
- **A malicious or compromised Vaultwarden server.** The server cannot read your
  vault, but it chooses the KDF parameters, serves the encrypted keys, and can
  withhold or replay data. This add-on trusts the server you point it at to be
  yours.
- **Someone holding your unlocked phone.** The idle lock and the PIN are the
  limits of what is offered here.
- **Firefox itself, or another extension with host permissions.** Both sit above
  this add-on.
- **Look-alike domains.** Entries are matched by registrable domain, computed
  from the Public Suffix List embedded at build time. An entry saved for
  `example.com` is offered on any subdomain of it, so a subdomain you do not
  control is a subdomain that gets offered your credentials. The embedded list
  is a snapshot taken 2026-08-07 and nothing refreshes it; a registry delegated
  after that date is not known to the matcher.

## What is stored, and where

`browser.storage.local` holds one record. In full: the server URL and email; the
server's own encrypted user key and private key; the refresh token, wrapped
under the user key; the PIN-wrapped user key; and the last sync response cached
exactly as the server returned it, which is to say still in the server's
ciphertext. Beside those, six fields that are not secret — a device id generated
locally with `crypto.randomUUID()` and sent to your own server at login as the
Bitwarden protocol requires, the server's KDF parameters, the failed-PIN
counter, the time of the last sync, and two settings.

Nothing is stored in plaintext that the server did not already send in
plaintext. `src/session/store.ts` is the whole of it.

## Page access

The manifest requests `https://*/*` plus the two loopback hosts, and registers
one content script on exactly those origins. This is the ordinary shape for a
password manager: the badge has to appear in a page's password field before you
have told the add-on anything, and nothing can be drawn on a page the extension
cannot reach. `<all_urls>` is deliberately not requested — it would cover
`ftp:`, `file:` and every other scheme, none of which this add-on fills into.

One consequence worth knowing: **a locked vault shows a badge on every login
page**, matching entry or not. A locked vault cannot be consulted, and the
alternative — keeping an unencrypted index of which domains your vault covers —
is worse.
