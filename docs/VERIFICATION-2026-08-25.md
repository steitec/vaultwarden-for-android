# Manual verification run — 2026-08-25

Vehicle: Firefox Nightly 156.0a1 (`org.mozilla.fenix`) on SM-N981B (`RFCN80EJ05Y`),
via `web-ext run`, build from 90ee4d6.
Baseline: 606 unit tests pass, `web-ext lint` 0 errors / 0 warnings / 0 notices.

**Status: 14 of 25 passed, 1 failed (C4). Paused 2026-08-25 evening, resumed 2026-08-26.**
Resume instructions are at the bottom.

Legend: `[ ]` not run · `[x]` pass · `[!]` FAIL · `[-]` skipped/blocked

## A. Host permission — highest risk
- [ ] A1 "Sign in" raises Firefox's permission prompt naming the server host; accepting continues setup
- [ ] A2 Denying gives a readable explanation, form keeps entered values
- [ ] A3 Server on a non-standard port (if available)

## B. Setup and sign-in
- [ ] B1 `Controller.setup` completes end to end against the real https server
- [ ] B2 `http://` server address refused with a "use https" message
- [ ] B3 Two-factor prompt appears / lists real providers / correct code completes
- [ ] B4 Wrong master password reported as wrong password, not as a 2FA challenge
- [ ] B5 Vault lists entries immediately after setup

## C. Lock, unlock, PIN lockout
- [x] C1 "Lock" returns to the PIN pad — pass, on the leftover account
- [x] C2 Correct PIN restores the list — pass, twice (before and after C1)
- [ ] C3 Auto-lock after 15 minutes of no interaction
- [!] C4 Wrong-PIN counting matches the table (5 tried, 6th refused + key dropped)
      — the **enforcement** is exactly right: 5 attempts tried, the 6th refused without
      trying, the key dropped. The **warning is not**: the pad shows only "Incorrect PIN",
      never "N attempts remaining", so the user reaches the lockout with no notice at all.
      Root cause and reproduction in finding F-2.
- [ ] C5 After the key is dropped: re-auth form, server URL and email prefilled; master password restores the vault

## D. Autofill
- [x] D1 Matching entries listed first on a known login page — pass, login.example.com
- [x] D2 Tapping an entry fills username + password, popup closes — pass
- [ ] D3 Filling works on a React-based login form
- [x] D4 Non-matching entry is refused with an explanation — pass, "This entry does not match the page that is currently open…" (controller.ts:548)
- [ ] D5 Decoy page: visible fields FILLED, both decoy fields empty
- [x] D6 Badge (unlocked, matching entry): appears in the password field, tap fills both fields — pass
- [x] D7 Badge (locked) — all three parts pass
  - [x] D7a badge appears while locked; tap opens nothing (openPopup unavailable on Android, as designed); fill happens after the PIN with no second tap.
        First execution of the pending-fill path (src/background/pending.ts) on real hardware.
  - [x] D7b badge appears while locked on a login page with no matching entry (design §7) — pass
  - [x] D7c tab navigated between tap and unlock -> pending fill discarded, nothing filled — pass

## E. Offline and sync
- [x] E1 Airplane mode: vault still unlocks and lists from cache — pass
- [x] E2 Reconnect + "Sync now" updates "Last synced" to "just now" — pass
- [x] E3 Failed sync shows an error banner, list stays intact — pass, offline sync kept the cache

## F. Sign out
- [ ] F1 "Sign out" asks for confirmation
- [ ] F2 After confirming: setup screen, not the unlock screen

Not covered by design: TOTP display, copy-to-clipboard (no UI calls them yet).

## Findings

### F-1 — Email-first login flows get no badge at step 1 (not a test failure)

Observed on web.de during the D4 hunt: the first screen asks for the email
address only, with no password field, so no badge appears. That is the content
script behaving exactly as designed — `autofill.ts` looks for a *visible password
field* and stays silent otherwise, which is what keeps ordinary browsing from
ever reaching the background page.

But the consequence is a real product gap, not just a design note. Email-first is
the flow at web.de, Google, Microsoft and a large share of the sites a phone user
signs into. On those, the badge never appears on the screen where the username
would be filled, and on the following screen there is usually no username field
left to fill. The popup path still works.

Not a blocker for a private install. Worth a decision before a listed submission,
because it will read as "the extension does nothing on my mail provider".

### F-2 — The lockout warning can never appear during a lockout (C4's failure)

The PIN pad is meant to warn from three attempts down: "N attempts remaining
before your master password is required." On the device it never appeared. Five
wrong PINs in a row produced "Incorrect PIN" five times and then the lockout,
with no notice that anything was being spent.

The counting underneath is correct, and so is the enforcement — `Session.unlockWithPin`
charges the attempt *before* trying it and persists that immediately
(`src/session/session.ts:175-183`), which is why C4's table matched. The defect
is entirely in the popup:

- `renderUnlock` evaluates the warning once, at render time, from its
  `attemptsLeft` parameter (`src/popup/screens.ts:270`).
- A wrong PIN is handled by the form's own submit listener, which writes the
  error slot and returns (`src/popup/screens.ts:296-298`).
- `submitUnlock` re-routes **only** when the pad has become unusable, and
  otherwise rethrows so that listener can show the error
  (`src/popup/popup.ts:671-687`).

