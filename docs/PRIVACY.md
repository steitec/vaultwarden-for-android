# Privacy policy

*Vaultwarden for Android*, a Firefox add-on. Last updated 2026-11-26.

This add-on is an unofficial client for a Vaultwarden server that you run, or
that someone you trust runs for you. It is not affiliated with Bitwarden, Inc.
or with the Vaultwarden project.

## The short version

The add-on collects nothing. Its author receives no data from it, of any kind:
no analytics, no telemetry, no crash reports, no usage statistics. The add-on
talks to exactly one server, the Vaultwarden address you type in during setup,
and to nothing else.

## What is sent, and to whom

Everything the add-on sends goes to **your own server**, the address you
entered, over https. Plain http is refused before anything is sent. What goes
there is what the Bitwarden protocol requires:

- **At sign-in:** your email address, a hash derived from your master password
  (never the master password itself), a device identifier generated randomly
  on your phone, the device name `firefox`, and, if your account uses it, your
  two-factor code.
- **While you use it:** a login token with each request, to download your
  vault and to save the entries you create, edit or move to the trash. Entries
  are encrypted on your phone before they are sent, the same way the official
  Bitwarden apps do it.

What your server records about those requests, such as its logs or the list of
devices signed in to your account, is up to whoever runs it. This add-on has no
say in that.

Nothing is sent to the author of this add-on, to Mozilla, to Bitwarden, or to
any other third party. No address is built into the add-on; it only knows the
one you give it.

## What is stored on your phone

The add-on keeps its data in Firefox's own extension storage on your device:

- your server address and email address;
- your vault, exactly as your server sent it, which means **still encrypted**;
- the keys needed to unlock it, encrypted: under your master password by your
  server, and additionally under your PIN if you use one;
- a login token, encrypted under your vault key, so a locked vault cannot reach
  the server;
- a few non-secret values: the random device identifier, the encryption
  parameters your server uses, a count of wrong PIN attempts, when the vault was
  last synced, and your settings.

While the vault is unlocked, the decrypted entries exist only in the add-on's
memory. Locking the vault wipes them.

**Signing out** in the add-on deletes everything listed above. Uninstalling the
add-on deletes it too.

## Web pages you visit

To offer filling on login pages, the add-on can see the pages you open. It does
not record or send them anywhere:

- It looks for a visible password field, or for a visible field the site
  itself marks as the sign-in name (`autocomplete="username"` or
  `"webauthn"`), as on the first screen of logins that ask for the email
  first. **A page with neither is ignored entirely**: nothing about it leaves
  the page.
- On such a page, the add-on checks on your phone whether one of your vault
  entries belongs to that site. The page's address is compared locally and is
  not stored or sent.
- A password is put into a page only after you tap to fill, and only if the
  entry belongs to the page that is actually open. On a screen with only the
  sign-in name, the tap fills the username and nothing else.

## Permissions

- **Access to your data on all https websites** (and on `localhost`): needed to
  show the fill button in login forms before you open the add-on, and to reach
  your server, whose address cannot be known when the add-on is installed.
- **Storage:** for the data listed under "What is stored on your phone".

## Changes and contact

If this policy changes, the new version is published with the add-on's source
code, and the date at the top changes with it.

Questions go to the project's issue tracker:
<https://github.com/steitec/vaultwarden-for-android/issues>. Security problems
are reported privately, as described in `SECURITY.md`.
