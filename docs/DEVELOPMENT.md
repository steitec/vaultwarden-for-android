# Development

## Prerequisites

- Node.js **v22.12.0** (the version this project is developed and built on).
- `npm ci` to install exactly the lockfile's dependency tree.
- Docker, but only for `npm run test:integration`.

## Build

```bash
npm run build
```

Every entry point under `src/` is bundled into its own self-contained classic
script and the static assets are copied beside them. The output is `dist/`, and
`dist/` is what both `web-ext lint` and `web-ext build` are pointed at:

```
dist/manifest.json
dist/background.js
dist/popup.js      dist/popup.html   dist/popup.css
dist/autofill.js
dist/icon-48.png   dist/icon-96.png
```

`dist/` is gitignored and is deleted and rebuilt from scratch on every run.

## Test suites

```bash
npm test                  # typecheck + unit tests. No Docker, no network.
npm run test:integration  # starts a pinned Vaultwarden container, then tears it down
npm run lint:ext          # web-ext lint against dist/ (build first)
```

The unit suite never touches the network and never talks to a real server. The
integration suite talks only to the container it starts on localhost; it must
never be pointed at a production vault.

## Icons

`src/icons/icon.svg` is the master. The two PNGs beside it are **generated from
it** and should never be edited directly:

```bash
for s in 48 96; do
  inkscape src/icons/icon.svg --export-type=png \
    --export-filename=/tmp/icon-$s.png -w $s -h $s
  magick /tmp/icon-$s.png -strip PNG32:src/icons/icon-$s.png
done
```

Inkscape is not a build dependency — the PNGs are committed, and `npm run build`
only copies them. Regenerating is a manual step after editing the SVG.

The design is a vault door with a dial and four handle grips. Two constraints
drove it, and both are recorded in comments inside the SVG:

- **It is deliberately not a shield.** Bitwarden's mark is a shield and
  Vaultwarden's is too. This is an unofficial third-party client and must not
  read as an official one — that is a listing risk, not just an aesthetic
  preference. The blue is likewise kept clear of Bitwarden's `#175DDC`.
- **48px is the size that constrains it**, because that is the Android toolbar.
  Nothing is thinner than 4 SVG units (2 device pixels at 48px), there is no
  text, and the white dial is heavy rather than a thin outline because white is
  what carries the icon on a dark toolbar.

If you change it, check it at 48px *and* smaller, on white and on dark. An
earlier revision with the spokes stopping at the rim rendered as a lifebuoy;
that is only visible once it is rasterised at real size.

## Running on a phone

On-device development uses Firefox Nightly, because `web-ext run` installs an
unsigned build over adb and Nightly is the only channel that accepts one.

That is narrower than "release Firefox cannot take an extension". Release will
install a **signed** XPI chosen from local storage, and that is how the add-on is
meant to reach your own phone for real use — `docs/PRIVATE-INSTALL.md` covers it.
It is useless as a development loop, though: every change would have to go
through AMO's signing service first. Hence Nightly for everything below.

1. Install Firefox Nightly on the phone from Google Play.
2. In Nightly: Settings → About Firefox → tap the logo five times to enable the
   developer menu. Then Settings → Remote debugging via USB → on.
3. On the phone, in the **Android** settings: Developer options → USB debugging
   → on. This is a separate switch from Nightly's own, and both are required.
4. Connect the phone by USB and accept the "Allow USB debugging?" prompt.
5. Verify adb sees it:

   ```bash
   adb devices
   ```

   `adb` ships with Android Studio at
   `~/Android/Sdk/platform-tools/adb` and is often not on `PATH`; `web-ext`
   shells out to it and will fail with "adb: command not found" if it is
   missing. Either add that directory to `PATH` or pass `--adb-bin=<path>`.

   A device listed as **`unauthorized`** rather than `device` means the prompt
   in step 4 was never accepted. Toggling USB debugging off and on again
   re-issues it.

6. Build and run:

   ```bash
   npm run build
   npm run start:android -- --android-device=<serial from adb devices>
   ```

`web-ext` installs the extension into Nightly's main profile.

**It does not reload on Android.** It prints "The extension will reload if any
source file changes", and on a rebuild it prints "Building web extension from
…" — but the device keeps running the build it was given at startup. After every
change, stop `web-ext` and start it again.