So across the whole span where the warning is due — 3, 2 and 1 attempts left —
nothing re-renders. The number baked into the screen when the popup opened is 5,
above the threshold of 3, and it never changes. Closing and reopening the popup
does show it, because the counter is persisted; a user who keeps the panel open,
which is the normal way to type a PIN, sees nothing.

Reproduced as a unit test driving `main()` through three failed unlocks against a
background that counts the way `Session` does. The rendered panel reads:

```
Your vault is locked.Unlock with your PIN to see your entries.PINIncorrect PINUnlock
```

Why 606 tests missed it: every `renderUnlock` test passes a fresh number in, so
they prove the warning renders correctly *for a given count*. `main.test.ts:257`
("takes the lockout warning from the status, not from a constant") opens the
popup already at 2 remaining. Nothing drives the sequence, which is the only
thing a real lockout does.

Severity: this is the single notice standing between a user and the permanent
loss of their PIN. Should be fixed before the private install, not after.

Re-running C4 after a fix means confirming the middle column, which is the half
that failed. The enforcement column was already confirmed on 2026-08-26:

| Wrong PINs so far | Screen must say | What the next submit does |
| --- | --- | --- |
| 0, 1 | (no warning) | attempts the PIN |
| 2 | 3 attempts remaining | attempts the PIN |
| 3 | 2 attempts remaining | attempts the PIN |
| 4 | 1 attempt remaining | attempts the PIN |
| 5 | 0 attempts remaining | **refuses without trying, drops the key** |

Each of those readings has to happen **without closing the popup**, since
reopening it is exactly what hides the bug.

## Where this run stands

14 of 25 passed, **1 failed (C4, see F-2)**, 10 remain.

The order was rearranged once, deliberately, and the reason should survive: the
device already carried **an account from an earlier test session**, and that
account is a throwaway. So everything needing a working vault was pulled forward
onto it (C1, C2, D1–D7, E1–E3), and the destructive items (C4, C5, then F) are
queued to run on it too. Only after F does the fresh setup happen — which is the
only way to reach A and B, since those test the first-run path itself.

```
done:  C1 C2 C4(!) · D1 D2 D4 D6 D7a D7b D7c · E1 E2 E3
next:  C5 → D3 → D5 → F1/F2 → [fresh setup] → B2 → A2 → A1 → B1 B3 B4 B5 → A3 → C3
```

The remaining items are deliberately being run on the build from 90ee4d6, the
same one the first 14 were run against. Fixing F-2 mid-run would split the run
across two builds and put every earlier result in question, so the fix waits
until the checklist is finished — unless it turns out to need a device to verify,
in which case it is cheaper to fix, rebuild, and re-run C4 alone.

### Next action: C5, on the throwaway account

The PIN was dropped by C4, so the popup should now open on the **re-authentication
form**, not the PIN pad. What has to hold:

- the form is the setup form in `reauthenticate` mode — not a dead PIN pad
- **server URL and email are prefilled** from the stored account
- entering the master password restores the vault and its entries

If a PIN pad appears instead, that is a failure of the same class as F-2 and worse:
the screen can no longer succeed, because `pinWrapped` is gone.

### Blocked on preparation

- **D3** needs a React-based login form whose credentials are in the vault. No
  candidate identified yet. Without one this item cannot run, and it covers a
  real failure mode: a naive `value =` assignment leaves a React form looking
  filled and submitting empty.
- **D5** still needs a throwaway vault entry with the URI `http://127.0.0.1:8000`
  (**including the port** — for IP hosts the matcher compares host *and* port).
  Create it in the web vault and sync.

  Termux is **not** required. Serve `decoy.html` (reproduced in
  `docs/DEVELOPMENT.md`) from the development machine and point the device's
  loopback at it:

  ```bash
  python3 -m http.server 8000 --bind 127.0.0.1   # in the directory holding decoy.html
  adb reverse tcp:8000 tcp:8000
  ```

  `http://127.0.0.1:8000/decoy.html` in Fenix then reaches that server, so the
  entry's URI stays exactly what the matcher needs and loopback http stays inside
  what `isFillableOrigin` allows. Note that `adb reverse` does not survive a
  device reconnect. The device has no `curl` or `wget`, so the tunnel cannot be
  proven from the shell — the http server's access log is the confirmation.
- **A3** needs a server on a non-standard port, if one exists at all. Optional.
- **C3** is a real 15-minute wait with no interaction. Park it next to something
  else; any touch of the popup resets the timer.

### How to resume

```bash
export PATH="$HOME/Android/Sdk/platform-tools:$PATH"
adb devices                       # expect: RFCN80EJ05Y  device  (not unauthorized)
npm run build
npm run start:android -- --android-device=RFCN80EJ05Y
```

The extension's `storage.local` survives a `web-ext` restart — that is how the
earlier account was still there at the start of this run. Since C4 dropped the
PIN, the throwaway account now waits at the **re-authentication form**, not the
PIN pad; the master password is what gets back in.

Two things that cost time today and need not cost it again:

- **The popup is opened from the ⋮ menu by tapping the extension's own entry.**
  Settings → Extensions → the add-on leads to Fenix's management page (Enabled /
  Run in private mode / Permissions / Remove), which says nothing about the vault.
- **`web-ext` does not reload on Android**, whatever it prints. After any source
  change, stop it and start it again, or the device keeps running the old build
  and every conclusion drawn from it is about code that is no longer in the tree.
