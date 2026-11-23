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
  version twice. Done 2026-11-07: `src/manifest.json`, `package.json` and the
  lock file say `0.3.1`. If a check fails and the fix needs another build,
  that build is `0.3.2` — a signed number is spent even if it never ships.
  2026-11-22: `0.3.2` built for the F-7 fix (W1–W3). `0.3.3` the same day for
  the on-screen keyboard fix. 2026-11-23: `0.3.4` for the F-9 and F-10 fixes (X1–X4).
  The next one is `0.3.5`.
- **Sign and install** as in `docs/PRIVATE-INSTALL.md` → steps 3–7 and
  "Updating later". Installing over the old version keeps the account, the PIN
  and the cache.
- **Read `docs/BACKLOG.md` § 5 once.** Four traps that have already cost
  time: form values restored after a restart, `web-ext` not reloading on
  Android, reinstalls not reaching open tabs, `console.log` not reaching
  `adb logcat`. The first one matters below: **clear both fields before every
  fill check**, or use a private tab.

## I. Install

- [x] I1 Firefox on the phone is **142 or newer** (Settings → About Firefox).
      The add-on requires it since 2026-11-07; older versions refuse the
      install. It was 154.0 on 2026-08-29, so this should pass.
- [x] I2 The new build installs **over** 0.3.0 and the vault is still set up:
      the PIN pad comes up, not the setup form, and the right PIN opens the
      list.

## P. Unlock without a PIN

Merged 2026-08-30 and never run on a phone. With the vault open, in the settings panel: "Unlock without a PIN" →
"Turn the PIN off".

- [x] P1 Restart Firefox (swipe it away, open it again). The master-password
      screen comes up **without a PIN field**. Sign in. Then look in the settings panel:
      the PIN is **still off**.
      _Why:_ `setup()` has to keep the mode for the same account. If this is
      wrong the option turns itself off once a day, quietly.
- [x] P2 Unlock, then leave the phone asleep for well over fifteen minutes
      (half an hour is fine). Wake it and open the popup: the vault is **still
      open**.
      _Why:_ the opposite of C3 in the 2026-08-25 run. Without a PIN no idle
      deadline is set, so a frozen process must wake up unlocked.
      
      -> addon asked for master password

      2026-11-07: not the add-on — Android killed Firefox while asleep, so
      this was a restart. See **F-6**. Run again after changing the battery
      setting.

      2026-11-22, 0.3.2: pass. Firefox battery set to Unrestricted
      (`RUN_ANY_IN_BACKGROUND: allow`, on the deviceidle whitelist). Screen
      off 12:41:46 to 13:12:27, light doze from 12:43, deep idle from 12:58;
      the Firefox main process kept PID 22116 throughout (started 12:36:37),
      only content child processes came and went. The popup opened onto an
      unlocked vault.

- [x] P3 **New 2026-11-07.** Restart Firefox so the vault is locked. Open a
      login page that has exactly one entry, clear both fields, tap the badge.
      Then sign in with the master password in the popup. The page is filled
      **without a second tap**.
      _Why:_ until 2026-11-07 a tap was only redeemed after a PIN, so in this
      mode it was lost after every restart. Same as D7a, but through the
      master password.
      
      -> tab the badge does nothing

      2026-11-07: open, see **F-8**. Nothing visible on the tap is expected
      on Android (D7a); what counts is whether the page is filled after the
      sign-in.

      2026-11-22, 0.3.2: pass. Restart, private tab on
      `https://the-internet.herokuapp.com/login` (one entry), badge tap,
      master-password sign-in in the popup: both fields filled, no second
      tap. Closes F-8.

Turn the PIN back on afterwards, unless you want to keep using the mode.

## W. Writing entries

Built 2026-09-25 and never run on a phone.

- [x] W1 Create an entry in the add-on (name, username, password, URL of a
      real login page). Open that page and fill it from the badge.
      
      -> creation of a new entry is not possible:
      "The server could not save this change (status 422). Try again in a moment."

      2026-11-07: reproduced and fixed, see **F-7**. Needs a new build
      (0.3.2) to run again; W2 would have failed the same way.

      2026-11-22, 0.3.2 signed, release Firefox 160.0: pass. Entry for
      `https://the-internet.herokuapp.com/login` created without an error,
      badge fill, and the site's login succeeded.