This is worth being strict about, because the failure is silent: the phone shows
old behaviour and every conclusion drawn from it is about code that is no longer
in the tree. What is actually installed can be checked, which is the fastest way
out of that hole:

```bash
adb pull "$(adb shell 'ls -d /data/local/tmp/web-ext-artifacts-*' | tr -d '\r' | tail -1)/vaultwarden_for_android-0.1.0.xpi" /tmp/on-device.xpi
unzip -o /tmp/on-device.xpi -d /tmp/on-device
```

Note also that Gecko does **not** forward an extension's `console.log` to
`adb logcat`; only Fenix's own Java-side logging appears there. Reading the
extension's console means `about:debugging` on desktop Firefox.

**On the two Firefox packages.** A phone with both Nightly and release Firefox
installed makes `web-ext` stop and ask which to use. The mapping is not
guessable, so:

| Package | Channel | Takes `web-ext run` |
| --- | --- | --- |
| `org.mozilla.fenix` | Nightly (version ends `a1`) | yes |
| `org.mozilla.firefox` | Release | **no** — signed XPI from a file only |

"Fenix" was the codename for the rewritten Firefox for Android; Nightly kept it
as its package id while release took `org.mozilla.firefox`. So the id that looks
like an old codename is the current Nightly. `--firefox-apk=org.mozilla.fenix`
is baked into the `start:android` script for that reason. Confirm with:

```bash
adb shell dumpsys package org.mozilla.fenix | grep -m1 versionName
```

## The autofill badge

`src/content/autofill.ts` is a **declared** content script, registered in the
manifest for `https://*/*` plus the two http loopback hosts. It runs on every
such page at `document_idle`, looks for a visible password field, and only then
asks the background page whether anything matches. A page with no login form
produces no message.

It holds no credentials. It receives entry ids and names, draws a badge in a
closed shadow root, and learns a password only in response to the user's tap —
which is what makes a script on every https page an acceptable trade. The
reasoning is in `docs/superpowers/specs/2026-08-25-inline-autofill-badge-design.md`,
§9.

Two consequences worth knowing before they surprise you:

- **A locked vault shows a badge on every login page**, matching entry or not.
  A locked vault cannot be consulted, and the alternative — an unencrypted
  index of the vault's domains — is worse. Design §7.
- **`http://[::1]` gets no badge.** It is a fillable origin but not an
  expressible match pattern, so loopback-over-IPv6 keeps the popup path only.
  Design §5.3.

`browserAction.openPopup()` does not work on Firefox for Android (checked on
Nightly 156.0a1). Tapping the badge on a locked vault therefore records the
intent and the user opens the add-on themselves; the fill still happens after
the PIN, with no second tap. The call is kept for a future Firefox that
implements it.

## Debugging

Open `about:debugging` in **desktop** Firefox, choose the connected phone under
"Setup", and inspect the background page or the popup from there. This is the
only way to see console output from the extension running on Android.

## Manual verification checklist

Run this against a real Vaultwarden server on a real phone. Everything below is
here because the automated suites **cannot** cover it — either the API is
stubbed out in tests, or the behaviour only exists inside a real layout or
permission engine. A failure in any of these is a shipping blocker, so each item
says what it would mean.

### Host permission — the highest-risk item on this list

- [ ] **Tapping "Sign in" raises Firefox's own permission prompt, naming the
      configured server host, and accepting it lets setup continue.**

  Firefox honours `permissions.request()` only while a user-input handler is
  still on the JS stack, and that gesture does **not** survive a
  `runtime.sendMessage` hop. This has already broken once: the background page
  was doing the asking, which throws "permissions.request may only be called
  from a user input handler" for every real user (fixed in `f8be844`; the popup
  took over the asking in Task 15). The unit suite stubs `browser.permissions`
  wholesale, so it can never catch a regression here — this checklist item is
  the only test this code path will ever get. If the prompt does not appear, or
  appears and setup still fails, nobody can complete first-run setup at all.

- [ ] **Denying the prompt produces a readable explanation, not a stack trace,
      and the sign-in form stays on screen with the entered values.**

- [ ] **A server on a non-standard port** (e.g. `https://vault.example.net:8443`),
      if one is available.

  The requested match pattern deliberately drops the port, because Firefox match
  patterns have no port component (bug 1362809) and `https://host:8443/*` is not
  a narrower pattern but an invalid one that `permissions.request()` rejects
  outright. That is correct per the documentation and has never been seen
  against a real prompt. If it is wrong, self-hosted servers on non-standard
  ports are simply unusable.

