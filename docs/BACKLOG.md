# Backlog

Every piece of open work on this add-on, in the order it should be picked up.

This file is an **index, not a second copy**. Anything with a detailed write-up
already lives somewhere — a finding in the verification log, a section in
`docs/DEVELOPMENT.md` — and the entry here points at it rather than restating
it. Restating it is how the two versions start disagreeing.

The manual verification run of 2026-08-25 is **finished** — 22 of 25 passed,
nothing failing, A1 and A2 retired by the F-3 decision rather than blocked. All three defects it found (F-2,
F-4, F-5) are fixed, confirmed on the device, and merged to `main`, so the source
is no longer frozen and anything here may be picked up. The run itself is in
`docs/VERIFICATION-2026-08-25.md`.

---

## 1. Before the private install

### 1.1 Replace the idle lock's `setTimeout` with `browser.alarms`

**Measured over a night, 2026-08-27/28, and the measurement decided it.** The
timeout was stretched to 210 minutes so the deadline would fall in deep Doze.
Over the eight hours that followed, `setTimeout` never fired: the first
interaction of the morning found `state=unlocked` with `pendingTimer=true`, four
and a half hours past the deadline, with no `FIRED` and no `lock()` anywhere in
between. Firefox never restarted, so nothing took the timer away — it simply did
not run.

This is no longer a question of lateness. The idle lock, which is the add-on's
only defence against a phone left somewhere, does not happen at all on a device
that is asleep — which is the one situation it exists for. The 2026-08-26 result
that read as mild throttling was an artefact of measuring only fifteen minutes.
Full trail, conditions and the superseded reading in
`docs/VERIFICATION-2026-08-25.md` § F-4.

**What it touches.** `alarms` in the manifest; `touch()` and `lock()` in
`src/session/session.ts`, which currently own a `setTimeout` handle
(`session.ts:215`, cleared at `session.ts:233`); and a listener, because an alarm
arrives as an event on the background page rather than as a closure, so the
route from the alarm back to `Session.lock` has to be built rather than captured.
The suite drives the current timer with `vi.advanceTimersByTime`, so it needs a
`browser.alarms` stub before any of this can be written test-first.

**Two things to settle while designing it, not after.** Whether the alarm should
also survive a browser restart, which changes whether it is re-created at
`init()`; and whether `docs/AMO-SUBMISSION.md` has to say anything about the new
permission — § 2.1 already asks for that note to be re-read against the code, and
this is a change to what the code asks for.

---

## 2. Before anything is submitted to AMO

The permission posture was decided on 2026-08-27 — the required `https://*/*`
stays, because the badge has to be drawable before the user has told the add-on
anything. The dead per-host machinery is gone, the AMO note describes one grant
taken at install, and checklist items A1 and A2 are retired. Everything that
decision implied is done; § F-3 of `docs/VERIFICATION-2026-08-25.md` carries it,
including the one thing left for the listing itself: the reviewer will ask why
every https site is needed, and the note now answers it.

### 2.1 Re-read the reviewer note against the code

It makes specific, checkable claims and has never been through a review. See
`docs/DEVELOPMENT.md` → "The AMO reviewer note has never been through a review".

### 2.2 Build the `package` / `sign` scripts

Designed and agreed on 2026-08-25, deliberately not built. The design, and why it
is two scripts rather than one, is in `docs/DEVELOPMENT.md` → "Signing and
submission: designed, not built". One point in it is open on purpose: the script
hardcodes `--channel=listed`, but the route needed first is `--channel=unlisted`
(`docs/PRIVATE-INSTALL.md`).

### 2.3 Pick a licence and put it in the repository

There is no `LICENSE` or `COPYING` file, and `package.json` carries no `license`
field — only `"private": true`, which is a different thing (it stops an
accidental `npm publish` and says nothing about the terms). Without a stated
licence the default is "all rights reserved", which sits badly with a listed
AMO add-on whose source archive is uploaded for review and, for a listed
listing, shown with a licence on its page.

