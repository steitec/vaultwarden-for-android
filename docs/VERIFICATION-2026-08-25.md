# Manual verification run — 2026-08-25

Vehicle: Firefox Nightly 156.0a1 (`org.mozilla.fenix`) on SM-N981B (`RFCN80EJ05Y`),
via `web-ext run`, build from 90ee4d6.
Baseline: 606 unit tests pass, `web-ext lint` 0 errors / 0 warnings / 0 notices.

**Status: 14 of 25 passed, 0 failed. Paused 2026-08-25 evening, to be continued.**
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
- [ ] C4 Wrong-PIN counting matches the table (5 tried, 6th refused + key dropped)
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

## Where this run stands

Nothing has failed. 14 of 25 passed, 11 remain.

The order was rearranged once, deliberately, and the reason should survive: the
device already carried **an account from an earlier test session**, and that
account is a throwaway. So everything needing a working vault was pulled forward
onto it (C1, C2, D1–D7, E1–E3), and the destructive items (C4, C5, then F) are
queued to run on it too. Only after F does the fresh setup happen — which is the
only way to reach A and B, since those test the first-run path itself.

```
done:  C1 C2 · D1 D2 D4 D6 D7a D7b D7c · E1 E2 E3
next:  C4 → C5 → D3 → D5 → F1/F2 → [fresh setup] → B2 → A2 → A1 → B1 B3 B4 B5 → A3 → C3
```

### Next action: C4, on the throwaway account

Lock the vault, then submit wrong PINs one at a time, reading the screen after
each. The point is the exact counting, not that a lockout eventually happens:

| Wrong PINs so far | Screen says | What the next submit does |
| --- | --- | --- |
| 0, 1 | (no warning) | attempts the PIN |
| 2 | 3 attempts remaining | attempts the PIN |
| 3 | 2 attempts remaining | attempts the PIN |
| 4 | 1 attempt remaining | attempts the PIN |
| 5 | 0 attempts remaining | **refuses without trying, drops the key** |

Have the master password ready first — after the sixth submission the PIN is
gone for good, and C5 (the re-auth form) is the only way back in.

### Blocked on preparation

- **D3** needs a React-based login form whose credentials are in the vault. No
  candidate identified yet. Without one this item cannot run, and it covers a
  real failure mode: a naive `value =` assignment leaves a React form looking
  filled and submitting empty.
- **D5** needs two things that were not ready when the run paused: a throwaway
  vault entry with the URI `http://127.0.0.1:8000` (**including the port** — for
  IP hosts the matcher compares host *and* port), and `python3 -m http.server
  8000` running in Termux over `decoy.html`. The decoy page is reproduced in
  `docs/DEVELOPMENT.md`; `adb push` it to `/sdcard/Download/`.
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
earlier account was still there at the start of this run — so the throwaway
account should still be waiting at the PIN pad.

Two things that cost time today and need not cost it again:

- **The popup is opened from the ⋮ menu by tapping the extension's own entry.**
  Settings → Extensions → the add-on leads to Fenix's management page (Enabled /
  Run in private mode / Permissions / Remove), which says nothing about the vault.
- **`web-ext` does not reload on Android**, whatever it prints. After any source
  change, stop it and start it again, or the device keeps running the old build
  and every conclusion drawn from it is about code that is no longer in the tree.
