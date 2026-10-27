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

### 1.1 ~~Replace the idle lock's `setTimeout`~~ — done 2026-08-28

The overnight run of 2026-08-27/28 showed `setTimeout` never fires on a sleeping
device. The fix is not `browser.alarms`, which Gecko implements with its own
in-process timers and which a frozen process freezes just the same. The idle
lock is now a **deadline**, settled at four call sites — `Controller.require()`,
`status()`, `matchesFor()` and `syncAttempt()` — which cannot fail to fire
because nothing has to fire. The last two were each found in review rather than
in design, on the same defect twice; § 5.3 and § 7 of the design say why a
method that reads session state directly, instead of going through
`require()`, needs its own call, and why that convention was still missed a
second time after the first fix.

Both questions this entry left open are answered: no persistence is needed,
because `init()` already locks a session that outlived its background page; and
no permission is added, so the AMO note in § 2.1 is unaffected by this change.

**Confirmed on the device the night of 2026-08-28/29**, against the same rig and
the same 210-minute deadline that left the old build unlocked after eight hours:
the popup showed the PIN pad. Same process throughout, so the lock was the
deadline and not a restart.

Full trail in `docs/VERIFICATION-2026-08-25.md` § F-4. The shape of the fix, in
one sentence: the lock stores a **deadline** rather than arming a timer, and
that deadline is read at the four call sites that touch session state —
`Controller.require()`, `status()`, `matchesFor()` and `syncAttempt()`. Nothing
has to fire, so nothing can fail to fire on a frozen process.

---

## 2. Before anything is submitted to AMO

The permission posture was decided on 2026-08-27 — the required `https://*/*`
stays, because the badge has to be drawable before the user has told the add-on
anything. The dead per-host machinery is gone, the AMO note describes one grant
taken at install, and checklist items A1 and A2 are retired. Everything that
decision implied is done; § F-3 of `docs/VERIFICATION-2026-08-25.md` carries it,
including the one thing left for the listing itself: the reviewer will ask why
every https site is needed, and the note now answers it.

### 2.1 ~~Re-read the reviewer note against the code~~ — done 2026-08-29

Read claim by claim against the source. Everything security-bearing held; one
claim was false (loopback as a server), two numbers had drifted, the storage
list was incomplete, and `source.zip` is now gitignored rather than merely
warned about. See `docs/DEVELOPMENT.md` → "The AMO reviewer note, reviewed
2026-08-29".

It is worth doing again before each submission rather than once: this pass
found a sentence that was the mirror image of the code it described.

### 2.2 ~~Build the `package` / `sign` scripts~~ — done 2026-08-29

Built as `package` and `sign:unlisted`, with the channel in the script name and
a clean-tree check in `package`. Both departures from the 2026-08-25 design are
argued in `docs/DEVELOPMENT.md` → "Signing and submission". `tests/scripts.test.ts`
pins what makes them safe.

There is deliberately **no `sign:listed` script**. Writing one is the act that
makes a public submission possible, and it should be a decision rather than a
line that is already there.

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
- **A badge tap against a locked vault is lost when the vault is opened with
  the master password.** `redeemPending()` hangs off `unlock(pin)` alone
  (`src/background/controller.ts`); `setup()` never calls it. Today that costs
  a tap only after a PIN lockout. For an account that unlocks without a PIN it
  costs one after every Firefox restart, which is that mode's ordinary way
  back in. The fix is one call in `setup()`: `redeemPending` goes through
  `fill()` unchanged, so the https check, the URL re-match against the tab and
  the refusal for a passwordless entry all still apply. Found 2026-08-30 while
  building the PIN-less option, and deliberately left out of that branch.