### Setup and sign-in

- [ ] **`Controller.setup` completes end to end against a real https server** —
      server URL, email, master password, and a PIN of six or more characters.

  This exact path has never run outside stubs. The integration container speaks
  plain http and `setup()` hard-requires `https:` by design, so the integration
  suite exercises the API layer but not `setup()` itself.

- [ ] Entering an `http://` server address is refused with a message telling the
      user to use `https://`.
- [ ] The two-factor prompt appears when the account requires it, lists the
      providers the server actually offers, and a correct code completes sign-in.
- [ ] A wrong master password is reported as a wrong password, not as a
      two-factor challenge.
- [ ] The vault lists entries immediately after setup.

### Lock, unlock, and the PIN lockout

- [ ] "Lock" in the settings row returns to the PIN pad.
- [ ] Unlocking with the correct PIN restores the list.
- [ ] The vault locks itself after **15 minutes** of no interaction (the default
      `lockTimeoutMinutes`), and reopening the popup then shows the PIN pad.
- [ ] **Wrong-PIN counting matches the screen.** Submit wrong PINs one at a time
      and watch the counter:

  | Wrong PINs submitted so far | Screen says | What the next submit does |
  | --- | --- | --- |
  | 0 | (no warning) | attempts the PIN |
  | 1 | (no warning) | attempts the PIN |
  | 2 | 3 attempts remaining | attempts the PIN |
  | 3 | 2 attempts remaining | attempts the PIN |
  | 4 | 1 attempt remaining | attempts the PIN |
  | 5 | 0 attempts remaining | **refuses without trying, and drops the key** |

  Five wrong PINs are each actually tried. It is the **sixth** submission that is
  refused outright and wipes the stored wrapped key. The attempt is charged
  *before* it is tried (so killing the browser mid-guess cannot buy a free one),
  and exhaustion is `failedPinAttempts > MAX_PIN_ATTEMPTS` with
  `MAX_PIN_ATTEMPTS = 5` — see `src/session/session.ts`. The warning only starts
  showing at 3 remaining, which is why the first two rows above are blank.
  A correct PIN at any point resets the counter to 5.

- [ ] **After the key is dropped, the popup shows the re-authentication form,
      not a dead PIN pad**, and both the server URL and the email are already
      filled in. Signing in with the master password restores the vault, with the
      same entries as before.

  This routing is new in Task 15. Getting it wrong strands the user on a screen
  that can never succeed, with no visible way back.

### Autofill

- [ ] Open a login page for a site that is in the vault; the popup lists the
      matching entries **first**, above the rest.
- [ ] Tapping an entry fills both the username and the password field, and the
      popup closes.
- [ ] Filling works on a React-based login form (the value is set through the
      native setter and `input`/`change` are dispatched — a framework that
      ignores this leaves the form looking filled but submitting empty).
- [ ] Tapping an entry whose URIs do not match the open page is refused with an
      explanation rather than silently filling.
