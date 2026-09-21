# Circle Web SDK bundle

The mobile app loads Circle's Web SDK from the signed APK/IPA. It never loads
wallet code from a runtime CDN.

- npm package: `@circle-fin/w3s-pw-web-sdk@1.1.11`
- lockfile integrity: `sha512-EPiIE+Os+atMHUUIodPQz6CSunSAQsClvqxBpxXNPW1CsvdNE5rnyhWDkiik8z53zgiXLtksYo0sek241edO2A==`
- audited overrides: `undici@6.28.1`, `uuid@11.1.1`
- bundled asset SHA-256: `c6cb85762daee318a7d1c94e32c54463c30dc9bbea1f2a0c7d637b4ab7a4e9d0`

Rebuild from this directory with `npm ci` and `npm run build`. The build script
updates `mobile/assets/circle_w3s_sdk.js` and its `.sha256` sidecar. The app
checks that SHA-256 before placing wallet credentials into the local page.
