import 'dart:math';
import 'package:flutter/foundation.dart';

import '../api/api_client.dart';

class AgentWalletModel {
  AgentWalletModel({
    required this.id,
    required this.label,
    required this.balanceUsdc,
    required this.dailyLimitUsdc,
    required this.spentTodayUsdc,
    required this.apiKeyPrefix,
    required this.createdAt,
    this.perCallLimitUsdc,
    this.custodyAddress,
    this.custodyMode,
    this.chain,
    this.active = true,
    this.revokedAt,
  });

  factory AgentWalletModel.fromJson(Map<String, dynamic> j) => AgentWalletModel(
        id: j['id']?.toString() ?? '',
        label: j['label']?.toString() ?? 'Agent',
        balanceUsdc: (j['balanceUsdc'] as num?)?.toDouble() ?? 0,
        dailyLimitUsdc: (j['dailyLimitUsdc'] as num?)?.toDouble() ?? 0,
        perCallLimitUsdc: (j['perCallLimitUsdc'] as num?)?.toDouble(),
        spentTodayUsdc: (j['spentTodayUsdc'] as num?)?.toDouble() ?? 0,
        apiKeyPrefix: j['apiKeyPrefix']?.toString() ?? '',
        createdAt: j['createdAt']?.toString() ?? '',
        custodyAddress: j['custodyAddress']?.toString(),
        custodyMode: j['custodyMode']?.toString(),
        chain: j['chain']?.toString(),
        active: j['active'] as bool? ?? true,
        revokedAt: j['revokedAt']?.toString(),
      );

  final String id;
  final String label;
  final double balanceUsdc;
  final double dailyLimitUsdc;

  /// Ceiling for a single x402 call. Null means only the daily cap applies.
  final double? perCallLimitUsdc;
  final double spentTodayUsdc;

  /// First 16 characters only — the key itself is never returned by the API.
  final String apiKeyPrefix;
  final String createdAt;
  final String? custodyAddress;
  final String? custodyMode;
  final String? chain;

  /// False once the key is revoked. A revoked agent cannot spend, but its
  /// remaining balance can still be withdrawn.
  final bool active;
  final String? revokedAt;
}

/// Circle agent wallet: fund it, hand the API key to an external agent, and
/// that agent spends the balance through x402 nanopayments under the caps set
/// here. The owner can withdraw what is left, revoke the key, or rotate it.
class AgentService extends ChangeNotifier {
  AgentService(this._api);

  final ApiClient _api;
  List<AgentWalletModel> wallets = [];
  bool loading = false;
  String? lastCreatedApiKey;
  String? lastError;

  Future<void> refresh() async {
    loading = true;
    lastError = null;
    notifyListeners();
    try {
      final data = await _api.get('/v1/agents');
      final list = data['wallets'] as List? ?? [];
      wallets = list
          .whereType<Map>()
          .map((e) => AgentWalletModel.fromJson(Map<String, dynamic>.from(e)))
          .toList();
    } catch (e) {
      lastError = e.toString();
      debugPrint('agents: $e');
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<String?> create({
    required String label,
    required double dailyLimitUsdc,
    double? perCallLimitUsdc,
  }) async {
    final data = await _api.post('/v1/agents', body: {
      'label': label,
      'dailyLimitUsdc': dailyLimitUsdc,
      if (perCallLimitUsdc != null) 'perCallLimitUsdc': perCallLimitUsdc,
    });
    // Shown once. The server does not store it, so this is the only chance
    // to copy it — see rotateKey for the recovery path.
    lastCreatedApiKey = data['apiKey']?.toString();
    await refresh();
    return lastCreatedApiKey;
  }

  /// Credit the agent ledger from a completed on-chain transfer to custody.
  /// The server verifies the transaction, so [fundTxHash] is required.
  Future<Map<String, dynamic>> deposit(
    String id,
    double amountUsdc, {
    required String fundTxHash,
  }) async {
    final data = await _api.post('/v1/agents/$id/deposit', body: {
      'amountUsdc': amountUsdc,
      'fundTxHash': fundTxHash,
    });
    await refresh();
    return data;
  }

  /// Move USDC back out of the agent wallet to the owner's own wallet.
  final Map<String, String> _withdrawalKeys = {};

  Future<Map<String, dynamic>> withdraw(String id, double amountUsdc) async {
    final request = '$id:$amountUsdc';
    final key = _withdrawalKeys.putIfAbsent(
        request,
        () => List.generate(
            24,
            (_) => Random.secure()
                .nextInt(256)
                .toRadixString(16)
                .padLeft(2, '0')).join());
    final data = await _api.post('/v1/agents/$id/withdraw', body: {
      'amountUsdc': amountUsdc,
      'idempotencyKey': key,
    });
    if ((data['withdrawal'] as Map?)?['status'] == 'complete') {
      _withdrawalKeys.remove(request);
    }
    await refresh();
    return data;
  }

  /// Kill the API key. Spending stops; the balance stays withdrawable.
  Future<Map<String, dynamic>> revoke(String id) async {
    final data = await _api.post('/v1/agents/$id/revoke');
    await refresh();
    return data;
  }

  /// Issue a replacement key, shown once. Also the recovery path for a key
  /// that was lost or leaked — the previous key stops working immediately.
  Future<String?> rotateKey(String id) async {
    final data = await _api.post('/v1/agents/$id/rotate-key');
    lastCreatedApiKey = data['apiKey']?.toString();
    await refresh();
    return lastCreatedApiKey;
  }

  Future<Map<String, dynamic>> custodyAddress(String id) async {
    return _api.get('/v1/agents/$id/custody');
  }

  /// Sponsor an x402 call with the agent API key.
  Future<Map<String, dynamic>> x402Pay({
    required String apiKey,
    String? url,
    String? query,
  }) async {
    return _api.post('/v1/x402/pay', body: {
      if (url != null) 'url': url,
      if (query != null) 'query': query,
      'apiKey': apiKey,
    });
  }
}
