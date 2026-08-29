# AMO submission

Everything here is done by the repository owner. Nothing in this file should be
run by an automated agent — the build steps are safe, but the submission itself
is a publishing action.

## Build the package

```bash
npm ci
npm test
npm run build
npm run lint:ext
npx web-ext build -s dist --overwrite-dest
```

The artifact lands in `web-ext-artifacts/vaultwarden_for_android-<version>.zip`
(about 90 KB). `web-ext-artifacts/` is gitignored.

`npm run package` does the first four of those steps and writes `source.zip`
besides, refusing to run on a dirty working tree. It stops short of
`web-ext build`, because the listed route uploads through the dashboard rather
than from a zip on disk. There is deliberately no `sign:listed` script — see
`docs/DEVELOPMENT.md` → "Signing and submission".

Confirm the zip contains exactly these eight files and nothing else — no tests,
no fixtures, no source maps, no `node_modules`:

```
manifest.json
background.js
popup.js   popup.html   popup.css
autofill.js
icon-48.png   icon-96.png
```

### Expected lint output

`web-ext lint` reports **0 errors, 0 warnings and 0 notices**. Anything else is
a regression worth understanding before submitting.

The `data_collection_permissions` key is what keeps the notice count at zero.
The manifest declares:

```json
"data_collection_permissions": { "required": ["none"] }
```

`"none"` is exclusive — addons-linter raises `NONE_DATA_COLLECTION_IS_EXCLUSIVE`
if any other category is listed beside it. So if this add-on ever does start
collecting something, the manifest cannot quietly gain a category: `none` has to
be removed first, which is the point at which the AMO listing's data-collection
answers have to be revisited too. `tests/manifest.test.ts` asserts the exact
array for the same reason.

### A note on the icon, if a reviewer asks

The icon is an original drawing — a vault door with a dial and four handle
grips — rendered from `src/icons/icon.svg`, which is in the source archive.

It is **deliberately not a shield**. Bitwarden's mark is a shield and
Vaultwarden's is too, and this is an unofficial third-party client: it should
not be mistakable for an official one. The blue is also kept clear of
Bitwarden's `#175DDC`. Nothing in the package uses the Bitwarden or Vaultwarden
name or mark as branding; "Vaultwarden" appears only where it names the server
software this client talks to.

## Listing settings

Submit at https://addons.mozilla.org/developers/ as a **listed** add-on, and
leave it visible. That is what this document is for, and it is a public act: a
listing page, a search entry, human review, and a version number that cannot be
taken back.

**If the goal is to run the add-on privately on your own phone, this is the
wrong document.** Sign it *unlisted* and install the signed XPI from a file —
`docs/PRIVATE-INSTALL.md` walks that route end to end. Nothing done there has to
be undone before submitting a listed version later; the add-on id is the same
either way.

There is no third option in between. AMO has no "we host it, but hidden" mode:
setting a listed add-on to **invisible** takes the download away along with the
listing page, so it leaves nothing installable behind.

An earlier revision of this file recommended invisible-listed as the private
route and claimed an unlisted add-on cannot be installed on release Firefox for
Android at all. Both halves were wrong, and in opposite directions — invisible
is *not* installable, and unlisted *is*, from a local file, on release Firefox
122 and newer.

Confirm the finished listing shows Android compatibility. If it does not, the
`browser_specific_settings.gecko_android` key in `src/manifest.json` is missing
or malformed. That exact defect is what makes the official Bitwarden extension
uninstallable on Android, so it is worth checking on the live listing rather
than assuming.

## Source code submission

Required, because the reviewed files are bundler output. Produce the archive
from a clean checkout of the exact commit being submitted:

```bash
git archive --format=zip -o source.zip HEAD
```

`git archive` exports **tracked files only**, so `node_modules/`, `dist/`,
`web-ext-artifacts/` and the planning directory are all excluded automatically.
What it does contain: `src/`, `tests/` (including `tests/fixtures/`), `scripts/`,
`docs/` (the design specs under `docs/superpowers/` included), `package.json`,
`package-lock.json`, `tsconfig.json`, `.gitignore`, and the two vitest configs —
roughly 110 files, about 430 KB zipped and 1.3 MB unpacked.

`source.zip` is gitignored, so it cannot be committed by accident.

### Build instructions for the reviewer

AMO requires that the submitted source actually build. Include this text in the
"build instructions" box:

> Requires Node.js 22.12.0 (or any 22.x LTS) and npm.
>
> ```
> npm ci
> npm run build
> ```
>
> `npm ci` installs the exact dependency tree pinned in `package-lock.json`.
> `npm run build` runs `scripts/build.mjs`, which bundles each extension entry
> point with Rollup (via the `vite` dependency) into a self-contained classic
> script, then copies the manifest, the popup's HTML and CSS, and the two icons.
>
> The output directory is `dist/`, and its contents are byte-for-byte the files
> in the submitted package: `manifest.json`, `background.js`, `popup.js`,
> `popup.html`, `popup.css`, `autofill.js`, `icon-48.png`, `icon-96.png`.
>
> `npm test` runs the type checker and the unit suite (no network, no Docker) if
> you wish to verify the source independently.

## Reviewer notes

Every claim below was checked against the source before being written here. If
the code changes, this block has to change with it — a note that a reviewer can
disprove by reading the manifest is worse than no note at all.

Include this text:

