# The Kotlin Gradle Plugin warning

Every Android build prints this:

> WARNING: Your app uses the following plugins that apply Kotlin Gradle Plugin
> (KGP): device_info_plus, dynamic_sdk, file_picker, flutter_web_auth_2,
> mobile_scanner, package_info_plus, passkeys_android,
> pusher_channels_flutter, share_plus, ua_client_hints
>
> Future versions of Flutter will fail to build if your app uses plugins that
> apply KGP.

It is a real deadline and it is not our bug. None of the ten are ours; all of
them are third-party packages whose own `android/build.gradle` still does
`apply plugin: 'kotlin-android'` instead of relying on Flutter's Built-in
Kotlin. Nothing in this repository can turn that off — the only lever is a
plugin version whose author has migrated.

Run `bash mobile/tool/check_kgp.sh` to see the current list with versions. It
keys on the *apply*, not on the mention: several first-party plugins
(`url_launcher_android`, `shared_preferences_android`) still declare a
kotlin-gradle-plugin classpath without applying it, and are already fine.

## Where each one stands

Checked 2026-09-07 against Flutter 3.44.6.

| Plugin | We use it for | Blocker |
|---|---|---|
| `dynamic_sdk` | email OTP sign-in | At latest (1.17.0). Not migrated. |
| `share_plus` | sharing invoices and addresses | **13.2.0 added Built-in Kotlin support**, but `dynamic_sdk` pins `share_plus ^12.0.1`, so we cannot take it. |
| `device_info_plus`, `package_info_plus`, `file_picker`, `flutter_web_auth_2`, `passkeys_android`, `ua_client_hints` | all transitive, pulled by `dynamic_sdk` | Held at old majors by `dynamic_sdk`'s own constraints. |
| `mobile_scanner` | QR scanning | At latest (7.4.0). Changelog does not mention Built-in Kotlin. |
| `pusher_channels_flutter` | live chat and money alerts | At latest (2.6.0), last published ~8 months ago. Not migrated. |

So even if `dynamic_sdk` relaxed its pins tomorrow, `mobile_scanner` and
`pusher_channels_flutter` would keep the warning alive on their own. There is
no version combination available today that clears it.

## What was done

`dynamic_sdk` was moved 1.11.0 → 1.17.0. That does not fix the warning — 1.17.0
still applies KGP — but the intervening releases are additive with no breaking
changes, and one of them is a fix we want on the sign-in path: *"bound proxied
WebView fetch so a stalled request can't hang sdk.ready"*. The narrow SDK
surface this app uses (`DynamicSDK.init`, `auth.email.sendOTP` / `resendOTP` /
`verifyOTP`, the three token/profile streams, `auth.logout`,
`sdk.dynamicWidget`) is unchanged across those versions.

## What to do next

1. **Report it upstream**, which is what Flutter's own migration guide asks for
   when no fixed version exists. The two that matter most are
   `pusher_channels_flutter` and `mobile_scanner`, because they are at latest
   and block us by themselves.
2. **Ask Dynamic to relax `share_plus ^12.0.1`.** That single constraint is
   what pins six of the ten.
3. **Re-run the check before taking a Flutter upgrade.** When the warning
   becomes an error, an unplanned `flutter upgrade` is how it stops being a
   warning and starts being a release you cannot cut.

## If it becomes an error before the plugins move

Two escape routes, both worse than waiting:

- `dependency_overrides` to force newer plus_plugins past `dynamic_sdk`'s pins.
  `share_plus` 12 → 13 is a major bump, so the call this app makes
  (`SharePlus.instance.share(ShareParams(...))`) has to be re-checked against
  13's API before trusting it.
- Vendor the offending plugin and strip the `apply plugin` line. That means
  owning a fork of somebody else's Android code, on the sign-in and
  QR-scanning paths. Only if a release is genuinely blocked.
