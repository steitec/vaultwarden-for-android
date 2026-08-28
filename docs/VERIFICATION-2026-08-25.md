# Manual verification run — 2026-08-25

Vehicle: Firefox Nightly 156.0a1 (`org.mozilla.fenix`) on SM-N981B (`RFCN80EJ05Y`),
via `web-ext run`, build from 90ee4d6.
Baseline: 606 unit tests pass, `web-ext lint` 0 errors / 0 warnings / 0 notices.

**Status: 22 of 25 passed, nothing failing, 2 blocked (A1 A2, see F-3),
1 not applicable (A3), 0 open. C3 and C4 passed on re-runs against the fixes.
Paused 2026-08-25 evening, resumed 2026-08-26. Closed 2026-08-27 with the F-3
decision, which retires A1 and A2 rather than unblocking them.**
Resume instructions are at the bottom.

Legend: `[ ]` not run · `[x]` pass · `[!]` FAIL · `[-]` skipped/blocked

## A. Host permission — highest risk
- [-] A1 "Sign in" raises Firefox's permission prompt naming the server host; accepting continues setup
      — BLOCKED, unreachable on this build. RETIRED 2026-08-27 by the F-3 decision:
      the prompt cannot exist, and the checklist now asserts its absence instead.
- [-] A2 Denying gives a readable explanation, form keeps entered values
      — BLOCKED, unreachable on this build. RETIRED with A1, same reason.
- [-] A3 Server on a non-standard port (if available)
      — NOT APPLICABLE, 2026-08-26. The checklist made this conditional on such a
      server existing, and none does. Nothing was observed either way: the port-handling
      code is covered by the unit suite only. If a non-standard-port server ever exists,
      this is worth running then.

## B. Setup and sign-in
- [x] B1 `Controller.setup` completes end to end against the real https server
      — pass, 2026-08-26, the authenticator code completed the sign-in and the vault
      screen appeared. First end-to-end run of the real first-run path on the device.
- [x] B2 `http://` server address refused with a "use https" message — pass, 2026-08-26
- [x] B3 Two-factor prompt appears / lists real providers / correct code completes
      — pass, 2026-08-26, the screen offered "Authenticator app" and nothing else,
      matching the account. Only providers 0 and 1 are rendered by design
      (`src/popup/screens.ts:313-315`); a security key would have produced the
      "cannot complete" screen instead.
- [x] B4 Wrong master password reported as wrong password, not as a 2FA challenge
      — pass, 2026-08-26, "Email or password incorrect" on the setup form, no two-factor
      screen. The account has 2FA enabled, so this is the sharp case: both answers are
      HTTP 400 and only the provider list separates them (`src/api/identity.ts:154-159`).
- [x] B5 Vault lists entries immediately after setup
      — pass, 2026-08-26, entries listed straight away, with no "Sync now" tap in between.

## C. Lock, unlock, PIN lockout
- [x] C1 "Lock" returns to the PIN pad — pass, on the leftover account
- [x] C2 Correct PIN restores the list — pass, twice (before and after C1)
- [x] C3 Auto-lock after 15 minutes of no interaction
      — **pass on the second run**, 2026-08-26, on the build carrying the F-4 fix.
      Unlocked 17:24:23, popup closed, nothing touched; the PIN pad was there at
      17:40. The login.example.com login page was reloaded and left open
      during the window, so it sent the very `matches` query that broke the first
      run — and the timer ran out anyway. That makes this the fix's confirmation
      on hardware, not just a clean-room pass.
      First run FAILED: the panel opened on the entry list after more than fifteen
      minutes. The screen had been touched every few minutes to keep it awake, on
      the login page, and each touch restarted the idle timer through the badge's
      `matches` query. The timer itself was exact throughout. See F-4.
- [x] C4 Wrong-PIN counting matches the table (5 tried, 6th refused + key dropped)
      — **pass on the second run**, 2026-08-26, on the build carrying the F-2 fix.
      The middle column is now right: without the popup being closed, the pad showed
      3, then 2, then 1 attempts remaining in order, each beside "Incorrect PIN"
      rather than in place of it, and 0 after the fifth. The sixth submit was
      refused without being tried and the key was dropped.
      First run FAILED on that middle column alone: the pad showed only "Incorrect
      PIN", five times, and the user reached the lockout with no notice. The
      enforcement was exactly right even then. See F-2.