- **A re-authentication resets the idle timeout and the restart policy.**
  `setup()` rebuilds the record and writes `DEFAULT_LOCK_TIMEOUT_MINUTES` and
  `DEFAULT_REQUIRE_MASTER_PASSWORD_ON_RESTART` over whatever was there. The
  unlock mode is now preserved across that path, deliberately; these two are
  not, and nothing tells the user. Invisible today because neither has a
  control in the interface — which is also why fixing it belongs with building
  those controls rather than before them.
- **The full checklist has never run on the release channel.** The private
  install was done on 2026-08-29 and smoke-tested there — setup, lock/unlock,
  badge and fill, all passing on release Firefox 154.0 with the signed build.
  Everything else is carried by the run of 2026-08-26, which was Nightly with a
  temporary add-on: the fifteen-minute idle lock, the wrong-PIN counter, the
  React form, the off-screen decoy, offline cache and sign-out. Nothing suggests
  the channel changes any of them, which is why this is a gap and not a task.
  Worth closing before a listed submission, when the release channel is what
  every reviewer and every user will be on.
  See `docs/PRIVATE-INSTALL.md` → "Walked for real, 2026-08-29".
- **PIN-less unlock has never run on a phone.** Merged 2026-08-30 with the
  unit suite green, and the suite cannot reach either half of what actually
  matters here. Two checks, both on the device:

  1. Turn the switch on, then restart Firefox. The master-password screen must
     come up **without a PIN field**, and signing in must leave the account
     still PIN-less. This is `setup()`'s preserve-the-mode path, and if it is
     wrong the option turns itself off once a day — quietly, since the form
     would simply ask for a PIN as it always did.
  2. Leave the phone asleep well past fifteen minutes with the vault open. It
     must still be open. The same rig as F-4, with the opposite expectation:
     there, a frozen process had to wake up locked; here it must wake up
     unlocked, because no deadline was ever armed.

  Until both are done, the mode is tested only against jsdom and a fake
  server, which is exactly the gap the overnight run of 2026-08-27/28 existed
  to close for the idle lock.

- **The editor has never run on a phone.** Built 2026-09-25 with the unit suite
  and the live-container suite green, and neither can reach what actually
  matters here. Three checks, all on the device:

  1. Create an entry on the phone, then fill it on a real page.
  2. Add notes to an entry in the web vault, change that entry in the add-on,
     then find the notes still there. This is the failure mode the whole
     design was written around — `PUT /api/ciphers/{id}` is a full replace, so
     a body built from the wrong thing deletes them silently. The integration
     suite covers it against the pinned container; the device adds the real
     account and the real network.
  3. Delete an entry and find it in the web vault's trash.

---

## 3.1 Licence notice missing from the built bundle

**Done 2026-10-27:** `scripts/build-classic-entry.mjs` prepends the LICENSE of
every package listed under `licences` in `scripts/entries.mjs` (today:
`hash-wasm` in `background.js`); `tests/build-classic-scripts.test.ts` checks
the built file. Done together with the vite 5 → 7 update, which dropped the
`/*!` header that had survived by accident until then.

Found 2026-08-29 while licensing the repository for publication. `hash-wasm` is
MIT and is bundled into `dist/background.js`; its copyright notice does not
survive the bundler, so a signed XPI redistributes the code without the notice
MIT requires to accompany it.

`THIRD-PARTY-NOTICES.md` covers the repository. It does not cover the artefact,
which is what actually gets distributed. The fix is a banner preserved through
the build — `esbuild.legalComments` or an explicit banner in `scripts/build.mjs`
— and it was deliberately not done during the publication work, because changing
what the build emits days after a signed build went onto a phone is a change
that wants its own verification rather than a footnote in someone else's task.

---

## 4. Deferred to v2

Unchanged and still just a list, kept in `docs/DEVELOPMENT.md` → "Deferred to
v2": save-password prompts, Sends and attachments,
card and identity types, passkeys, multiple accounts, WebSocket push sync, a
refresh mechanism for the embedded public suffix list (the list itself is
complete; it is a build-time snapshot), and a TOTP display in the popup.

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
