# AMO listing texts

The texts for the add-on's page on addons.mozilla.org, ready to paste into the
developer hub. `docs/AMO-SUBMISSION.md` covers the package, the source upload
and the reviewer note; this file covers what the public sees.

Like the reviewer note and `docs/PRIVACY.md`, these texts make claims a reader
can check. Re-read them against the code before each submission, and whenever
a release changes what the add-on does or does not do.

AMO renders only a small subset of formatting in the description (links, bold,
italics, lists). Check the preview in the developer hub before publishing; if a
list does not render, the lines still read as plain text.

## Basic fields

| Field | Value |
|---|---|
| Name | Vaultwarden for Android |
| Add-on URL slug | `vaultwarden-for-android` |
| Category (Android) | Security & Privacy |
| Support email | — leave empty; the support site is enough |
| Support site | https://github.com/steitec/vaultwarden-for-android/issues |
| Homepage | https://github.com/steitec/vaultwarden-for-android |
| Licence | GNU General Public License v3.0 only |
| Privacy policy | the text of `docs/PRIVACY.md` |
| Tags | `password manager`, `autofill`, `vaultwarden`, `self-hosted`, `android` |
| Requires payment / non-free service | No |
| Experimental | No — but see "Before submitting" below |

The support email is left empty on purpose: an address on a public listing is
a spam target, and the issue tracker is where questions are useful to the next
person too.

## Summary

At most 250 characters. This one is 231.

> Unlock and autofill your self-hosted Vaultwarden vault in Firefox for
> Android. Fills logins with a tap, unlocks with a PIN, works offline, and
> talks only to your own server. Unofficial: not affiliated with Bitwarden or
> Vaultwarden.

## Description

> **An unofficial Vaultwarden client for Firefox for Android.** This add-on is
> not affiliated with, endorsed by, or connected to the Vaultwarden project or
> to Bitwarden, Inc. It talks to your Vaultwarden server through the same
> client API the official Bitwarden apps use.
>
> **What it does**
>
> - Signs in to your own Vaultwarden server with email and master password,
>   including two-step login.
> - Shows a small button in the password field of a login page. One tap fills
>   username and password. If several entries match, the tap opens a list to
>   choose from.
> - Matches entries by site, so an entry saved for example.com is offered on
>   login.example.com too.
> - Unlocks with a PIN, so the master password is typed rarely. Or, if you
>   prefer, turn the PIN off: then the master password opens the vault once
>   per Firefox start.
> - Locks itself after 15 minutes without use (with a PIN), even if the phone
>   was asleep in between.
> - Keeps your vault readable without a network connection.
> - Creates, edits and moves to the trash your own login entries, with a
>   password generator.
>
> **What it does not do (yet)**
>
> - On login pages that ask for the email first and the password on a later
>   screen (Google, Microsoft, web.de and others), the button only appears on
>   the password screen. Opening the add-on and tapping the entry works on
>   every screen.
> - It does not show TOTP codes, offer to save passwords you type, or handle
>   cards, identities, attachments, Sends or passkeys.
> - Entries that belong to an organization can be filled but not changed here;
>   use the web vault for those.
> - One account at a time.
>
> **Privacy and security**
>
> - No analytics, no telemetry, no tracking. The add-on contacts only the
>   server address you enter, over https, and nothing else.
> - Your vault is decrypted only on your phone, in the add-on's background
>   page. What is stored is encrypted.
> - A password is put into a page only after you tap, and only if the entry
>   belongs to the site that is actually open. Plain-http pages are never
>   filled.
> - Five wrong PINs and the PIN stops working; only the master password opens
>   the vault after that.
>
> The add-on needs access to all https websites so it can show its button in
> login forms before you open it, and to reach your server, whose address it
> cannot know in advance.
>
> **How it was made**
>
> The code was written with the help of an AI coding agent, test-first, and
> checked on a real phone before each release. No independent security audit
> has been done. The source code, the threat model and the test suite are
> public: https://github.com/steitec/vaultwarden-for-android
>
> Requires Firefox for Android 142 or newer and a Vaultwarden server. Tested
> against Vaultwarden 1.37.4.

## German translation (de)

AMO lets a listing carry a description per language. Optional, but most early
users are likely to be German-speaking.

**Zusammenfassung** (238 characters):

> Entsperrt deinen selbst gehosteten Vaultwarden-Tresor in Firefox für Android
> und füllt Logins aus. Ein Tipp genügt, Entsperren per PIN, offline nutzbar,
> nur dein eigener Server. Inoffiziell, nicht verbunden mit Bitwarden oder
> Vaultwarden.

**Beschreibung:**

