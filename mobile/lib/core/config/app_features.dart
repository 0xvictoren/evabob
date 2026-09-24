import 'package:flutter/foundation.dart';

import '../api/api_client.dart';

/// Capabilities advertised by the environment currently serving the app.
///
/// All money-moving features fail closed until `/v1/config/public` has been
/// read. This prevents a distributed build from showing a button merely
/// because the Flutter screen happens to exist.
class AppFeatures extends ChangeNotifier {
  AppFeatures(this._api);

  final ApiClient _api;

  bool loaded = false;
  bool directSend = false;
  bool protectedSend = false;
  bool requests = false;
  bool gateway = false;
  bool conversion = false;
  bool agentWallets = false;
  bool x402Execution = false;
  bool agentBatchSend = false;

  /// A payment note is written on the public network with the payment, where
  /// anyone can read it and it can never be removed. The send screen says so.
  bool onchainMemos = false;
  List<String> bridgeRoutes = const [];

  /// Evabob platform fee in basis points (5 = 0.05%); 0 when off. Added on
  /// top of the amount, gas excluded. The server charges it; the app only
  /// shows it before the PIN.
  int platformFeeBps = 0;

  bool get bridge => bridgeRoutes.isNotEmpty;

  /// Fee for [amount], rounded down to the token's smallest unit. No minimum:
  /// an amount too small to produce one unit of fee is charged nothing.
  double platformFeeFor(double amount, {int decimals = 6}) {
    if (platformFeeBps <= 0 || amount <= 0) return 0;
    final scale = BigInt.from(10).pow(decimals);
    // Same as the server's toFixed(decimals): the typed amount, in units.
    final units = BigInt.parse(
      (amount * scale.toDouble()).round().toString(),
    );
    final feeUnits = units * BigInt.from(platformFeeBps) ~/ BigInt.from(10000);
    return feeUnits.toDouble() / scale.toDouble();
  }

  Future<void> refresh() async {
    try {
      final response = await _api.get('/v1/config/public');
      final raw = response['features'];
      if (raw is! Map) throw const FormatException('Missing feature flags');
      final flags = Map<String, dynamic>.from(raw);
      final fee = response['platformFee'];
      platformFeeBps = fee is Map && fee['enabled'] == true
          ? ((fee['bps'] as num?)?.toInt() ?? 0)
          : 0;
      directSend = flags['directSend'] == true;
      protectedSend = flags['protectedSend'] == true;
      requests = flags['requests'] == true;
      gateway = flags['gateway'] == true;
      conversion = flags['conversion'] == true;
      agentWallets = flags['agentWallets'] == true;
      x402Execution = flags['x402Execution'] == true;
      agentBatchSend = flags['agentBatchSend'] == true;
      onchainMemos = flags['onchainMemos'] == true;
      bridgeRoutes = (flags['bridgeRoutes'] is List)
          ? (flags['bridgeRoutes'] as List)
              .map((value) => value.toString())
              .where((value) => value.isNotEmpty)
              .toList(growable: false)
          : const [];
      loaded = true;
    } catch (error) {
      // Keep the fail-closed values. A stale true from a previous environment
      // is never retained across a failed refresh.
      directSend = false;
      protectedSend = false;
      requests = false;
      gateway = false;
      conversion = false;
      agentWallets = false;
      x402Execution = false;
      agentBatchSend = false;
      // Unknown: assume a note may be public, so the warning shows.
      onchainMemos = true;
      bridgeRoutes = const [];
      platformFeeBps = 0;
      loaded = false;
      debugPrint('feature flags: $error');
    }
    notifyListeners();
  }
}