> This extension is a client for self-hosted Vaultwarden servers (a
> Bitwarden-compatible API implementation). It reads an existing vault, unlocks
> it locally, and fills login forms. It cannot create or edit vault items.
>
> **Permissions**
>
> `storage` holds the account record in `browser.storage.local`, and this is the
> whole of it (`StoredState` in `src/session/store.ts`): the server URL and
> email, the server's own encrypted user key and private key, the refresh token
> encrypted under the user key, the PIN-wrapped user key — absent entirely for
> an account the user has set to unlock without a PIN — and the last sync
> response cached as the server returned it, that is, still in the server's
> ciphertext. Alongside those, seven non-secret fields: a device id generated
> locally with `crypto.randomUUID()` and sent to the user's own server at login
> as Bitwarden's protocol requires, the server's own KDF parameters, the failed
> PIN counter, the time of the last sync, and the three settings (idle timeout,
> whether a restart demands the master password, and whether the account
> unlocks with a PIN or once per browser session). Nothing is stored in
> plaintext that the server did not already send in plaintext.
>
> **Page access.** The manifest requests `https://*/*`, `http://localhost/*`
> and `http://127.0.0.1/*`, and registers one content script on exactly those
> origins. This is the ordinary shape for a password manager: the affordance
> has to appear in the page's password field before the user has touched the
> extension, and nothing can be drawn on a page the extension cannot reach.
> `<all_urls>` is deliberately not requested — it would cover `ftp:`, `file:`
> and every other scheme, none of which this extension fills into. The two
> plain-http patterns are the loopback hosts only; every other http page is
> refused a fill, so no badge is offered there either.
>
> **The content script holds no credentials.** `autofill.js` runs at
> `document_idle`, looks for a visible password field, and — only if it finds
> one — asks the background page whether anything matches. The answer it
> receives is a list of entry ids and display names with no password field in
> it; the type that crosses that boundary (`ItemSummary`) has never had one. It
> then draws a small badge in a closed shadow root. It learns a credential only
> when the user taps that badge, and only as a message addressed to its own tab.
> A page with no login form produces no message at all, so ordinary browsing is
> never reported to the background page.
>
> **Every fill is validated in the background page, not on the page.** The
> destination URL is read from the tab itself rather than taken from the
> message — the content script does not get to name the origin it is filling
> into. The extension then refuses any page that is not https (loopback http
> excepted) and refuses to fill unless the chosen entry's own stored URIs match
> that page. `all_frames` is left off, so the script does not run in
> third-party iframes.
>
> **Tapping the badge on a locked vault** records an intent — tab id, origin,
> timestamp, in memory only, never persisted — and opens the unlock screen.
> When the vault unlocks, the tab's URL is read *again* and its origin compared
> with the recorded one before anything is filled; a tab that navigated in the
> meantime, or a tap older than two minutes, is discarded rather than guessed
> at. The fill then runs through the same validation described above.
>
> **Server access.** The user's own Vaultwarden server is reached under the same
> https grant described above, and the extension asks for nothing at runtime.
> Manifest V2 cannot express a runtime-determined origin — the server address is
> typed during setup and is not known when the manifest is written — so a pattern
> has to be named statically; since the content script already requires
> `https://*/*` at install time, a separate request for the single configured
> host would prompt for access that is already held. The extension therefore
> holds one https grant, taken at install, and no permission prompt appears
> during sign-in.
>
> It contacts exactly one server: the address the user typed, and no other. That
> address must be https — a plain-http server is refused at setup, before
> anything is sent, because sign-in posts the derived master password hash to it
> and every sync carries a bearer token to it. The two loopback patterns are for
> filling into locally served pages, and the server address gets no loopback
> exemption in return: http is refused there even for `localhost`, where the
> page-filling rule does allow it.
>
> **Cryptography** uses WebCrypto throughout: PBKDF2-HMAC-SHA256 and SHA-256 for
> the account key derivation, HKDF-Expand (implemented over WebCrypto HMAC-SHA256,
> because Bitwarden's scheme omits the extract step) for key stretching,
> AES-256-CBC with HMAC-SHA256 for the vault's encrypted strings, AES-256-GCM for
> the locally PIN-wrapped key, and RSA-OAEP for unwrapping organization keys.
> RSA-OAEP is used with SHA-1 because that is what the Bitwarden key format
> specifies for `protectedPrivateKey`; it is interoperability with an existing
> server format, not a chosen parameter.
>
> The **only** third-party runtime dependency is `hash-wasm`, used solely for
> Argon2id, which WebCrypto does not provide. It is needed in two places: for
> accounts whose server-side KDF is Argon2id (PBKDF2 accounts are also
> supported), and for deriving the local key that wraps the vault key under the
> user's PIN. Everything else in `package.json` is a build or test dependency
> and is not shipped.
>
> **Locking.** The vault auto-locks after 15 minutes of inactivity, and locking
> zeroes the key buffers rather than only dropping the references. A locked vault
> cannot reach the server at all: the refresh token is itself encrypted under the
> user key. Unlocking again uses a PIN of six or more characters. Five wrong
> PINs are allowed; the sixth submission is refused without being tried and
> drops the PIN-wrapped key, after which only the master password can open the
> vault. Each attempt is recorded before it is tried, so killing the browser
> mid-guess costs an attempt rather than granting a free one. Signing out
> removes every persisted secret from `browser.storage.local`.
>
> **Data flow.** Decryption happens only in the background page. The popup
> receives an item's id, name, username, whether it has a TOTP secret, and
> whether it failed to decrypt — there is no password field on the type that
> crosses that boundary. Passwords reach a web page only through the injected
> fill script, in a message addressed to a single tab.
>
> **No analytics, no telemetry, no third-party network requests, no remote
> code.** There are exactly three `fetch` call sites in the source
> (`src/api/identity.ts` × 2, `src/api/sync.ts` × 1) and all three target the
> server URL the user entered. No host is hard-coded anywhere. This is declared
> in the manifest as `data_collection_permissions: { "required": ["none"] }`,
> and it is checkable from the source: the three call sites above are the whole
> of the extension's network surface.
