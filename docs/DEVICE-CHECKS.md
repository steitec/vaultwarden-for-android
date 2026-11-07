# Device checks — open

Everything that can only be shown on the phone, in one list and in the order
it should be run. Written 2026-11-07 from `docs/BACKLOG.md` § 3 and the three
changes merged that day. The unit and integration suites are green for all of
it; what they cannot reach is a real Firefox, a real account and a phone that
goes to sleep.

Legend, as in `docs/VERIFICATION-2026-08-25.md`:
`[ ]` not run · `[x]` pass · `[!]` FAIL · `[-]` skipped/not applicable.
Write the date beside each result. A failure gets a finding (`F-6`, `F-7`, …)
at the bottom of this file, with what was seen, not what was expected.

**Order matters.** Section V ends with the two checks that throw state away
(the PIN lockout and the sign-out). Run them last, with the master password
and the second factor at hand.

## Before you start

- **A new version number.** `0.3.0` is already signed, and AMO never accepts a
  version twice. Bump `version` in `src/manifest.json` (and `package.json`)
  first; these changes are a patch, so `0.3.1`.
- **Sign and install** as in `docs/PRIVATE-INSTALL.md` → steps 3–7 and
  "Updating later". Installing over the old version keeps the account, the PIN
  and the cache.
- **Read `docs/BACKLOG.md` § 5 once.** Four traps that have already cost
  time: form values restored after a restart, `web-ext` not reloading on
  Android, reinstalls not reaching open tabs, `console.log` not reaching
  `adb logcat`. The first one matters below: **clear both fields before every
  fill check**, or use a private tab.

## I. Install

- [ ] I1 Firefox on the phone is **142 or newer** (Settings → About Firefox).
      The add-on requires it since 2026-11-07; older versions refuse the
      install. It was 154.0 on 2026-08-29, so this should pass.
- [ ] I2 The new build installs **over** 0.3.0 and the vault is still set up:
      the PIN pad comes up, not the setup form, and the right PIN opens the
      list.

## P. Unlock without a PIN

Merged 2026-08-30 and never run on a phone. With the vault open, in the settings panel: "Unlock without a PIN" →
"Turn the PIN off".

- [ ] P1 Restart Firefox (swipe it away, open it again). The master-password
      screen comes up **without a PIN field**. Sign in. Then look in the settings panel:
      the PIN is **still off**.
      _Why:_ `setup()` has to keep the mode for the same account. If this is
      wrong the option turns itself off once a day, quietly.
- [ ] P2 Unlock, then leave the phone asleep for well over fifteen minutes
      (half an hour is fine). Wake it and open the popup: the vault is **still
      open**.
      _Why:_ the opposite of C3 in the 2026-08-25 run. Without a PIN no idle
      deadline is set, so a frozen process must wake up unlocked.
- [ ] P3 **New 2026-11-07.** Restart Firefox so the vault is locked. Open a
      login page that has exactly one entry, clear both fields, tap the badge.
      Then sign in with the master password in the popup. The page is filled
      **without a second tap**.
      _Why:_ until 2026-11-07 a tap was only redeemed after a PIN, so in this
      mode it was lost after every restart. Same as D7a, but through the
      master password.

Turn the PIN back on afterwards, unless you want to keep using the mode.

## W. Writing entries

Built 2026-09-25 and never run on a phone.

- [ ] W1 Create an entry in the add-on (name, username, password, URL of a
      real login page). Open that page and fill it from the badge.
- [ ] W2 In the **web vault**, add notes to an entry. In the add-on, change
      that entry's password. Back in the web vault: the notes are **still
      there**.
      _Why:_ saving replaces the whole entry on the server. Built from the
      wrong data, it would delete the notes without a word. This is the
      failure the editor's design is written around.
- [ ] W3 Delete an entry in the add-on. It shows up in the web vault's
      **trash**, not gone for good.

## S. Dropdown username (FRITZ!Box)

**New 2026-11-07.** Needs a FRITZ!Box with FRITZ!Benutzer set up, where the
login page shows a user dropdown instead of a text field. If yours does not,
mark S1 `[-]`.

- [ ] S1 Make the entry's username **exactly** the name the dropdown shows.
      Open the login page, tap the badge: the dropdown switches to that user,
      the password is filled, and **Log in works**.
      If it fails: on a computer, save the login page (Save page as → HTML
      only) and keep it. The tests were written from a description, not from
      a real page, and the saved page becomes the test.
- [ ] S2 Change one letter of the entry's username and fill again. The
      dropdown stays **where it was**, the password is filled.
      _Why:_ a username that is not in the list must never be reported as
      filled.
- [ ] S3 Normal login pages are unaffected: repeat D2 and D6 from the
      2026-08-25 run (popup fill and badge fill on an ordinary
      username/password page).

## V. Release channel

The full checklist has only run on Nightly with a temporary add-on
(2026-08-26). Release Firefox with the signed build got a smoke test
(2026-08-29) and nothing more. These are the items that were carried by
Nightly alone; the steps and expected results are in
`docs/VERIFICATION-2026-08-25.md`, under the same IDs.

- [ ] V1 = C3 — idle lock after 15 minutes without interaction (PIN on)
- [ ] V2 = D3 — fill on the React login form
- [ ] V3 = D5 — decoy page: visible fields filled, decoys empty
- [ ] V4 = E1–E3 — airplane mode, "Sync now", failed-sync banner
- [ ] V5 = C4 — wrong-PIN counter: 3, 2, 1, 0 remaining, the sixth refused and
      the key dropped. **Throws the PIN away**; C5 (master password restores)
      follows from it.
- [ ] V6 = F1–F2 — sign out asks first, then wipes. **Throws the whole
      account away**; set it up again afterwards. Last on purpose.

## When this is done

- Results into this file, findings at the bottom.
- `docs/BACKLOG.md` § 3: strike the entries this closes ("never run on a
  phone", "never run on the release channel", the two fixed on 2026-11-07).
- Anything that failed is a bug with a test first, as usual.

## Findings

None yet.
