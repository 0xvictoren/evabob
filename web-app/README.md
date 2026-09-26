# Evabob web-app

The Evabob app in a browser, for testers while the Play Store and App Store
reviews are pending.

It is **not a second app**. Every screen, service and rule lives in
`../mobile/lib` and is shared with Android and iOS. This folder only hosts that
code in a browser. It uses the same dart-defines (`mobile/dart_defines.json`),
the same API (`evabob-api-testnet`), the same Dynamic, Circle and Pusher
settings, and the same package versions (copied from `mobile/pubspec.lock`).
Someone who signs in here sees the same account, wallet, balance and history as
on their phone.

## What is different in a browser

The browser code lives in `mobile/lib` and is picked by `kIsWeb` or by
conditional imports. The phone code stays the default, so Android and iOS
behave exactly as before.

| | Phones | Web-app |
|---|---|---|
| Sign-in | Dynamic Flutter SDK | Dynamic JavaScript SDK through `bridge/src/dynamic_bridge.js` (`mobile/lib/core/auth/dynamic_client_web.dart`) |
| Circle PIN | `challenge.html` in a WebView | the same document, served as `circle/challenge.html` in an iframe (`mobile/lib/features/wallet/challenge_frame_web.dart`) |
| Staying signed in | secure storage | the tab's `sessionStorage`: closing the tab signs out |
| App lock and fingerprint | yes | no (the session ends with the tab) |
| Alerts while open | system notification | banner at the top of the page, with the same sounds |
| Push while closed | Firebase | not yet (phase 2) |
| Contacts | phone contacts | search by @handle |
| Receipts and export | share or save a file | browser download, or text share |
| Terms and Privacy | in-app page | new browser tab |
| Laptop screens | — | the app at phone width, centred |

## Build and run locally

You need Flutter (the same version as the phone builds) and Node 20 or newer.

```sh
cd web-app
node tool/build.mjs                  # sync assets, build the sign-in bridge, flutter build web
cd build/web && python -m http.server 8080
```

`tool/build.mjs --defines ../mobile/dart_defines.testnet.json` builds against
another dart-defines file. Set `EVABOB_FLUTTER` if `flutter` is not on PATH.

`tool/sync_assets.mjs` copies `mobile/assets` into `web-app/assets` and writes
`web/circle/challenge.html`, after checking the Circle SDK against its sha256.
It stops the build if `pubspec.yaml` here lists different assets than
`mobile/pubspec.yaml`. When you add an asset to the phones, add the same line
here.

A local run can only sign in if its origin (for example
`http://localhost:8080`) is allowed in the Dynamic dashboard and in the API's
`WEB_APP_ORIGIN` or `CORS_ORIGINS`.

## Hosting (Render)

The site is **https://evabob-webapp-testnet.onrender.com**. `render.free.yaml`
defines it as the static site `evabob-webapp-testnet`. The build installs
Flutter 3.44.6 and runs `node web-app/tool/build.mjs`. It rebuilds only when
`mobile/lib`, `mobile/assets`, the mobile pubspec or dart-defines, or
`web-app/` change.

For it to work:

1. **Dynamic dashboard → Security → Allowed origins:** add
   `https://evabob-webapp-testnet.onrender.com`. Without it, the browser
   cannot send sign-in codes.
2. **API:** `WEB_APP_ORIGIN` on `evabob-api-testnet` must be the site's exact
   URL. It is set in `render.free.yaml`; if Render gives the site a different
   address, update it there.
