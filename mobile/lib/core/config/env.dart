import 'package:flutter/foundation.dart';

import 'generated_env.dart';

/// Runtime / compile-time configuration. Secrets stay on the server.
class Env {
  Env._();

  static const appName = String.fromEnvironment(
    'APP_NAME',
    defaultValue: GeneratedEnv.appName,
  );

  // ─── Dynamic Labs (login only — environment ID is public) ─────────────
  static const dynamicEnvironmentId = String.fromEnvironment(
    'DYNAMIC_ENVIRONMENT_ID',
    defaultValue: GeneratedEnv.dynamicEnvironmentId,
  );
  static const dynamicAppOrigin = String.fromEnvironment(
    'DYNAMIC_APP_ORIGIN',
    defaultValue: GeneratedEnv.dynamicAppOrigin,
  );
  static bool get hasDynamicCredentials => dynamicEnvironmentId.isNotEmpty;

  static const autoDemoLogin = bool.fromEnvironment(
    'AUTO_DEMO',
    defaultValue: false,
  );

  /// Demo authentication is compiled out of release/profile builds even if a
  /// caller accidentally supplies ALLOW_DEMO=true.
  static const _allowDemo = bool.fromEnvironment(
    'ALLOW_DEMO',
    defaultValue: false,
  );
  static bool get demoEnabled => kDebugMode && _allowDemo;

  // ─── Firebase Cloud Messaging (push to a closed app; optional) ────────
  //
  // Public client identifiers from the Firebase console, supplied at build
  // time (dart_defines.json). No google-services.json is needed: the app
  // initialises Firebase from these. Leave them empty and push stays off —
  // in-app alerts over Pusher still work.
  static const firebaseApiKey = String.fromEnvironment('FIREBASE_API_KEY');
  static const firebaseProjectId =
      String.fromEnvironment('FIREBASE_PROJECT_ID');
  static const firebaseMessagingSenderId =
      String.fromEnvironment('FIREBASE_MESSAGING_SENDER_ID');
  static const firebaseAndroidAppId =
      String.fromEnvironment('FIREBASE_ANDROID_APP_ID');
  static const firebaseIosAppId = String.fromEnvironment('FIREBASE_IOS_APP_ID');
  static const firebaseIosBundleId =
      String.fromEnvironment('FIREBASE_IOS_BUNDLE_ID');

  static const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://127.0.0.1:8787',
  );

  static String resolveApiBaseUrl() {
    const defined = String.fromEnvironment('API_BASE_URL');
    if (defined.isNotEmpty) return defined;
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
      return 'http://10.0.2.2:8787';
    }
    return 'http://127.0.0.1:8787';
  }

  /// True when API_BASE_URL was never supplied and the loopback fallback is
  /// in use. A build like that only works on the machine that made it —
  /// 10.0.2.2 is the emulator's alias for its own host — so shipping one to a
  /// real device silently fails every request.
  static bool get usesFallbackApiBase =>
      const String.fromEnvironment('API_BASE_URL').isEmpty;

  /// True when the API base is plain HTTP or points at the local machine.
  /// Session tokens and PIN challenge ids travel over this connection.
  static bool get hasInsecureApiBase {
    return !isHttpsOrigin(resolveApiBaseUrl());
  }

  /// Accepts only an origin: HTTPS, a host, and no credentials, path, query,
  /// or fragment. Keeping the API base this narrow also avoids accidentally
  /// sending bearer tokens to a URL assembled from untrusted components.
  static bool isHttpsOrigin(String value) {
    final uri = Uri.tryParse(value);
    if (uri == null) return false;
    return uri.scheme.toLowerCase() == 'https' &&
        uri.host.isNotEmpty &&
        uri.userInfo.isEmpty &&
        (uri.path.isEmpty || uri.path == '/') &&
        !uri.hasQuery &&
        !uri.hasFragment;
  }

  /// Defense in depth for non-Android release/profile builds. Android release
  /// builds are rejected earlier by Gradle, before an APK or AAB is produced.
  static void validateApiBase() {
    if (kDebugMode || isHttpsOrigin(resolveApiBaseUrl())) return;
    throw StateError(
      'Release API_BASE_URL must be an exact HTTPS origin. '
      'Pass --dart-define=API_BASE_URL=https://<host>.',
    );
  }

  /// Logs once at startup so an accidentally-loopback build is visible in the
  /// device log instead of presenting as "the network is broken".
  static void warnIfApiBaseUnsafe() {
    if (!hasInsecureApiBase) return;
    debugPrint(
      'WARNING: API base is ${resolveApiBaseUrl()}'
      '${usesFallbackApiBase ? ' (API_BASE_URL was not set, using the loopback fallback)' : ''}.'
      ' This build cannot reach a server from a real device, and traffic is'
      ' not encrypted. Pass --dart-define=API_BASE_URL=https://<host>.',
    );
  }

  static const pusherKey = String.fromEnvironment(
    'PUSHER_KEY',
    defaultValue: GeneratedEnv.pusherKey,
  );
  static const pusherCluster = String.fromEnvironment(
    'PUSHER_CLUSTER',
    defaultValue: GeneratedEnv.pusherCluster,
  );
  static bool get hasPusher => pusherKey.isNotEmpty;

  static const arcChainId = 5042002;
  static const arcRpcUrl = 'https://rpc.testnet.arc.network';
  static const usdcAddress = '0x3600000000000000000000000000000000000000';
  static const eurcAddress = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
  static const gatewayWallet = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
  static const gatewayMinter = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';

  static const identityRegistry = String.fromEnvironment(
    'IDENTITY_REGISTRY',
    defaultValue: '0xb14355288fcE19811cccaF1589ea85e3791320a0',
  );
  static const paymentEscrow = String.fromEnvironment(
    'PAYMENT_ESCROW',
    defaultValue: '0x37Cb011C7a53e52f569b9c388B6208A71cD0Df39',
  );

  static const circleWalletsAppId = String.fromEnvironment(
    'CIRCLE_WALLETS_APP_ID',
    defaultValue: '9aed57be-b4be-52a2-a9ce-610af36e6055',
  );

  /// Product-supported chains (Arc Testnet, Ethereum Sepolia, Base Sepolia).
  static const supportedChains = <String>[
    'ARC-TESTNET',
    'ETH-SEPOLIA',
    'BASE-SEPOLIA',
  ];
}