- [x] C5 After the key is dropped: re-auth form, server URL and email prefilled; master password restores the vault — pass, 2026-08-26

## D. Autofill
- [x] D1 Matching entries listed first on a known login page — pass, login.example.com
- [x] D2 Tapping an entry fills username + password, popup closes — pass
- [x] D3 Filling works on a React-based login form — pass, 2026-08-26, on the
      served React 18.3.1 form: both `react state` lines FILLED, verdict PASS
- [x] D4 Non-matching entry is refused with an explanation — pass, "This entry does not match the page that is currently open…" (controller.ts:548)
- [x] D5 Decoy page: visible fields FILLED, both decoy fields empty — pass,
      2026-08-26, filled via the badge. First execution of `isRenderedOffScreen`
      in a real layout engine; the unit suite only ever reached its CSSOM half.
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
- [x] F1 "Sign out" asks for confirmation — pass, 2026-08-26
- [x] F2 After confirming: setup screen, not the unlock screen — pass, 2026-08-26, the wipe happened

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

The reproduction is kept here rather than in `tests/`, because committing a
failing test would leave the suite red for as long as F-2 is unfixed. Drop it in
as `tests/popup/lockout-warning.test.ts` when the fix is written — it is the
regression test:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { main } from "../../src/popup/popup";
import type { Status } from "../../src/background/messages";

const SKELETON = `
  <header id="status" class="status"></header>
  <nav id="settings" class="settings" hidden></nav>
  <input id="search" class="search" type="search" />
  <p id="error" class="banner" role="alert" hidden></p>
  <main id="root"></main>
`;

function requireEl(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found;
}

function oneInput(scope: ParentNode, selector: string): HTMLInputElement {
  const found = scope.querySelector(selector);
  if (!(found instanceof HTMLInputElement)) throw new Error(`no input matching ${selector}`);
  return found;
}

function submitForm(scope: ParentNode): void {
  const form = scope.querySelector("form");
  if (!(form instanceof HTMLFormElement)) throw new Error("no form to submit");
  form.dispatchEvent(new Event("submit", { cancelable: true }));
}

function kindOf(req: unknown): string {
  if (typeof req !== "object" || req === null) return "";
  if (!("kind" in req) || typeof req.kind !== "string") return "";
  return req.kind;
}

/** A background page that counts failed PIN attempts the way Session does. */
function lockoutResponder(): (req: unknown) => unknown {
  let failed = 0;
  return (req: unknown) => {
    const kind = kindOf(req);
    if (kind === "status") {
      const s: Status = {
        state: "locked",
        lastSyncMs: 1,
        email: "a@b.com",
        serverUrl: "https://vault.example.net",
        pinUnlockAvailable: failed < 5,
        pinAttemptsRemaining: Math.max(0, 5 - failed),
      };
      return s;
    }
    if (kind === "unlock") {
      failed += 1;
      throw new Error("Incorrect PIN");
    }
    throw new Error(`unexpected kind ${kind}`);
  };
}

async function wrongPin(): Promise<void> {
  const root = requireEl("root");
  oneInput(root, "#unlock-pin").value = "000000";
  submitForm(root);
  await vi.waitFor(() => expect(root.querySelector(".error")?.textContent).toMatch(/incorrect/i));
}