- [ ] **Autofill on a page carrying an off-screen decoy password field: the
      visible field receives the credential and the decoy stays empty.**

  `isRenderedOffScreen` in `src/content/autofill.ts` — the geometry half of the
  visibility check — **has never run in a real layout engine**. jsdom performs no
  layout and reports an all-zero rect for every element, so the code detects that
  and skips the geometry layer entirely under test; the unit suite therefore
  exercises only the CSSOM layer. A real browser is the only place this half of
  the defence is ever executed, and a decoy field receiving the real password is
  exactly the class of bug this project has already shipped once.

  **How to run it.** A `data:text/html,...` URL in the address bar will *not*
  work: `Controller.fill` refuses any page whose origin is not https (loopback
  http excepted), and a `data:` URL fails that check before anything is
  injected. Serve the page instead, from somewhere the fill path accepts:

  - simplest on-device option — run a local server on the phone (Termux:
    `python3 -m http.server 8000`), save the file below as `decoy.html`, browse
    to `http://127.0.0.1:8000/decoy.html`, and add a throwaway vault entry whose
    URI is `http://127.0.0.1:8000`. Loopback http is explicitly allowed by
    `isFillableOrigin`, and for IP/single-label hosts the URI matcher compares
    host **including port**, so the port must be in the entry's URI.
  - or host it on any https origin you control and give the throwaway entry that
    URI.

  The decoy is deliberately placed **before** the visible field in document
  order. `findLoginFields` takes the first *usable* password input, so a decoy
  placed after the real field would be skipped for the wrong reason and the test
  would pass even with the visibility check removed entirely.

  ```html
  <!doctype html>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>decoy test</title>
  <style>body { font: 16px system-ui; padding: 1rem } input { display: block; margin: .5rem 0 1rem }</style>
  <form onsubmit="return false">
    <!-- decoy FIRST: this is the one a broken visibility check would fill -->
    <input id="decoy-user" type="text" name="user2" style="position:absolute; left:-9999px">
    <input id="decoy-pass" type="password" name="pass2" style="position:absolute; left:-9999px">

    <label for="visible-user">Username</label>
    <input id="visible-user" type="text" name="username" autocomplete="username">
    <label for="visible-pass">Password</label>
    <input id="visible-pass" type="password" name="password" autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>

  <p><button id="check" type="button">check</button></p>
  <pre id="out">not checked yet</pre>

  <script>
    document.getElementById("check").addEventListener("click", function () {
      var f = function (id) { return document.getElementById(id).value ? "FILLED" : "empty"; };
      document.getElementById("out").textContent =
        "visible-user: " + f("visible-user") + "\n" +
        "visible-pass: " + f("visible-pass") + "\n" +
        "decoy-user:   " + f("decoy-user") + "\n" +
        "decoy-pass:   " + f("decoy-pass");
    });
  </script>
  ```

  **Pass condition:** after autofilling, tapping "check" must report
  `visible-user: FILLED`, `visible-pass: FILLED`, `decoy-user: empty`,
  `decoy-pass: empty`. Anything reported as FILLED on a decoy line is a failure,
  and so is a visible line reading `empty` — that means the decoy was chosen
  instead and the real form was left blank.

### The badge — added 2026-08-25, after the list above shipped without it

The badge is the newest thing here and the first thing a user meets, and neither
item below was on this list until it was noticed missing during a run. Both are
device-only: the unit suite covers the message plumbing, not the rendering or the
gesture.

- [ ] **Unlocked vault, matching entry: a badge appears in the page's password
      field, and tapping it fills both fields without the popup being opened.**