Independent of everything else in this section — it can be done at
any point, and it is a decision rather than work.

The decision worth making deliberately, since it is the same question
monetisation ran into on 2026-08-26: a permissive licence (MIT, BSD) lets anyone
redistribute and repackage, a copyleft one (GPL, AGPL) lets them fork but
requires they publish their changes. Neither prevents a fork — an add-on ships
as readable JavaScript with its source archive attached, so "nobody can take
this" is not on the table whichever is chosen. Pick for what should happen to
the changes, not for control.

---

## 3. Gaps in what already ships

Not postponed features — these are true of the current build, and each will
eventually be somebody's bug report. Full write-ups in `docs/DEVELOPMENT.md` →
"Known gaps in what already ships", except F-1, which is in the verification log.

- **Email-first login flows get no badge at step 1** (F-1). web.de, Google,
  Microsoft: the first screen has no password field, so the content script stays
  silent by design — and on the next screen there is usually no username field
  left to fill. The popup path still works. Reads as "the extension does nothing
  on my mail provider", so it wants a decision before a listed submission.
- **A `<select>` username field is never filled.** Concrete trigger: a FRITZ!Box
  with FRITZ!Benutzer configured. Produces a filled password beside an untouched
  dropdown, which looks like partial success. jsdom covers it; no device needed.
- **`http://[::1]` gets no badge.** No fix inside MV2 — a limitation of match
  patterns, recorded so nobody spends an afternoon on it.

---

## 4. Deferred to v2

Unchanged and still just a list, kept in `docs/DEVELOPMENT.md` → "Deferred to
v2": item creation and editing, save-password prompts, Sends and attachments,
card and identity types, passkeys, multiple accounts, WebSocket push sync, a full
public suffix list, and a TOTP display in the popup.

---

## 5. Traps for a future verification run

Not work to be done — things that have already cost time, or nearly did, and
would cost it again.

- **A `web-ext` restart brings back form values the add-on typed earlier.**
  Established 2026-08-26 by reproduction, after a first guess that was wrong.

  What happens: the test login page sits with empty fields, `web-ext`
  reinstalls the extension — which restarts Fenix — and the username field
  comes back filled. **The vault is locked throughout**, and a locked vault
  holds no plaintext at all: every fill path goes through `require()` and
  fails with `LockedError`. So the add-on cannot be the source, by capability
  rather than by argument.

  It is Firefox restoring form data along with the session. The value itself
  most likely came from the add-on's own fill during D1/D2, snapshotted then
  and replayed now — the extension seeing its own old input come back.

  Note that a **manual reload does not trigger this**; only a browser restart
  does. The first check tried — reload the page, observe an empty field —
  therefore proved nothing, and was consistent with either explanation.

  The trap is in reading the checklist: D2 and D6 both assert that a tap fills
  username *and* password. After any `web-ext` restart the username may already
  be there, and a broken username fill still looks like a pass. Clear both
  fields before the tap, or run the item in a private tab, where neither
  session restore nor Firefox's own autofill applies. D2 and D6 were not
  affected — both fields were empty when they were run — but nothing in the
  checklist said to check.

- **`web-ext` does not reload on Android**, whatever it prints. Stop it and
  start it again after any source change, or the device keeps running the old
  build and every conclusion is about code that is no longer in the tree.

- **Reinstalling does not reach a page that is already open.** Established
  2026-08-27, after two rounds of testing a fix against the old code. A
  reinstalled extension injects its content script into *new* page loads only,
  and `adb shell am start` with a URL the tab already holds re-focuses that tab
  without loading anything. The screenshot then shows the previous build's
  badge, sitting exactly where it was left. Add a cache-busting query
  (`?r=$(date +%s)`) so the navigation is real, and confirm from the tab
  count or the URL that it happened.

- **Extension `console.log` does not reach `adb logcat`** on Fenix. Verified
  2026-08-26 with zero hits. Diagnostics need another channel; the loopback
  beacon on `debug/f4-idle-lock` is one that works.
