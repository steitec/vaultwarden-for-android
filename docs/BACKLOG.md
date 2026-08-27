# Backlog

Every piece of open work on this add-on, in the order it should be picked up.

This file is an **index, not a second copy**. Anything with a detailed write-up
already lives somewhere — a finding in the verification log, a section in
`docs/DEVELOPMENT.md` — and the entry here points at it rather than restating
it. Restating it is how the two versions start disagreeing.

The manual verification run of 2026-08-25 is **finished** — 22 of 25 passed,
nothing failing, A1 and A2 blocked on 2.1 below. All three defects it found (F-2,
F-4, F-5) are fixed, confirmed on the device, and merged to `main`, so the source
is no longer frozen and anything here may be picked up. The run itself is in
`docs/VERIFICATION-2026-08-25.md`.

---

## 1. Before the private install

### 1.1 Badge icon: a lock and a key, not two locks

Decided 2026-08-26. `src/content/badge.ts:20-24` uses `\u{1F512}` (🔒) for both
`fill` and `chooser`, and `\u{1F513}` (🔓) for `unlock`. The two differ only in
whether the shackle leans, which at the badge's 14px is a couple of pixels.
Replace the `unlock` glyph with a key so the two states differ in shape rather
than in one detail of the same shape.

Two things found while looking, worth having in hand before touching it:

- `color:#ffffff` on the glyph element (`badge.ts:59`) does nothing. Colour emoji
  ignore `color` and are drawn by the system emoji font, so the badge is
  currently a system-coloured glyph on the dark blue background, not a white one.
  Inline SVG would put that back under our control; the emoji route keeps the
  dependency on whatever font the device happens to ship.
- **Nothing tests the glyph.** The badge tests assert on `BADGE_HOST_ATTR` and
  the per-mode `aria-label`s, both of which already distinguish all three modes
  correctly. `docs/superpowers/plans/2026-08-25-inline-autofill-badge.md:567`
  quotes the old line and should be left alone as a historical plan.

Still open, and not answered by this decision: `fill` and `chooser` share one
glyph, so the badge does not distinguish "one entry, tapping fills it" from
"several entries, tapping opens a chooser". That may well be right — the tap is
safe either way — but it is a choice, not an accident, and nothing records it.

### 1.2 Measure the idle lock over a long idle, and decide about `browser.alarms`

Measured 2026-08-26, screen off and on battery: the fifteen-minute idle lock
fired, but **59 seconds late**, and it landed the instant the device woke. So
`setTimeout` is not lost — the worst case does not happen — but it is throttled.

Fifteen minutes is short for Android's power management; Doze deepens with longer
stillness. A phone left overnight has not been measured, and the lateness there
could be far larger. The rig for it exists: branch `debug/f4-idle-lock` plus the
loopback beacon, and `lateByMs` is computed from the wall clock, so it stays
honest however late the beacon itself arrives.

If a long idle is much worse, the fix is `browser.alarms`, which is designed to
survive suspension and needs the `alarms` permission. That is a larger change
than either fix this run produced, which is why it is a measurement first and a
decision second. Full trail in `docs/VERIFICATION-2026-08-25.md` § F-4.

---

## 2. Before anything is submitted to AMO

### 2.1 Decide the permission posture (F-3)

`https://*/*` became a **required** permission in `dade555` as a side effect of
declaring the content script statically. Keep the broad install-time grant, or go
back to a per-host grant with `browser.contentScripts.register()`? Both options,
and why the narrow one is not the obvious win, are in
`docs/VERIFICATION-2026-08-25.md` § F-3.

Everything below in section 2 depends on this answer. It is also what makes A1
and A2 blocked rather than failed — whichever way it goes, those two checklist
items need rewriting or removing.

### 2.2 Stop `docs/AMO-SUBMISSION.md` contradicting itself

Its "Page access" paragraph describes the manifest as it is; its "Server access"
paragraph still claims "The broad pattern is never requested" and presents the
single-host `permissions.request()` as the live mechanism. A reviewer reading
both sees a contradiction, and the second claim is the false one. **This must not
go out as it stands.**

### 2.3 Remove what the permission change left behind

Dead code and false comments, all listed in § F-3: `HostPermissionDeniedError`
and the denial branch in `submitSetup`, the now-redundant `optional_permissions`,
and two comments in `src/content/autofill.ts` that still describe on-demand
injection.

### 2.4 Re-read the reviewer note against the code

It makes specific, checkable claims and has never been through a review. See
`docs/DEVELOPMENT.md` → "The AMO reviewer note has never been through a review".

### 2.5 Build the `package` / `sign` scripts

Designed and agreed on 2026-08-25, deliberately not built. The design, and why it
is two scripts rather than one, is in `docs/DEVELOPMENT.md` → "Signing and
submission: designed, not built". One point in it is open on purpose: the script
hardcodes `--channel=listed`, but the route needed first is `--channel=unlisted`
(`docs/PRIVATE-INSTALL.md`).

### 2.6 Pick a licence and put it in the repository

There is no `LICENSE` or `COPYING` file, and `package.json` carries no `license`
field — only `"private": true`, which is a different thing (it stops an
accidental `npm publish` and says nothing about the terms). Without a stated
licence the default is "all rights reserved", which sits badly with a listed
AMO add-on whose source archive is uploaded for review and, for a listed
listing, shown with a licence on its page.

Independent of 2.1 and of everything else in this section — it can be done at
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

- **Extension `console.log` does not reach `adb logcat`** on Fenix. Verified
  2026-08-26 with zero hits. Diagnostics need another channel; the loopback
  beacon on `debug/f4-idle-lock` is one that works.
