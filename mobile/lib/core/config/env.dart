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
    final url = resolveApiBaseUrl();
    if (!url.startsWith('https://')) return true;
    return url.contains('127.0.0.1') ||
        url.contains('localhost') ||
        url.contains('10.0.2.2');
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
    defaultValue: '0xd6b5cbCD102C848EB402bCB31E8FbB8f0b2b6805',
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
