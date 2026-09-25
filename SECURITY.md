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
  `docs/VERIFICATION-2026-08-25.md` § F-4. **An opt-in setting turns the
  automatic lock off entirely** — see "Unlocking without a PIN" below. The
  Lock button still works in that mode; only the automatic lock is gone.
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
  **Unlocking without a PIN does not weaken this**, and that is the point of
  how it is built: the user key itself is never written to disk in either mode
  — only the server's own encrypted copy of it is — so an extracted image
  faces your master password exactly as it does today. If anything it faces
  slightly more, because that mode leaves no six-digit PIN wrapping in the
  image to attack instead.
- **A malicious or compromised Vaultwarden server.** The server cannot read your
  vault, but it chooses the KDF parameters, serves the encrypted keys, and can
  withhold or replay data. This add-on trusts the server you point it at to be
  yours.
- **Someone holding your unlocked phone.** The idle lock and the PIN are the
  limits of what is offered here. If you turn the PIN off, both limits go:
  "unlocked" then lasts until you tap Lock or Firefox restarts, and anyone
  holding the phone in that window can fill your logins into pages.
- **Firefox itself, or another extension with host permissions.** Both sit above
  this add-on.
- **Look-alike domains.** Entries are matched by registrable domain, computed
  from the Public Suffix List embedded at build time. An entry saved for
  `example.com` is offered on any subdomain of it, so a subdomain you do not
  control is a subdomain that gets offered your credentials. The embedded list
  is a snapshot taken 2026-08-07 and nothing refreshes it; a registry delegated
  after that date is not known to the matcher.

## Unlocking without a PIN

Off by default. Turned on in the add-on's settings, behind a warning and a
second tap, it changes two things and nothing else:

- There is no PIN. The PIN-wrapped key is deleted from storage, and the
  master password is the only way in — needed once per Firefox start.
- There is no idle lock. The vault stays open until you tap Lock or Firefox
  restarts.

What it does **not** change is what is on disk. The user key lives in the
background page's memory in both modes and is never written down, so the
protection an extracted storage image faces is the same in both: your master
password. This is the deliberate difference from a password manager that buys
the same convenience by keeping its key beside the database — Firefox's own
built-in one does that, and gates reading a password on the operating
system's keyguard instead. A browser extension cannot invoke Android's
keyguard, so that trade is not available here and was not made.

The cost is real and it is the second point above: on a phone someone else
picks up, "unlocked" lasts much longer than fifteen minutes.

## Writing to the vault

Three write calls exist — create, update and trash — all to the server address
you entered, and all of them encrypt in the background page before anything
leaves it. Each one is followed by a full sync, so the offline copy on the
device is never anything but a response the server sent.

**The promise about the panel is unchanged, word for word: no decrypted
password crosses the message boundary into it.** The editor shows an empty
password field on an entry that already has one, because it is never told what
the old password is. Leaving that field empty copies the stored ciphertext into
the new item without decrypting it at any point. What the panel learns about a
password is one bit: whether there is one. That bit is what the "this will
replace the existing password" question is built from.

An edit rebuilds the item from the copy the server last sent, changing four
values and repeating everything else untouched — notes, custom fields, a TOTP
secret, the folder. This is a data-loss guard rather than a security one, but
it is the same principle: the client does not invent anything it was not told.

Two limits worth stating plainly:

- **A write is retried on a 401 and on nothing else.** Any other retry risks a
  second copy of an item the server already stored.
- **Deleting means the trash.** The item is flagged, not removed, and the web
  vault can restore it. This add-on cannot delete permanently.

## What is stored, and where

`browser.storage.local` holds one record. In full: the server URL and email; the
server's own encrypted user key and private key; the refresh token, wrapped
under the user key; the PIN-wrapped user key — absent entirely for an account
that unlocks without a PIN; and the last sync response cached exactly as the
server returned it, which is to say still in the server's ciphertext. Beside
those, seven fields that are not secret — a device id generated locally with
`crypto.randomUUID()` and sent to your own server at login as the Bitwarden
protocol requires, the server's KDF parameters, the failed-PIN counter, the
time of the last sync, and three settings.

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
