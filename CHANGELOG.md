# Changelog

What changed between the versions that were signed. Every version listed here
was signed unlisted by Mozilla; AMO accepts a version number only once, so a
number can be spent on a build that never ships.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Dates are the day the version number was set.

## [Unreleased]

## [0.3.4] — 2026-11-23

### Changed
- With several entries matching a page, a tap on the badge opens a list of
  them under the password field: name and username, one row each. A tap on a
  row fills that entry; a tap anywhere else, Escape or a second tap on the
  badge closes the list. Before, the tap tried to open the add-on's panel,
  which Firefox for Android does not allow, so nothing happened (F-9).

## [0.3.3] — 2026-11-22

### Fixed
- The on-screen keyboard no longer hides fields in the panel for good. Firefox
  for Android lays it over the panel without resizing it, so in the editor the
  password field and the save button could not be scrolled into view. While a
  text field has focus the panel now has room below its content, and the field
  is scrolled to the middle.

## [0.3.2] — 2026-11-22

### Fixed
- Creating or changing an entry failed with "status 422" on Vaultwarden
  1.37.4. Every cipher write now sends `encryptedFor`, which that version
  requires; older servers ignore it (F-7, #17).

### Verified
- The full device checklist passed on release Firefox 160 with the signed
  build: install, PIN and PIN-less unlock, the editor, idle lock, React and
  decoy forms, offline use, wrong-PIN counter, sign-out. See
  `docs/DEVICE-CHECKS.md` (#19).

### Known
- With several matching entries the badge does nothing visible on Android,
  because the add-on cannot open its panel there (F-9, `docs/BACKLOG.md` § 3).

## [0.3.1] — 2026-11-07

### Added
- A `<select>` username field, such as a FRITZ!Box user list, is filled when
  the entry's username is one of its options, and left alone otherwise (#15).

### Fixed
- A badge tap made while the vault was locked is filled after a sign-in with
  the master password too, not only after a PIN (#15).
- The built bundle carries the licence notice of every bundled package
  (`hash-wasm`).

### Changed
- Requires Firefox 142 or newer, the first with
  `data_collection_permissions` on Android (#15).
- Development tooling updated (vitest 5, vite 8, jsdom 30, TypeScript 7);
  Dependabot with auto-merge for patch and minor updates.

## [0.3.0] — 2026-09-25

### Added
- Create, change and trash a login from the panel: name, username, password,
  URL, with a password generator. Personal vault only, online only. A change
  keeps every field the add-on does not show, such as notes, and is refused if
  the entry changed elsewhere in the meantime.

### Changed
- Entries in the web vault's trash are no longer listed or offered for
  filling.

## [0.2.0] — 2026-08-30

### Added
- Unlock without a PIN: once per Firefox start with the master password, no
  idle lock. The key is still never written to disk.

### Fixed
- The idle lock is a deadline rather than a timer, so a phone that was asleep
  wakes up locked.
- A page asking for its matches no longer counts as interaction and keeps the
  vault open.
- The PIN pad counts down the remaining attempts after every wrong PIN.
- An open panel is told when the vault locks.
- The badge follows its field, hides where the field is covered, and its three
  states differ in shape.

## [0.1.0] — 2026-08-06

### Added
- Sign-in to a self-hosted Vaultwarden server with email, master password and
  two-step login; PBKDF2 and Argon2id.
- PIN unlock, idle lock after 15 minutes, wrong-PIN lockout.
- A badge in the page's password field that fills on a tap, also as the first
  step of an unlock.
- Matching by registrable domain; offline cache kept as ciphertext.

[Unreleased]: https://github.com/steitec/vaultwarden-for-android/compare/v0.3.4...HEAD
[0.3.4]: https://github.com/steitec/vaultwarden-for-android/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/steitec/vaultwarden-for-android/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/steitec/vaultwarden-for-android/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/steitec/vaultwarden-for-android/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/steitec/vaultwarden-for-android/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/steitec/vaultwarden-for-android/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/steitec/vaultwarden-for-android/releases/tag/v0.1.0