beforeEach(() => {
  document.body.innerHTML = SKELETON;
  vi.spyOn(window, "close").mockImplementation(() => {});
  const responder = lockoutResponder();
  vi.stubGlobal("browser", {
    runtime: { sendMessage: vi.fn((req: unknown) => Promise.resolve(responder(req))) },
    tabs: { query: () => Promise.resolve([]) },
    permissions: { request: () => Promise.resolve(true) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("REPRO: the lockout warning during a run of wrong PINs", () => {
  it("warns once only two attempts are left", async () => {
    await main();
    const root = requireEl("root");
    expect(root.textContent).not.toMatch(/attempts remaining/i);

    await wrongPin(); // 4 left
    await wrongPin(); // 3 left
    await wrongPin(); // 2 left -- under the threshold, the warning is due

    expect(root.textContent).toMatch(/2 attempts remaining/i);
  });
});
```

**Fixed and verified.** The count now travels with the rejection: `submitUnlock`
already fetched fresh status to decide whether the pad had become unusable, and
when it is still usable it throws `PinRejected` carrying `pinAttemptsRemaining`
instead of rethrowing plainly. `renderUnlock` re-renders its warning in place
from that number. Routing to a fresh screen would also have shown it, but would
have discarded the error the user needs to read. The test below is committed as
`tests/popup/lockout-warning.test.ts`, alongside a second one walking the whole
countdown. Confirmed on the device by C4's re-run.

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

### F-3 — The host permission prompt cannot appear; `https://*/*` is required at install

Observed while starting A2 on 2026-08-26: entering the server address, email,
master password and PIN and tapping "Sign in" went straight to the two-factor
screen. No Firefox permission prompt appeared at any point.

It cannot appear. `src/manifest.json` lists `https://*/*` in the **required**
`permissions` array, so the grant happens at install time. `permissions.request()`
in the popup (`src/popup/popup.ts:631`) has nothing left to ask for and resolves
true without a prompt; `permissions.contains()` in `Controller.setup`
(`src/background/controller.ts:269`) is always true. A1 and A2 therefore test a
path the manifest removed — they are blocked, not failing.

**Where it came from.** `dade555`, "feat: declare the content script instead of
injecting it on demand", part of the badge branch merged in `d985900`:

```diff
- "permissions": ["storage", "activeTab"],
+ "permissions": ["storage", "https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
+ "content_scripts": [{ "matches": ["https://*/*", ...], "js": ["autofill.js"], ... }]
```

A statically declared content script needs host permissions at install, so the
change was load-bearing for the badge. What it also did, silently, was convert a
per-host grant chosen by the user at setup into an all-https grant taken at
install. That is a change of posture, and nothing in the tree records it as a
decision.

**What it leaves behind.**

- `HostPermissionDeniedError` (`controller.ts:47`) and the denial branch in
  `submitSetup` (`popup.ts:632-637`) are dead code.
- `optional_permissions: ["https://*/*"]` is redundant — the same pattern is
  already required.
- Two comments in `src/content/autofill.ts` describe the old world: "Injected on
  demand by the background page" and "this listener is never registered
  statically (see manifest.json's absent content_scripts)". Both are false now.
- **`docs/AMO-SUBMISSION.md` contradicts itself.** Its "Page access" paragraph
  correctly says the manifest requests `https://*/*` and registers a content
  script on it. Its "Server access" paragraph still says "The broad pattern is
  never requested" and describes the single-host `permissions.request()` as the
  live mechanism. A reviewer reading both sees a contradiction, and the second
  claim is the false one.

**The decision this needs.** Either:

1. **Keep the required `https://*/*`.** Then A1 and A2 come off the checklist,
   the dead code goes, the stale comments go, and the AMO text is rewritten to
   describe one grant taken at install. Expect the listing review to ask why the
   add-on needs every https site; the honest answer is that the badge has to be
   present on a login page before the user has told the add-on anything.
2. **Go back to an optional per-host grant**, registering the content script at
   runtime with `browser.contentScripts.register()` once the host is granted.
   MV2 in Firefox supports this. It restores A1 and A2 and keeps the narrow
   posture the design argued for, at the cost of a badge that only ever appears
   on the user's own server host — which is not where login forms are, so the
   badge would effectively need the broad grant anyway to stay useful.

Option 2 is not the obvious win it first looks like: the badge exists to appear
on *other people's* login pages. That is worth deciding deliberately rather than
inheriting from a commit that was about something else.

Not a blocker for the private install. It is a blocker for the AMO text being
accurate, and the submission notes must not go out as they stand.

**Decided 2026-08-27: option 1, keep the required grant.** On Android there is
no autofill-service route to a login form, so the inline badge is how this
add-on reaches one at all — and option 2 does not buy a narrower posture, it
buys no badge on the pages the badge exists for. A third option was weighed and
rejected for the same reason: `activeTab` would cover the popup-driven fill with
no host grant whatsoever, since the user's tap on the browser action is the
gesture it needs, but it cannot put anything on the page beforehand.

What that decision changed, all in the same commit as this paragraph:

- `optional_permissions` is gone from the manifest. Declaring a wildcard as
  optional that is already required asks for nothing and tells a reviewer that
  some access is deferred to a runtime prompt, which is false.
- `permissions.request()` in `submitSetup`, its denial branch, and
  `SetupValues.originPattern` are gone; so are `permissions.contains()` in
  `Controller.setup` and `HostPermissionDeniedError`. Against a wildcard already
  held, every one of them could only answer yes.
- The two comments in `src/content/autofill.ts` now describe a statically
  declared content script, which is what it is.
- `docs/AMO-SUBMISSION.md` § "Server access" no longer claims the broad pattern
  is never requested. It describes one grant taken at install, and says plainly
  that the extension contacts exactly one server.
- The checklist's "Host permission" section in `docs/DEVELOPMENT.md` retires A1
  and A2 and asserts the opposite of what they asserted: no prompt during
  sign-in. A prompt there would now mean the manifest had been narrowed without
  the popup being given a way to ask again.

The unit suite lost five tests that existed only to pin the request, and gained
two that pin what the port question turned into: a server on a non-standard port
reaches setup with its port intact. 610 pass, `web-ext lint` is 0/0/0.

Left for the listing, not for the code: the reviewer will ask why the add-on
needs every https site. The answer is the badge, and it is the answer the note
now gives. Bitwarden's own extension holds a comparable grant — worth checking
against its published manifest before leaning on it in a reply, rather than
asserting it.

### F-4 — The 15-minute idle auto-lock did not happen (C3's failure)

Observed 2026-08-26: the vault was left alone for more than fifteen minutes with
the popup closed, and still opened on the entry list. Screen on, Firefox in the
foreground, the login.example.com login page open in a tab.

**What the observation already establishes.** The background page was never
reloaded. The user key lives only in memory, so a reload would have produced the
PIN pad. The process survived and the timer either never expired or was restarted.

**There is exactly one timer in the add-on.** `Session.touch()` installs a plain
`setTimeout` (`src/session/session.ts:215`) and `touch()` is called from only two
places: `Session.unlockWithPin` and `Controller.require()`
(`src/background/controller.ts:425`). There is no `browser.alarms` anywhere, and
the manifest requests no `alarms` permission.

**H1 — a background tab restarts the timer with no user involvement.** The chain
is unbroken in the source:

- `startObserving` installs a `MutationObserver` on `documentElement` with
  `subtree: true` (`src/content/autofill.ts:351`) — any node added or removed
  anywhere on the page.
- After a 300 ms debounce it calls `refreshBadge` (`autofill.ts:345-348`).
- `refreshBadge` sends `{kind:"matches"}`, but only when the page has a visible
  password field (`autofill.ts:257-262`). Ordinary browsing is protected; a login
  page is not.
- `Controller.matchesFor` calls `require()` (`controller.ts:516`), and `require()`
  calls `session.touch()` (`controller.ts:425`) — the idle timer restarts.

So while any tab holds a login page whose DOM keeps changing — a carousel, a
spinner, a clock, a React re-render, an ad — the idle lock can never expire, and
the user does nothing to cause it. For a password manager that is severe: the
lock is defeated by a tab sitting in the background.

H1 requires ongoing mutation. A genuinely static login page triggers the observer
once, at load, and the timer would then run out normally. Whether
login.example.com mutates is the open question.

**H2 — the process was frozen and the timer never advanced.** `setTimeout` only
counts while the process runs, and nothing here survives suspension. Largely ruled
out for this observation: the screen was on and Firefox was in the foreground.
It stays a real gap in its own right, because a phone in a pocket is exactly the
case the idle lock exists for, and `setTimeout` is the wrong mechanism for it.
`browser.alarms` is the one that survives suspension.

**Root cause, confirmed on the device 2026-08-26.** H1 is the cause; H2 is not.

The badge on the login page did not flicker, which ruled out a fast mutation
loop. Diagnostics were then added on branch `debug/f4-idle-lock` — passive only,
logging at events that already happen, because a polling heartbeat would keep the
page alive and mask the measurement. Extension `console.log` does not reach
`adb logcat` on Fenix (verified, zero hits), so each event also beacons to
`http://127.0.0.1:8000/f4/<msg>` and the loopback server's access log is the
record. Same tunnel as D5's decoy page; `http://127.0.0.1/*` is already a
manifest permission.

An undisturbed run, screen kept on, nothing touched:

```
16:57:20  arm delayMs=900000          armed at unlock
   ...    fifteen minutes, not one message
17:12:20  FIRED lateByMs=0            exact
17:12:20  lock() state=unlocked
```

**The timer itself is correct** — it fires to the millisecond when nothing
restarts it. The same run also caught the restart happening: 135 ms after being
armed, a single `matches` message from the open login page produced
`touch state=unlocked pendingTimer=true sinceArmedMs=135` and a second `arm`.

What failed on the first attempt was therefore not the timer but what counts as
interaction. During that run the screen was touched every few minutes to keep it
from going off — on the login page, on instruction from this session that
"ordinary browsing is harmless". It is not harmless: on a page with a password
field, a touch that mutates the DOM reaches `refreshBadge`, and the chain to
`touch()` runs. One such event every few minutes is enough for fifteen minutes
never to elapse.

**The defect this exposes is wider than the test.** `matchesFor` is not a user
action. It fires from a `MutationObserver`, so a login page that mutates on its
own — an ad rotating, a carousel, a clock, a React re-render — extends the
vault's idle timer with nobody present at all. The idle lock can be held open
indefinitely by a tab. `require()` calls `touch()` for every caller
(`controller.ts:425`), and only some of its callers are user actions: `list`,
`fill`, `fillFromPage` and `totp` are, `matchesFor` is not.

**Fix direction, not yet built:** take `touch()` out of `require()` and call it
from the user-initiated paths only, so reading matches for a badge stops counting
as interaction. Needs a failing test first, driving `matchesFor` and asserting
the timer is not restarted.

**Fixed and verified.** `require()` now takes the intent at every call site and
touches only for `"user"`; `matchesFor` passes `"page"`. Two tests, both watched
failing first: one drives `matchesFor` fourteen minutes into the timeout and
asserts the deadline did not move, the other guards against over-correcting by
asserting the popup's own search still does move it. Confirmed on the device by
C3's re-run at 17:40, with the login page reloaded and open throughout.

**H2, measured 2026-08-26.** The screen-off case was finally run, and the answer
is neither of the two that were guessed at.

Conditions were chosen so the result would mean something: `adb` was moved to
WiFi and the cable pulled, because Android is markedly more lenient with
background processes while charging — Doze does not engage at all — so a pass on
USB would have proved nothing about a phone in a pocket. Battery at 74%, screen
switched off deliberately rather than left to time out, device left lying still.

```
17:49:47  arm delayMs=900000
   ...    screen off, on battery, untouched
18:05:52  FIRED lateByMs=58692        fired on wake, 59s late
18:05:52  lock()
```

**`setTimeout` was not lost — over fifteen minutes.** The lock did occur. The
generalisation drawn from it here, that the worst case does not happen, did not
survive a longer run and is corrected below.

**It was not on time either.** Roughly one minute late on a fifteen-minute
timeout, and it landed the moment the device woke. The process therefore ran for
most of the window and was throttled or briefly frozen near the end; a full
fifteen minutes of suspension would have produced fifteen minutes of lateness,
not one.

**What this does not answer.** Fifteen minutes is short for Android's power
management: Doze only deepens after longer stillness. A phone left overnight is
untested, and the lateness there could be far larger than a minute. That run has
since happened, and the answer is worse than the question expected — see the
next section.

The trail also shows no message beacon before the `FIRED`, which confirms the
popup was not opened first — opening it would have called `list`, touched the
session and moved the deadline, and the run would have measured nothing.

**H2 over a night, measured 2026-08-27/28. `setTimeout` does not fire at all.**

The fifteen-minute run above could not reach the state it was trying to describe.
Doze deepens with stillness, and fifteen minutes never gets there; the deadline
falls while the device is still shallowly idle, which is why that run looked like
mild throttling. So it was repeated over a night, with the timeout stretched to
210 minutes so that the deadline would land in deep Doze — three and a half hours
after the phone was put down and four and a half hours before it was picked up.
Far enough from both ends that a fire at the deadline and a fire on waking could
not be mistaken for each other.

Conditions: armed 22:05:06 on battery at 86%, cable pulled, screen switched off
deliberately rather than left to time out, device left lying still and untouched
until 06:03. Battery saver was switched off first and confirmed unable to turn
itself back on (`mSettingAutomaticBatterySaver=0`, trigger threshold 0), so the
run could not silently become a measurement of power-saving mode partway through.
No adb overnight, and that was the point: the tunnel keeps the device awake and
works against the very Doze being measured, so `storage.local` was made the
record and the loopback beacon merely its reader.

```
22:05:06  arm delayMs=12600000
   ...    eight hours, not one event
06:03:46  touch state=unlocked pendingTimer=true sinceArmedMs=28720049
06:03:46  arm delayMs=12600000
```

Between those two lines there is nothing. No `FIRED`, no `lock()`, no `boot`.

**The lock never ran.** `lock()` sets `state` to `"locked"` and `lockTimer` to
`null` (`session.ts:218`), and the first interaction of the morning found
`state=unlocked` with `pendingTimer=true`. The two halves say the same thing from
opposite directions: the timer was still sitting there unfired, and the keys were
still in memory.

**It was four and a half hours overdue.** `sinceArmedMs=28720049` is seven hours
fifty-eight minutes against a 210-minute deadline, so the lock was 4 h 28 m past
due and still had not happened when the popup interrupted it.

Firefox held PID 27581 across the whole night, so no restart took the timer with
it — `Session.init` would have locked on the next start and the vault would never
have been at risk. The background page lived, the handle lived, and `setTimeout`
did not run.

**This supersedes the reading of 2026-08-26.** "The worst case — the timer gone
and the vault sitting unlocked in a pocket — does not happen" was an artefact of
a fifteen-minute window. Over a night it is precisely what happens, and the
add-on's one defence against a lost phone was absent for eight hours.

One limit on the claim, stated so it is not read as more than it is: whether the
timer would have fired shortly after waking cannot be known from this run,
because the popup's own `touch` cleared and re-armed it some fifty milliseconds
into the process being awake. It does not change the decision. A lock that waits
for the user to come back is not an idle lock.

**`browser.alarms` is therefore no longer conditional on a measurement.** It is
the fix, it needs the `alarms` permission, and it is the first item of
`docs/BACKLOG.md`. The rig that produced this is on branch `debug/f4-idle-lock`;
the run's parameters and the reading procedure are in
`~/f4-night-2026-08-27/RUNSHEET.md`, outside the repository.

**Fixed, 2026-08-28 — by removing the dependency on a timer rather than by
replacing it.** `browser.alarms` was the backlog's assumed fix, and it was
dropped: Gecko implements alarms with its own timers inside the Firefox process
rather than through Android's `AlarmManager`, so a frozen process freezes those
too, and adopting it on the strength of the specification's stated intent would
have repeated the mistake this very run exposed.

The lock is now a deadline. `Session` records the wall-clock time at which it
expires, and four call sites settle it. `Controller.require()` — which the
code already calls the unlocked-vault guard, and through which every path that
hands out vault items passes — settles it before it tests the state. `status()`
does the same, so a panel never opens onto an unlocked-looking vault whose
actions then fail. `matchesFor()` needs its own, because it reads the state
directly and returns on two of its three paths before the guard is reached;
that third site was found in review rather than in design, and without it the
first badge query after a device woke past its deadline would have thrown
instead of answering "locked", leaving the page with no badge at all in
precisely the case this work exists for. And `syncAttempt()` needs its own too,
found by the whole-branch review after `matchesFor()` had already been fixed
for the identical mistake — the same convention missed twice inside one
branch. A timer has to run in order to protect anything; a deadline only has
to be read, and it is read at the moment the process thaws because somebody is
using the phone.

`setTimeout` stays, demoted: it zeroes the keys promptly on a device that is
awake, and is no longer what stands between a lost phone and the vault. No
permission was added, so `docs/AMO-SUBMISSION.md` is unaffected.

The test that pins it advances the system clock without advancing timers — the
frozen process exactly, and the reason none of the 626 tests standing on the
night of this run had caught it. Design in
`docs/superpowers/specs/2026-08-28-idle-lock-deadline-design.md`.

### F-5 — An open popup goes on showing the vault after the vault has locked

Found 2026-08-26 while measuring H2, and only because the popup happened to be
left open. The idle timer fired and `lock()` ran — both carry their own beacon,
so this is not inferred:

```
18:05:52  FIRED lateByMs=58692
18:05:52  lock() state=unlocked
```

The panel on screen still showed the entry list. Closing and reopening it gave
the PIN pad, which confirms the session really was locked and the panel was
simply stale.

**Why it happens.** Nothing tells the popup. There is no `runtime.sendMessage`
to it, no port, and no listener in `src/popup/popup.ts` — the `onLock` at
`popup.ts:580` is the settings screen's own Lock button, not a subscription. The
popup is a snapshot that is redrawn only when something routes it. `Session`'s
`onLock` hook reaches the Controller, which clears `items`; the message stops
there.

**What is exposed, and what is not.** `summarize` is a whitelist
(`controller.ts:67-78`), and it holds: passwords never cross to the popup, and a
tap to fill now goes through `require()` and fails with `LockedError`. What
remains readable is the **entry names and usernames** — the account list.

**Why it matters more than it first looks.** This is precisely the idle-lock
scenario. A user opens the popup, is distracted, puts the phone down; that is how
a fifteen-minute timeout gets reached in the first place. The one case the
feature exists for is the case where the panel is most likely still open.

It also makes C3's own reading fragile: the checklist confirms the lock by
opening the popup, and opening it is exactly what hides this.

**Fixed and verified.** The popup opens a port; the background keeps the ones
that belong to it and posts on every lock, and the popup re-routes. A port rather
than a broadcast `sendMessage`, which rejects with "no receiving end" whenever no
popup is open — almost always — and never learns that a popup has gone away.
`Controller.onLocked` hangs off the `session.onLock` hook, where every lock path
already converges.

Confirmed on the device 2026-08-26: unlocked at 18:21:55, popup left open and
untouched, and the panel had changed itself to the PIN pad by 18:37. Three tests,
all watched failing first — the panel stops showing entries, it shows the PIN pad,
and the controller reports every lock path. A fourth pins the port's sender check,
which is the whole of what keeps this channel to this extension's own popup.

`tests/build-classic-scripts.test.ts` caught the new load-time dependency on
`runtime.onConnect` — the background threw on load in its minimal sandbox, which
is what that guard is for. Its sandbox now provides `onConnect`, following its own
note about keeping up with the globals Firefox really supplies, and asserts the
subscription happens.

C3's reading is no longer fragile either: an open panel now shows the lock too,
so the checklist no longer depends on closing the popup to see the truth.

## Where this run stands

22 of 25 passed, **nothing failing**, **2 blocked (A1 A2, see F-3)**,
1 not applicable (A3), nothing open. D7 counts as one item here;
its three parts are all pass. The throwaway account is gone: everything that
needed a working vault is done, and only the first-run path remains.

That total is lower than the one this log carried on 2026-08-25, which read "14 of
25 passed, 11 remain". Both halves of that were wrong: 15 items were open at the
time, so 10 had passed, not 14. The error was arithmetic, not a misread result —
no item's outcome changed. Counts below are derived from the marks rather than
incremented by hand:

```
passed  (22):  C1 C2 C3 C4 C5 · D1 D2 D3 D4 D5 D6 D7 · E1 E2 E3 · F1 F2 · B1 B2 B3 B4 B5
failed   (0):  --
blocked  (2):  A1 A2
n/a      (1):  A3
open     (0):  --
```

The order was rearranged once, deliberately, and the reason should survive: the
device already carried **an account from an earlier test session**, and that
account is a throwaway. So everything needing a working vault was pulled forward
onto it (C1, C2, D1–D7, E1–E3), and the destructive items (C4, C5, then F) are
queued to run on it too. Only after F does the fresh setup happen — which is the
only way to reach A and B, since those test the first-run path itself.

```
done:  B1 B2 B3 B4 B5 · C1 C2 C4(!) C5 · D1 D2 D3 D4 D5 D6 D7 · E1 E2 E3 · F1 F2
next:  --  the checklist is finished; F-2 and F-4 are the open defects
```

The remaining items are deliberately being run on the build from 90ee4d6, the
same one the first 14 were run against. Fixing F-2 mid-run would split the run
across two builds and put every earlier result in question, so the fix waits
until the checklist is finished — unless it turns out to need a device to verify,
in which case it is cheaper to fix, rebuild, and re-run C4 alone.

### Next action: the run is done; what is left is decisions

Every one of the 25 items has an outcome and nothing is failing. All three
defects this run found were fixed and every fix was confirmed on the device, not
only in the suite:

- **F-4** — `matchesFor` no longer extends the idle timer. C3 re-run passed with
  the login page reloaded and open throughout, which is the condition that broke
  the first run.
- **F-2** — the PIN pad re-renders its warning after every rejected attempt. C4
  re-run showed 3, 2, 1 in order beside "Incorrect PIN", then 0, then the refusal.

- **F-5** — an open popup is told when the vault locks, over a port the
  background posts on from the `session.onLock` hook. The panel changed itself to
  the PIN pad while left open and untouched.

All three are merged to `main`.

What remains is not verification work:

1. **F-3 is decided** (2026-08-27): the required grant stays, the dead per-host
   machinery is gone, and `docs/AMO-SUBMISSION.md` no longer contradicts itself.
   A1 and A2 are retired rather than unblocked. See the end of § F-3.
2. **H2 is measured over a night** (2026-08-27/28) and the answer is not a
   degree of lateness: over eight hours `setTimeout` never fired, and the vault
   stayed unlocked 4 h 28 m past its deadline. `browser.alarms` is no longer a
   contingency — it is the fix, and it heads `docs/BACKLOG.md`. See § F-4.
3. **The rest of `docs/BACKLOG.md`**, in its own order.

### Blocked on preparation

- **D3** is no longer blocked. Hunting for a real site whose credentials sit in
  the vault was the slow way round; the form is now served from the development
  machine next to the decoy page, and `docs/DEVELOPMENT.md` carries it in full
  along with the two commands that fetch React's UMD builds. It reports React's
  **state**, not the DOM, which is the only reading that can tell a real fill
  from a form that looks filled and submits empty. Verified against React 18.3.1
  in jsdom first: `setValue` moves the state, a naive assignment does not.
- **D5** still needs a throwaway vault entry with the URI `http://127.0.0.1:8000`
  (**including the port** — for IP hosts the matcher compares host *and* port).
  Create it in the web vault and sync. The same entry serves D3.

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
- **C3** is a real 15-minute wait with no interaction. Park it next to something
  else; any touch of the popup resets the timer.

### How to resume

The fresh setup is complete as of 2026-08-26: the device holds a signed-in
account with the vault unlocked, reached through the real first-run path (B1–B5).
The panel will open on the vault list, or on the PIN pad once C3's idle timer has
run. This is no longer the throwaway account from the earlier session — treat the
device as holding live credentials, and sign out when the run is finished.

The run began against the build from 90ee4d6. It no longer runs on that build: the
F-4, F-2 and F-5 fixes were made after the checklist finished, each re-verified
on the device, and all three are merged to `main`. Rebuild before anything else.

```bash
export PATH="$HOME/Android/Sdk/platform-tools:$PATH"
adb devices                       # expect: RFCN80EJ05Y  device  (not unauthorized)
npm run build
npm run start:android -- --android-device=RFCN80EJ05Y
```

Only if D3 or D5 need re-running — neither is outstanding, both passed:

```bash
# from a directory holding decoy.html and react-login.html (both in DEVELOPMENT.md)
npm pack react@18 react-dom@18 && tar xzf react-18.3.1.tgz && tar xzf react-dom-18.3.1.tgz
cp package/umd/react.development.js react.js
cp package/umd/react-dom.development.js react-dom.js
python3 -m http.server 8000 --bind 127.0.0.1
adb reverse tcp:8000 tcp:8000     # does not survive a device reconnect
```

Three things that cost time and need not cost it again:

- **The popup is opened from the ⋮ menu by tapping the extension's own entry.**
  Settings → Extensions → the add-on leads to Fenix's management page (Enabled /
  Run in private mode / Permissions / Remove), which says nothing about the vault.
- **`web-ext` does not reload on Android**, whatever it prints. After any source
  change, stop it and start it again, or the device keeps running the old build
  and every conclusion drawn from it is about code that is no longer in the tree.
- **The counts in this log were wrong once already.** Derive them from the marks
  (`grep -c '^\s*- \[x\]'` and friends), never by incrementing the previous
  number.

### Nothing in this log is outstanding

F-2, F-4 and F-5 are fixed, confirmed on the device, and merged. F-3 was decided
on 2026-08-27 in favour of the required grant, and everything that decision
implied for the code and the AMO text was done with it — see the end of § F-3.
A1 and A2 are retired, not pending.

What is left belongs to `docs/BACKLOG.md`, and none of it is verification work.
