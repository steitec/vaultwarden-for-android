# Getting a signed build onto release Firefox for Android, privately

This is the step-by-step route from this source tree to a working add-on on
**Firefox for Android (release channel)**, signed by Mozilla, without publishing
anything to the world.

"Official" here means exactly one thing: **the XPI carries Mozilla's signature.**
That is what release Firefox requires before it will install anything, and it is
a separate matter from being *listed* on addons.mozilla.org. An add-on can be
signed and still be visible to nobody but you.

## The three routes, and why this one

| Route | Public? | Works on release Firefox for Android? |
| --- | --- | --- |
| **Unlisted (self-distribution)** — sign only, host the XPI yourself | no | **yes**, install from file |
| Listed, visible | yes, fully public | yes, install from AMO |
| Listed, then set to "invisible" | no | **no** — invisible disables the AMO download |

Take the first row. The third row looks like the private option and is not one:
AMO has no "we host it, but hidden" mode. Mozilla's answer to "hosted but hidden
from search" is self-distribution — set the add-on invisible and the download
button goes away with it, so there is nothing left to install from.

> **Two claims elsewhere in this repo used to say otherwise. Both were corrected
> on 2026-08-25**, and are recorded here so a stale copy is recognisable.
>
> `docs/AMO-SUBMISSION.md` ("Listing settings") said an unlisted add-on cannot be
> installed on release Firefox for Android, and that listed-then-invisible was
> the only private route. Both halves were wrong in opposite directions:
> invisible is *not* installable, and unlisted *is*.
>
> `docs/DEVELOPMENT.md` ("Running on a phone") said release Firefox for Android
> cannot sideload an extension. That holds for what `web-ext run` does — pushing
> an unsigned temporary build over adb, which really is Nightly-only. It does not
> hold for installing a **signed** XPI from a file, which release Firefox has
> supported since version 122 (Jan 2024) behind the debug menu.
>
> Mozilla documents the Android file-install flow itself, for exactly this case:
> <https://extensionworkshop.com/documentation/publish/install-self-distributed/>

## Before you start

- An account on <https://addons.mozilla.org/> (a normal Firefox account works).
- Node.js 22.12.0 and `npm ci` already run, per `docs/DEVELOPMENT.md`.
- `adb` on the machine, if you want the tidy way to move the file to the phone.
- Firefox for Android **122 or newer** on the phone. Any current release is fine.
  This is the release app, `org.mozilla.firefox` — not Nightly.

---

## Step 1 — Get AMO API credentials

