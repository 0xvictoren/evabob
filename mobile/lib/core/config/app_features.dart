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
  List<String> bridgeRoutes = const [];

  bool get bridge => bridgeRoutes.isNotEmpty;

  Future<void> refresh() async {
    try {
      final response = await _api.get('/v1/config/public');
      final raw = response['features'];
      if (raw is! Map) throw const FormatException('Missing feature flags');
      final flags = Map<String, dynamic>.from(raw);
      directSend = flags['directSend'] == true;
      protectedSend = flags['protectedSend'] == true;
      requests = flags['requests'] == true;
      gateway = flags['gateway'] == true;
      conversion = flags['conversion'] == true;
      agentWallets = flags['agentWallets'] == true;
      x402Execution = flags['x402Execution'] == true;
      agentBatchSend = flags['agentBatchSend'] == true;
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
      bridgeRoutes = const [];
      loaded = false;
      debugPrint('feature flags: $error');
    }
    notifyListeners();
  }
}