- [x] W2 In the **web vault**, add notes to an entry. In the add-on, change
      that entry's password. Back in the web vault: the notes are **still
      there**.
      _Why:_ saving replaces the whole entry on the server. Built from the
      wrong data, it would delete the notes without a word. This is the
      failure the editor's design is written around.

      2026-11-22, 0.3.2: pass. Notes added to the W1 entry in the web vault,
      "Sync now", password changed in the add-on: the notes were still there.
- [x] W3 Delete an entry in the add-on. It shows up in the web vault's
      **trash**, not gone for good.

      2026-11-22, 0.3.2: pass. The W1 entry, deleted in the add-on, was in
      the web vault's trash.

## S. Dropdown username (FRITZ!Box)

**New 2026-11-07.** Needs a FRITZ!Box with FRITZ!Benutzer set up, where the
login page shows a user dropdown instead of a text field. If yours does not,
mark S1 `[-]`.

- [-] S1 Make the entry's username **exactly** the name the dropdown shows.
      Open the login page, tap the badge: the dropdown switches to that user,
      the password is filled, and **Log in works**.
      If it fails: on a computer, save the login page (Save page as → HTML
      only) and keep it. The tests were written from a description, not from
      a real page, and the saved page becomes the test.
- [-] S2 Change one letter of the entry's username and fill again. The
      dropdown stays **where it was**, the password is filled.
      _Why:_ a username that is not in the list must never be reported as
      filled.

      2026-11-22: S1 and S2 not applicable, no FRITZ!Benutzer set up.
- [x] S3 Normal login pages are unaffected: repeat D2 and D6 from the
      2026-08-25 run (popup fill and badge fill on an ordinary
      username/password page).

      2026-11-22, 0.3.2: pass. Badge fill (D6) on
      `https://the-internet.herokuapp.com/login` during W1, popup fill (D2)
      on the decoy page during V3.

## V. Release channel

The full checklist has only run on Nightly with a temporary add-on
(2026-08-26). Release Firefox with the signed build got a smoke test
(2026-08-29) and nothing more. These are the items that were carried by
Nightly alone; the steps and expected results are in
`docs/VERIFICATION-2026-08-25.md`, under the same IDs.

- [x] V1 = C3 — idle lock after 15 minutes without interaction (PIN on)
      2026-11-22, 0.3.2: pass. PIN turned back on, popup closed 13:26,
      opened 13:43 onto the PIN pad.
- [x] V2 = D3 — fill on the React login form
      2026-11-22, 0.3.2: pass after a retry. First tap did nothing: a second
      entry for `http://127.0.0.1:8000` was left over from the 2026-08 run,
      so the badge was a chooser, see **F-9**. With it deleted and a sync,
      the badge filled, React state FILLED, submitted password 8 chars.
- [x] V3 = D5 — decoy page: visible fields filled, decoys empty
      2026-11-22, 0.3.2: pass, filled from the popup. Both visible fields
      FILLED, both decoys empty.
- [x] V4 = E1–E3 — airplane mode, "Sync now", failed-sync banner
      2026-11-22, 0.3.2: pass. Offline: PIN unlock listed the cache, "Sync
      now" showed the error banner with the list intact. Back online: "Sync
      now" set "Last synced" to "just now".
- [x] V5 = C4 — wrong-PIN counter: 3, 2, 1, 0 remaining, the sixth refused and
      the key dropped. **Throws the PIN away**; C5 (master password restores)
      follows from it.
      2026-11-22, 0.3.2: pass. Counter read 3, 2, 1, 0 beside "Incorrect
      PIN"; then the sign-in form (C5), and the master password brought the
      entries back.
- [x] V6 = F1–F2 — sign out asks first, then wipes. **Throws the whole
      account away**; set it up again afterwards. Last on purpose.
      2026-11-22, 0.3.2: pass. Confirmation came first; after it, the setup
      form, not the unlock screen.

## X. The entry list for several matches (0.3.4)

**New 2026-11-23**, for the F-9 fix. Needs two entries for the same login
page, e.g. a second one for `http://127.0.0.1:8000` (the React form from V2).
Clear both fields first, or use a private tab.

- [ ] X1 Open the page. The badge shows the lock with the three dots. Tap
      it: a list with both entries opens under the password field, name and
      username in each row. Tap one: both fields are filled with **that**
      entry, and the list is gone.
- [ ] X2 Tap the badge again, then tap somewhere on the page outside the
      list: the list closes and nothing is filled. Open it again and tap the
      badge a second time: it closes too.
