# Confirming payments with fingerprint or Face ID

Evabob confirms every payment with the person's Circle wallet PIN. Circle
lets fingerprint or Face ID stand in for the PIN, but only in its **native**
Android and iOS SDKs — the web SDK the app uses to show the PIN screen has no
biometrics. So the app includes Circle's native SDK, and a switch in Profile:
**Confirm with fingerprint or Face ID**.

How it works:

- Turning it on asks for the PIN once (Circle's `setBiometricsPin`), then
  enrols the fingerprint or face on that phone.
- After that, each payment shows the fingerprint / Face ID prompt instead of
  the PIN screen, one step at a time. The PIN is always the fallback, inside
  Circle's own screen.
- If the native step fails for any reason other than the person cancelling,
  the app falls back to the normal PIN screen for that payment.
- The setting is per person, on that phone.

Code: `mobile/lib/core/wallet/circle_native_sdk.dart` (Dart side),
`mobile/android/app/src/circleSdk/` (Android bridge),
`mobile/ios/Runner/AppDelegate.swift` (iOS bridge), and
`CircleWalletService._confirmNatively`.

## Android: one-time setup (needs a GitHub token)

Circle publishes its Android SDK on GitHub Packages, which requires a GitHub
token even for public packages. Without one, the app still builds — it simply
has no fingerprint option (a stub bridge in `src/noCircleSdk` is compiled).

1. On GitHub: Settings → Developer settings → Personal access tokens →
   Tokens (classic) → Generate new token. Tick only **read:packages**.
2. Add to `mobile/android/local.properties` (this file is git-ignored — never
   commit the token):

   ```properties
   pwsdk.maven.username=<your GitHub username>
   pwsdk.maven.password=<the token>
   ```

3. Build as usual (`flutter build apk …`). Gradle now downloads
   `circle.programmablewallet:sdk:1.0.+` and compiles the real bridge, and the
   Profile switch appears.

The real bridge was written against Circle's documented API and sample app
but has not been compiled here, because no token was available when it was
written. The first build with a token is its first compile.

## iOS: on a Mac

The iOS bridge is in `AppDelegate.swift`, wrapped in
`#if canImport(CircleProgrammableWalletSDK)`, so the app builds with or
without the SDK. To include it:

1. Run `flutter build ios` once so Flutter creates `ios/Podfile`.
2. In `ios/Podfile`, inside `target 'Runner' do`, add
   `pod 'CircleProgrammableWalletSDK'`, then run `pod install` in `ios/`.
3. `NSFaceIDUsageDescription` is already in `Info.plist`.

This side has not been built or run: it needs Xcode on a Mac.