1. Sign in at <https://addons.mozilla.org/developers/>.
2. Open **Manage API Keys** (under your account menu, or
   <https://addons.mozilla.org/developers/addon/api/key/>).
3. Accept the developer agreement if you have not already.
4. Generate credentials. You get two values: a **JWT issuer** (looks like
   `user:12345678:123`) and a **JWT secret** (a long hex string).

The secret is shown **once**. Copy it now.

Put both in the environment rather than in a file in this repo — `web-ext` reads
`WEB_EXT_*` variables for every option it has:

```bash
export WEB_EXT_API_KEY='user:12345678:123'
export WEB_EXT_API_SECRET='<the long hex secret>'
```

Never commit these. A leaked pair lets anyone publish under your add-on ID.

## Step 2 — Check the manifest before spending a version number

Signing consumes the version: AMO refuses a second upload of a version it has
already seen, in either channel. So confirm these in `src/manifest.json` first.

- **The add-on has an ID.** It does:
  `browser_specific_settings.gecko.id` is `vaultwarden-android@steitec.net`.
  Self-distribution requires one, and this ID is what ties every future update to
  the same installed add-on. Do not change it once something is installed.
- **`version` is one you have not signed before.** It is `0.1.0` on a fresh tree.
  Version numbers are unique across *both* AMO channels, so a number spent on a
  private unlisted build can never be reused for a public listed one. Stay in
  `0.x` while testing privately and keep `1.0.0` for the public launch.
- **`gecko_android` is present.** It is, at `strict_min_version: 121.0`.

Note on that 121: the *install-from-file* flow needs Firefox 122, so 121 promises
one version more compatibility than you can actually deliver by this route. It is
harmless for you — your phone is far past both — and raising it to `122.0` means
touching `tests/manifest.test.ts`, which asserts the exact string. Left alone
deliberately; decide it when you next touch the manifest.

## Step 3 — Build, lint, and make the source archive

```bash
npm ci
npm test
npm run build
npm run lint:ext
```

`lint:ext` must report **0 errors, 0 warnings, 0 notices**. Anything else, stop
and understand it — see `docs/AMO-SUBMISSION.md`.

Then the source archive, from the exact commit you are signing:

```bash
git archive --format=zip -o source.zip HEAD
```

Unlisted submissions go through automated review, which does not normally ask for
source. Attach it anyway: the shipped JavaScript is Rollup output, AMO reviewers
*can* pull an unlisted add-on for human review, and attaching source up front
costs nothing and removes the one thing that would otherwise stall you.

`source.zip` is not in `.gitignore`. Do not commit it.

## Step 4 — Sign it, unlisted

```bash
npx web-ext sign -s dist --channel=unlisted --upload-source-code=source.zip
```

What happens: `web-ext` uploads `dist/`, AMO runs the automated validator, and —
if it passes — signs the package and sends it back. Usually a few minutes; it can
be longer when AMO is busy. The command waits and then prints where it put the
file:

```
web-ext-artifacts/vaultwarden_for_android-0.1.0.xpi
```

That `.xpi` is the signed add-on. It is the deliverable of this whole document.

`web-ext-artifacts/` is gitignored, so the file is safely outside version
control — but it is also *not backed up*. Copy it somewhere you keep things if
you want to reinstall later without re-signing.

**`--channel=unlisted` publishes nothing.** No listing page, no search entry, no
public URL. This is why it is safe to run, and it is the one meaningful
difference from `--channel=listed`, which submits a version for human review and
cannot be taken back.

## Step 5 — Move the XPI to the phone

Cleanest, with the phone connected by USB and debugging on:

```bash
adb push web-ext-artifacts/vaultwarden_for_android-0.1.0.xpi /sdcard/Download/
```

Anything else that lands the file in the phone's storage works too — a USB file
transfer, a self-hosted download, a messenger to yourself. It has to be a **local
file**: release Firefox for Android will not install an XPI straight from a web
URL, it will only download it. That is fine — download it, then continue below.

## Step 6 — Install it on release Firefox for Android

The option is hidden behind the debug menu. It is not a beta or Nightly feature;
it is simply not shown until you unlock it.

1. Open **Firefox** (the release app).
2. **⋮ → Settings → About Firefox**.
3. Tap the **Firefox logo five times**, quickly. A toast confirms the debug menu
   is on.
4. Go back to **Settings**. In the **Advanced** section, just under *Add-ons*,
   there is now **Install add-on from file** (some versions word it *Install
   extension from file*).
5. Tap it. Android's file picker opens. Navigate to **Downloads** and pick
   `vaultwarden_for_android-0.1.0.xpi`.
6. Firefox shows the permission prompt — access to data for all websites, per the
   manifest's `https://*/*` content script. Confirm.

If the file picker does not show the file, open it through **Downloads** in the
picker's side menu rather than "Recent"; some Android file pickers hide unknown
extensions in the recents view.

## Step 7 — Verify it is really installed and really signed

- **⋮ → Extensions** lists *Vaultwarden for Android*.
- The add-on's popup opens from the **⋮ menu**, not from a toolbar button —
  Firefox for Android has no extension toolbar.
- An unsigned or wrongly signed file could never have got this far: release
  Firefox rejects it at install time with a "corrupt" error. Reaching step 7 *is*
  the signature check.

Then walk the manual checklist in `docs/DEVELOPMENT.md` — first-run setup, the
host permission prompt, unlock, autofill. Those are the parts no test suite
covers, and they run against your real server.

---

## Updating later

A self-distributed add-on does **not** update itself. Two options:

**Manual, and adequate for one user.** Bump `version` in `src/manifest.json`,
repeat steps 3–6. Installing a newer version over an older one keeps the
extension's storage — same ID, same `browser.storage.local` — so your vault
setup, PIN and cached sync survive. Downgrades are refused.

**Automatic, if manual reinstalls get tedious.** Add an `update_url` to
`browser_specific_settings.gecko` pointing at a JSON file you host over HTTPS —
you already run a server. Firefox polls it and installs new versions on its own:

```json
{
  "addons": {
    "vaultwarden-android@steitec.net": {
      "updates": [
        { "version": "0.2.0",
          "update_link": "https://your.host/vaultwarden/vaultwarden-0.2.0.xpi" }
      ]
    }
  }
}
```

The `update_link` must be HTTPS and must serve the **signed** XPI. One catch
worth knowing before you commit to this: an add-on carrying `update_url` cannot
be submitted to the listed channel. If going public is ever plausible, stay
manual.

## Going public later

Nothing here has to be undone first, and none of it is throwaway work. **One
add-on on AMO can carry versions in both channels**, chosen per version, and
Mozilla names "a self-distributed pre-release channel" as an intended use of
exactly that. Private testing now and a public listing later is the supported
shape, not a workaround:

```
0.1.0  unlisted   only on your phone
0.2.0  unlisted   ...
1.0.0  listed     public, reviewed, on the listing page
```

Same add-on entry, same id, one Developer Hub page for both. The unlisted
versions stay invisible after the listed one appears — publishing 1.0.0 does not
retroactively expose 0.1.0 to anyone.

Three rules follow from that, and all three are cheap now and expensive later:

1. **Version numbers are unique across both channels, and a version's channel is
   permanent.** Spend `0.x` privately; keep `1.0.0` for the launch.
2. **Do not add `update_url`** (see *Updating later*). It buys automatic updates
   for one user and costs the ability to submit listed at all.
3. **Keep `docs/AMO-SUBMISSION.md` true as the code changes.** The reviewer notes
   there are the long pole of a listed submission, and they are already written.

When the time comes, `docs/AMO-SUBMISSION.md` is the document — reviewer notes,
source-code submission, build instructions, the icon rationale. The difference is
only what listed adds: human review, a public listing page, and a version number
that cannot be taken back.

**The gate before that step** is not a signing question. It is the manual
verification checklist in `docs/DEVELOPMENT.md` — the host-permission prompt,
first-run setup against a real server, the PIN lockout, the off-screen decoy
field. Nothing in the automated suites covers those, and they are what would
otherwise fail in a stranger's hands.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `web-ext sign` fails with 401 | Wrong or expired API credentials. Regenerate; the secret is shown once. |
| AMO rejects the upload: version already exists | That version was signed before. Bump `version` in `src/manifest.json` and rebuild. |
| No **Install add-on from file** in Settings | The five taps did not register, or Firefox is older than 122. Retry the taps faster; check ⋮ → Settings → About Firefox for the version. |
| Firefox says the file is corrupt | The XPI is unsigned — most likely `web-ext build` output rather than `web-ext sign` output. Only the file from step 4 installs. |
| Installed, but no entry under Extensions | An older Firefox that downloaded rather than installed. Check the version. |
| Add-on installs, but sign-in fails at the permission prompt | Not a signing problem — see the host-permission section of the manual checklist in `docs/DEVELOPMENT.md`. |

## Sources

- Installing self-distributed extensions (the Android file-install flow):
  <https://extensionworkshop.com/documentation/publish/install-self-distributed/>
- Distributing an add-on yourself:
  <https://extensionworkshop.com/documentation/publish/self-distribution/>
- Signing and distribution overview:
  <https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/>
- Mixing listed and unlisted versions of one add-on:
  <https://blog.mozilla.org/addons/2017/01/26/mixing-listed-and-unlisted-on-amo/>