- [ ] X3 Tap into the username field so the keyboard comes up, then tap the
      badge: the whole list is visible (above the field if the keyboard
      leaves no room below), and a row tap still fills.
- [ ] X4 **F-10.** Delete the second entry again and sync, so exactly one
      matches. Tap the lock badge: the page is filled, as before. (0.3.4
      ignores taps a page script makes up; a real tap must still count on
      Android.)
## When this is done

- Results into this file, findings at the bottom.
- `docs/BACKLOG.md` § 3: strike the entries this closes ("never run on a
  phone", "never run on the release channel", the two fixed on 2026-11-07).
- Anything that failed is a bug with a test first, as usual.


## Findings

### F-6 — Android ends Firefox in the background (P2)

Not a defect in the add-on. The phone's event log (`adb logcat -b events`)
shows the Firefox process started at 14:13:14 after the P1 restart and
killed by Android at 14:25:57 (`am_kill … org.mozilla.firefox`), while the
phone was asleep. `cmd appops get org.mozilla.firefox RUN_ANY_IN_BACKGROUND`
answers `ignore`: Firefox's battery setting is **Restricted**.

Without a PIN the keys exist only in memory, by design, so a restarted
Firefox has to ask for the master password. That is what P2 saw. It says
nothing about a *frozen* process, which is what P2 is meant to test.

To run P2 again: Android Settings → Apps → Firefox → Battery →
**Unrestricted** (or Optimized), then repeat. If Android still ends Firefox
(check with the same `adb` command), that is the platform's call and P2 is
`[-]`, not a failure.

Worth stating in the wiki: without a PIN, every time Android ends Firefox
costs a master-password sign-in, and "Restricted" makes that much more
frequent.

Rerun 2026-11-22 with the setting on Unrestricted: P2 passes, the process
survived half an hour including deep idle.

### F-7 — Creating an entry fails with 422 on Vaultwarden 1.37.4 (W1)

Root cause: Vaultwarden 1.37.4 made `encryptedFor` a required field of the
cipher body (`CipherData`, "Added in web-v2025.6.0"). A body without it does
not deserialize, and the answer is 422. On a create the server also refuses
any value but the caller's own user id. The add-on never sent the field: it
was built and tested against 1.37.1, where it did not exist, and the server
went to 1.37.4 since. Updates (W2) would have failed the same way.

Reproduced locally by running the integration suite against a 1.37.4
container, which failed at exactly this point.

Fixed in `src/api/ciphers.ts`: every create and update now sends
`encryptedFor`, taken from the `sub` claim of the access token the request
carries, which is the value the server compares against. 1.37.1 ignores the
field. The integration suite is pinned to 1.37.4 now (registration moved to
the two-step `register/send-verification-email` → `register/finish` there),
and the sync fixture is recaptured from it as `tests/fixtures/sync-1.37.4.json`.
Unit tests in `tests/api/ciphers.test.ts` → "encryptedFor".

Lesson: the integration suite was pinned to a server older than the one
in use. Bump the pin together with the server.

### F-8 — Badge tap before a master-password sign-in (P3)

Closed 2026-11-22, not a defect: rerun on 0.3.2 passed (see P3). The
2026-11-07 note recorded only that the tap showed nothing, which is expected
on Android; whether the page was filled after the sign-in was never
observed. Two conditions worth knowing when it seems not to work: the tap is
redeemable for two minutes (`PENDING_TTL_MS` in `src/background/pending.ts`),
and only when exactly one entry matches the page.

### F-9 — A chooser badge does nothing on Android (V2)

Seen 2026-11-22. Two entries matched `http://127.0.0.1:8000`, so the badge
was in chooser mode. A tap sends `handOff`, which tries to open the popup;
`openPopup` is unavailable on Android (as D7a established), so nothing
visible happens and nothing is filled. From the user's side it is
indistinguishable from a broken fill.

Working as designed — several matches are a choice only the user can make —
but the badge promises something it cannot do on this platform. Options for
the backlog: no badge in chooser mode on Android, or a page-level hint
("2 entries — open the add-on to choose"). Not a release blocker.

2026-11-23: fixed in 0.3.4 a third way, chosen over both: the tap opens a
list of the matching entries on the page, and a row tap fills that entry
(`src/content/chooser.ts`, design in
`docs/superpowers/specs/2026-11-23-inline-chooser-design.md`). To be
confirmed on the phone: X1–X3.