> **Ein inoffizieller Vaultwarden-Client für Firefox für Android.** Dieses
> Add-on ist weder mit dem Vaultwarden-Projekt noch mit Bitwarden, Inc.
> verbunden oder von ihnen unterstützt. Es spricht mit deinem
> Vaultwarden-Server über dieselbe Client-Schnittstelle wie die offiziellen
> Bitwarden-Apps.
>
> **Was es kann**
>
> - Meldet sich mit E-Mail und Master-Passwort an deinem eigenen
>   Vaultwarden-Server an, auch mit Zwei-Faktor-Anmeldung.
> - Zeigt im Passwortfeld einer Login-Seite einen kleinen Knopf. Ein Tipp füllt
>   Benutzername und Passwort aus. Passen mehrere Einträge, öffnet der Tipp
>   eine Liste zur Auswahl.
> - Ordnet Einträge nach Website zu: Ein Eintrag für example.com wird auch auf
>   login.example.com angeboten.
> - Entsperrt mit einer PIN, damit du das Master-Passwort selten eintippen
>   musst. Wenn du lieber ohne PIN arbeitest, öffnet das Master-Passwort den
>   Tresor einmal pro Firefox-Start.
> - Sperrt sich (mit PIN) nach 15 Minuten ohne Benutzung, auch wenn das Handy
>   zwischendurch geschlafen hat.
> - Hält deinen Tresor auch ohne Netzverbindung lesbar.
> - Legt eigene Login-Einträge an, ändert sie und verschiebt sie in den
>   Papierkorb, mit Passwort-Generator.
>
> **Was es (noch) nicht kann**
>
> - Auf Login-Seiten, die zuerst nur die E-Mail und erst auf einer späteren
>   Seite das Passwort abfragen (Google, Microsoft, web.de und andere),
>   erscheint der Knopf erst auf der Passwort-Seite. Über das Add-on-Menü
>   lässt sich der Eintrag auf jeder Seite antippen.
> - Es zeigt keine TOTP-Codes, bietet nicht an, eingetippte Passwörter zu
>   speichern, und kennt keine Karten, Identitäten, Anhänge, Sends oder
>   Passkeys.
> - Einträge einer Organisation lassen sich ausfüllen, aber hier nicht ändern;
>   dafür gibt es den Web-Tresor.
> - Ein Konto gleichzeitig.
>
> **Datenschutz und Sicherheit**
>
> - Keine Analyse, keine Telemetrie, kein Tracking. Das Add-on spricht nur mit
>   der Serveradresse, die du einträgst, über https, und mit nichts sonst.
> - Dein Tresor wird nur auf deinem Handy entschlüsselt, im Hintergrund des
>   Add-ons. Gespeichert wird nur Verschlüsseltes.
> - Ein Passwort kommt nur nach deinem Tipp in eine Seite, und nur, wenn der
>   Eintrag zu der Website gehört, die gerade offen ist. Seiten mit einfachem
>   http werden nie ausgefüllt.
> - Nach fünf falschen PINs funktioniert die PIN nicht mehr; dann öffnet nur
>   noch das Master-Passwort den Tresor.
>
> Das Add-on braucht Zugriff auf alle https-Websites, damit es seinen Knopf in
> Login-Formularen zeigen kann, bevor du es öffnest, und um deinen Server zu
> erreichen, dessen Adresse es vorher nicht kennen kann.
>
> **Wie es entstanden ist**
>
> Der Code wurde mit Hilfe eines KI-Programmierassistenten geschrieben, mit
> Tests zuerst, und vor jeder Version auf einem echten Handy geprüft. Ein
> unabhängiges Sicherheitsaudit gibt es nicht. Quellcode, Bedrohungsmodell und
> Tests sind öffentlich: https://github.com/steitec/vaultwarden-for-android
>
> Benötigt Firefox für Android 142 oder neuer und einen Vaultwarden-Server.
> Getestet mit Vaultwarden 1.37.4.

## Screenshots

AMO shows them on the listing; for an Android-only add-on they should be taken
on the phone. Suggested set, in this order, with a test vault rather than the
real one:

1. A login page with the fill button in the password field.
2. The entry list on a page with several matching entries.
3. The add-on panel with the vault list.
4. The unlock screen with the PIN field.
5. The editor with the password generator.

Use made-up entries and a server name such as `vault.example.net`: nothing on
a screenshot should name a real account, a real server or the real vault.

## Release notes for the first listed version

> First version on addons.mozilla.org. Earlier versions were distributed as
> signed files from the GitHub releases; an installation from there keeps its
> data and updates from the listing from now on.

The second sentence is **not verified**. It assumes that Firefox's update
check finds listed versions for an add-on first installed from an unlisted
file, which needs at least the same add-on id
(`vaultwarden-android@steitec.net`, unchanged since 0.1.0) and a higher version
number. Confirm it on the phone once the listed version is live, before
publishing these notes; otherwise drop the sentence.

## Before submitting

- **F-1 (email-first logins).** The description above states the limitation
  openly, which is one way to decide it. The other is to fix it first, and
  then drop the first bullet under "What it does not do".
- **A new version number.** 0.3.4 is spent on the unlisted channel, and AMO
  counts numbers across both channels.
- **Experimental flag.** Left off above, because the add-on is in daily use and
  checked on a device before each release. Turning it on would be the honest
  choice if the listing is meant as a trial; it can be switched off later.