- [ ] **Locked vault: the badge appears, tapping it opens nothing by itself, and
      the fill happens after the PIN with no second tap.**

  `browserAction.openPopup()` does not work on Firefox for Android (checked on
  Nightly 156.0a1), so the badge cannot raise the unlock screen. It records the
  intent — tab id, origin, timestamp, in memory only — and the user opens the
  add-on. Everything past that point is the pending-fill path in
  `src/background/pending.ts`: well covered by unit tests, never once run on a
  device. If it is broken, the badge on a locked vault is a dead control — the
  user taps it, unlocks, and nothing happens, with no error to explain why.

  Confirm the two deliberate behaviours around it too, because both look like
  defects from the outside and will be reported as such:

  - while locked, the badge appears on **every** login page, matching entry or
    not (design §7 — a locked vault cannot be consulted, and the alternative is
    an unencrypted index of the vault's domains)
  - a tab that navigates to another origin between the tap and the unlock has
    its pending fill **discarded** rather than guessed at, as does a tap older
    than two minutes

### Offline and sync

- [ ] Turn off wifi and mobile data; the vault still unlocks and lists entries
      from the offline cache.
- [ ] Reconnect, tap "Sync now", and the "Last synced" line in the header updates
      to "just now".
- [ ] A failed sync (server unreachable) shows an error banner and leaves the
      existing list intact rather than blanking it.

### Sign out

- [ ] "Sign out" asks for confirmation first.
- [ ] **After confirming, reopening the popup shows the setup screen — not the
      unlock screen.**

  Locking only zeroes the in-memory keys. Sign-out is the only thing that removes
  `protectedUserKey`, `pinWrapped`, `wrappedRefreshToken` and the cipher cache
  from `browser.storage.local`, which is what makes an offline attack on the
  device possible. If the unlock screen comes back, the wipe did not happen and
  there is no way to get that material off the phone short of uninstalling.

> Not on this list: TOTP codes and copy-to-clipboard. The background page has a
> `totp` handler, but no UI calls it yet, so there is nothing for a tester to tap.

## Deferred to v2

Recorded here so they are not silently lost:

- item creation and editing
- save-password prompts
- Sends and attachments
- card and identity item types
- passkeys
- multiple accounts
- WebSocket push sync via `/notifications`
- a full public suffix list, if subdomain matching proves too coarse in practice
- a TOTP display in the popup (the background handler already exists)

### Signing and submission: designed, not built

There is no `sign` script yet. Building and submitting to AMO is still a manual
walk through the dashboard. The shape below was agreed on 2026-08-25 and is
recorded so it does not have to be re-argued:

```json
"package": "npm run build && npm run lint:ext && git archive --format=zip -o source.zip HEAD",
"sign":    "npm test && npm run package && web-ext sign -s dist --channel=listed --upload-source-code=source.zip"
```

**Two scripts, not one, and that is the whole point.** `web-ext sign
--channel=listed` uploads the build and submits that version for review. It is
outward-facing and cannot be taken back — a submitted version can later be
disabled, but the version number is spent at AMO either way. A single command
that does this as a side effect of "make me a build" is a trap. So `package` is
the harmless half (builds, lints, writes `source.zip`, touches no network) and
`sign` is the one command that actually sends something.

`--upload-source-code` means the source archive rides along with the
submission instead of being uploaded separately in the dashboard, which is what
the "Source code submission" section of `docs/AMO-SUBMISSION.md` currently
describes doing by hand.

Credentials come from the `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`
environment variables (AMO: *Tools → Manage API Keys*), never as `--api-key`
flags in `package.json` — flags land in shell history and in the process list
of every user on the machine. They belong nowhere in this repository.

`npm test` runs first. Twenty-five seconds against a version that cannot be
recalled is cheap insurance, not ceremony.

Two things to do when building it: add `source.zip` to `.gitignore`, where
`docs/AMO-SUBMISSION.md` currently only warns against committing it in prose;
and note that AMO rejects a version number it has already seen, so `version` in
**both** `package.json` and `src/manifest.json` has to be raised before each
submission.

Only `package` is meaningfully testable — it is deterministic and offline.
Testing `sign` against AMO would mean making a real submission.

## Known gaps in what already ships

Not features that were postponed — these are true of the current build. Each
one will eventually be somebody's bug report, so they are written down with
enough detail to act on rather than as a line to rediscover.

### A `<select>` username field is never filled

`USERNAME_SELECTOR` in `src/content/autofill.ts` matches
`input[type="text"]`, `input[type="email"]`, `input[type="tel"]` and
`input:not([type])`. A `<select>` is not among them.

The concrete trigger is a FRITZ!Box with FRITZ!Benutzer configured: its login
page then renders a user **dropdown** above the password field instead of a
text input. `findLoginFields` returns `username: null`, `fillFields` skips the
field, and the result is a filled password beside a dropdown still sitting on
whatever it defaulted to. It looks like a partial success, which is worse than
an obvious failure — the user submits and gets "wrong password".

A fix touches two places, and the second is the one that is easy to get wrong:

- `findLoginFields` — widen the candidate query. The "last candidate preceding
  the password field" logic uses `compareDocumentPosition`, which works on any
  `Element`, so that half needs no change. The return type does: it is
  `HTMLInputElement | null` today.
- `setValue` — a `<select>` is not an `HTMLInputElement`. The native-setter
  trick there exists specifically to defeat React's and Vue's shadowed `value`
  property on inputs and does not transfer. A select needs its `value` set and
  a `change` event, and setting a value no `<option>` carries silently does
  nothing — that case has to be detected rather than reported as filled.

jsdom covers all of this; no device work is needed to build it.

### `http://[::1]` gets no badge

A fillable origin (`isFillableOrigin` allows it) that cannot be expressed as a
manifest match pattern, so the content script is never registered there. Such
pages keep the popup path, which still works.

This one has no fix inside Manifest V2 — it is a limitation of match patterns,
not an oversight. Recorded so nobody spends an afternoon on it. See the
2026-08-25 design's §5.3.

### The AMO reviewer note has never been through a review

`docs/AMO-SUBMISSION.md` was rewritten when the badge landed, because its
previous claims — no content script, exactly one host permission — became
false. The new note makes specific, checkable claims about how the content
script behaves.

Before submitting: re-read it against the code rather than trusting that it
was accurate when written, and expect more scrutiny than the old `activeTab`
posture would have drawn. All-sites host access is ordinary for a password
manager, and both Bitwarden and 1Password match all URLs in their content
scripts, but it is the kind of thing a reviewer asks about.
