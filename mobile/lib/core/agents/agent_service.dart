import 'dart:math';
import 'package:flutter/foundation.dart';

import '../api/api_client.dart';

/// What an agent may spend on: "$20 this week, research services only".
class AgentAllowance {
  const AgentAllowance({
    required this.amountUsdc,
    required this.window,
    required this.categories,
    required this.askAboveUsdc,
    required this.proofOnly,
    this.summary = '',
    this.custom = false,
  });

  factory AgentAllowance.fromJson(Map<String, dynamic>? j) => AgentAllowance(
        amountUsdc: (j?['amountUsdc'] as num?)?.toDouble() ?? 0,
        window: j?['window']?.toString() ?? 'day',
        categories: [
          for (final c in (j?['categories'] as List? ?? const [])) c.toString()
        ],
        askAboveUsdc: (j?['askAboveUsdc'] as num?)?.toDouble() ?? 0,
        proofOnly: j?['proofOnly'] == true,
        summary: j?['summary']?.toString() ?? '',
        custom: j?['custom'] == true,
      );

  final double amountUsdc;

  /// day, week or month.
  final String window;

  /// Empty means anything on the approved list.
  final List<String> categories;

  /// Payments above this ask the owner first.
  final double askAboveUsdc;

  /// Only pay sellers that take the money after the response is checked.
  final bool proofOnly;
  final String summary;

  /// False for older agents still on their daily and per-call limits.
  final bool custom;

  Map<String, dynamic> toJson() => {
        'amountUsdc': amountUsdc,
        'window': window,
        'categories': categories,
        'askAboveUsdc': askAboveUsdc,
        'proofOnly': proofOnly,
      };

  static const categoryLabels = {
    'research': 'Research services',
    'data': 'Data',
    'media': 'Photos, video and sound',
    'ai': 'AI models',
    'finance': 'Financial data',
    'people': "People's time",
    'tools': 'Tools',
  };

  static const windowWords = {
    'day': 'a day',
    'week': 'a week',
    'month': 'a month',
  };
}

/// The live meter: spent, waiting on a check, and left this window.
class AgentMeter {
  const AgentMeter({
    this.amountUsdc = 0,
    this.spentUsdc = 0,
    this.heldUsdc = 0,
    this.remainingUsdc = 0,
    this.resetsAt,
    this.payments = 0,
  });

  factory AgentMeter.fromJson(Map<String, dynamic>? j) => AgentMeter(
        amountUsdc: (j?['amountUsdc'] as num?)?.toDouble() ?? 0,
        spentUsdc: (j?['spentUsdc'] as num?)?.toDouble() ?? 0,
        heldUsdc: (j?['heldUsdc'] as num?)?.toDouble() ?? 0,
        remainingUsdc: (j?['remainingUsdc'] as num?)?.toDouble() ?? 0,
        resetsAt: DateTime.tryParse(j?['resetsAt']?.toString() ?? ''),
        payments: (j?['payments'] as num?)?.toInt() ?? 0,
      );

  final double amountUsdc;
  final double spentUsdc;
  final double heldUsdc;
  final double remainingUsdc;
  final DateTime? resetsAt;
  final int payments;

  double get spentFraction =>
      amountUsdc <= 0 ? 0 : (spentUsdc / amountUsdc).clamp(0, 1).toDouble();
  double get heldFraction =>
      amountUsdc <= 0 ? 0 : (heldUsdc / amountUsdc).clamp(0, 1).toDouble();
}

/// A payment above the owner's limit, waiting for them.
class AgentApproval {
  const AgentApproval({
    required this.id,
    required this.url,
    required this.seller,
    required this.category,
    required this.amountUsdc,
    required this.status,
    this.expiresAt,
  });

  factory AgentApproval.fromJson(Map<String, dynamic> j) => AgentApproval(
        id: j['id']?.toString() ?? '',
        url: j['url']?.toString() ?? '',
        seller: j['seller']?.toString() ?? '',
        category: j['category']?.toString() ?? '',
        amountUsdc: (j['amountUsdc'] as num?)?.toDouble() ?? 0,
        status: j['status']?.toString() ?? 'pending',
        expiresAt: DateTime.tryParse(j['expiresAt']?.toString() ?? ''),
      );

  final String id;
  final String url;
  final String seller;
  final String category;
  final double amountUsdc;
  final String status;
  final DateTime? expiresAt;

  bool get isTask => url.startsWith('evabob://task/');
}

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
    this.allowance = const AgentAllowance(
        amountUsdc: 0,
        window: 'day',
        categories: [],
        askAboveUsdc: 0,
        proofOnly: false),
    this.meter = const AgentMeter(),
    this.paused = false,
    this.pauseReason,
    this.pauseDetail,
    this.approvals = const [],
    this.handle,
    this.handleOnChain = false,
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
        allowance: AgentAllowance.fromJson(_map(j['allowance'])),
        meter: AgentMeter.fromJson(_map(j['meter'])),
        paused: j['paused'] == true,
        pauseReason: j['pauseReason']?.toString(),
        pauseDetail: j['pauseDetail']?.toString(),
        approvals: [
          for (final a in (j['approvals'] as List? ?? const []))
            if (a is Map) AgentApproval.fromJson(Map<String, dynamic>.from(a))
        ],
        handle: j['handle']?.toString(),
        handleOnChain: j['handleOnChain'] == true,
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

  final AgentAllowance allowance;
  final AgentMeter meter;

  /// Stopped by the owner, the loop breaker, or a freeze.
  final bool paused;

  /// owner, loop or freeze.
  final String? pauseReason;
  final String? pauseDetail;
  final List<AgentApproval> approvals;

  /// "@name" once it has one; paid by it like a person.
  final String? handle;
  final bool handleOnChain;

  AgentWalletModel withLive({
    AgentMeter? meter,
    bool? paused,
    String? pauseReason,
    double? balanceUsdc,
  }) =>
      AgentWalletModel(
        id: id,
        label: label,
        balanceUsdc: balanceUsdc ?? this.balanceUsdc,
        dailyLimitUsdc: dailyLimitUsdc,
        spentTodayUsdc: spentTodayUsdc,
        apiKeyPrefix: apiKeyPrefix,
        createdAt: createdAt,
        perCallLimitUsdc: perCallLimitUsdc,
        custodyAddress: custodyAddress,
        custodyMode: custodyMode,
        chain: chain,
        active: active,
        revokedAt: revokedAt,
        allowance: allowance,
        meter: meter ?? this.meter,
        paused: paused ?? this.paused,
        pauseReason: paused == false ? null : (pauseReason ?? this.pauseReason),
        pauseDetail: paused == false ? null : pauseDetail,
        approvals: approvals,
        handle: handle,
        handleOnChain: handleOnChain,
      );
}

/// One paid call or hire in an agent's history.
class AgentPayment {
  const AgentPayment({
    required this.key,
    required this.url,
    required this.amountUsdc,
    required this.status,
    required this.createdAt,
    this.seller,
    this.settlement,
    this.evidenceId,
    this.error,
  });

  factory AgentPayment.fromJson(Map<String, dynamic> j) => AgentPayment(
        key: j['key']?.toString() ?? '',
        url: j['url']?.toString() ?? '',
        amountUsdc: (j['amountUsdc'] as num?)?.toDouble() ?? 0,
        status: j['status']?.toString() ?? '',
        createdAt: DateTime.tryParse(j['createdAt']?.toString() ?? ''),
        seller: j['seller']?.toString(),
        settlement: j['settlement']?.toString(),
        evidenceId: j['evidenceId']?.toString(),
        error: j['error']?.toString(),
      );

  final String key;
  final String url;
  final double amountUsdc;
  final String status;
  final DateTime? createdAt;
  final String? seller;
  final String? settlement;
  final String? evidenceId;
  final String? error;

  bool get isHire => key.startsWith('task:') || key.startsWith('task-cost:');

  String get statusWord => switch (status) {
        'settled' => 'Paid',
        'held' => 'Waiting on proof',
        'refunded' => 'Failed its check · not charged',
        'disputed' => 'Paid, nothing usable came back',
        'released' => 'Not paid',
        'ambiguous' || 'authorized' => 'Being checked',
        _ => 'Reserved',
      };
}

/// A person an agent hired, from the owner's side.
class AgentTaskView {
  const AgentTaskView({
    required this.id,
    required this.title,
    required this.amountUsdc,
    required this.status,
    required this.statusText,
    this.person,
    this.open = false,
    this.publicUrl,
    this.transferId,
  });

  factory AgentTaskView.fromJson(Map<String, dynamic> j) => AgentTaskView(
        id: j['id']?.toString() ?? '',
        title: j['title']?.toString() ?? '',
        amountUsdc: (j['amountUsdc'] as num?)?.toDouble() ?? 0,
        status: j['status']?.toString() ?? '',
        statusText: j['statusText']?.toString() ?? '',
        person: j['person']?.toString(),
        open: j['open'] == true,
        publicUrl: j['publicUrl']?.toString(),
        transferId: j['transferId']?.toString(),
      );

  final String id;
  final String title;
  final double amountUsdc;
  final String status;
  final String statusText;
  final String? person;
  final bool open;
  final String? publicUrl;
  final String? transferId;
}

Map<String, dynamic>? _map(Object? v) =>
    v is Map ? Map<String, dynamic>.from(v) : null;

/// Circle agent wallet: fund it, hand the API key to an external agent, and
/// that agent spends the balance through x402 nanopayments under the
/// allowance set here. The owner can pause it, freeze everything, answer
/// approvals, withdraw what is left, revoke the key, or rotate it.
class AgentService extends ChangeNotifier {
  AgentService(this._api);

  final ApiClient _api;
  List<AgentWalletModel> wallets = [];
  bool loading = false;
  String? lastCreatedApiKey;
  String? lastError;

  bool get anyActive => wallets.any((w) => w.active && !w.paused);
  bool get anyFrozen => wallets.any((w) => w.pauseReason == 'freeze');
  int get pendingApprovals => wallets.fold(0, (n, w) => n + w.approvals.length);

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

  /// Live updates from the server: the meter moves as the agent spends.
  void onAlert(Map<String, dynamic> alert) {
    final kind = alert['kind']?.toString();
    if (kind == 'agent_update') {
      final id = alert['agentId']?.toString();
      final i = wallets.indexWhere((w) => w.id == id);
      if (i < 0) return;
      final pending = (alert['pendingApprovals'] as num?)?.toInt() ?? 0;
      wallets[i] = wallets[i].withLive(
        meter: AgentMeter.fromJson(_map(alert['meter'])),
        paused: alert['pausedAt'] != null,
        pauseReason: alert['pauseReason']?.toString(),
        balanceUsdc: (alert['balanceUsdc'] as num?)?.toDouble(),
      );
      notifyListeners();
      // The approvals themselves come with a full refresh.
      if (pending != wallets[i].approvals.length) refresh();
    } else if (kind == 'agent_approval' || kind == 'agent_paused') {
      refresh();
    }
  }

  Future<String?> create({
    required String label,
    required AgentAllowance allowance,
  }) async {
    final data = await _api.post('/v1/agents', body: {
      'label': label,
      // Kept for older servers; the allowance is what applies.
      'dailyLimitUsdc': min(allowance.amountUsdc, 100),
      'allowance': allowance.toJson(),
    });
    // Shown once. The server does not store it, so this is the only chance
    // to copy it — see rotateKey for the recovery path.
    lastCreatedApiKey = data['apiKey']?.toString();
    await refresh();
    return lastCreatedApiKey;
  }

  Future<void> setAllowance(String id, AgentAllowance allowance) async {
    await _api.patch('/v1/agents/$id/allowance', body: allowance.toJson());
    await refresh();
  }

  Future<void> pause(String id) async {
    await _api.post('/v1/agents/$id/pause');
    await refresh();
  }

  Future<void> resume(String id) async {
    await _api.post('/v1/agents/$id/resume');
    await refresh();
  }

  /// One tap: every agent stops spending.
  Future<int> freezeAll() async {
    final res = await _api.post('/v1/agents/freeze');
    await refresh();
    return (res['frozen'] as num?)?.toInt() ?? 0;
  }

  Future<int> unfreezeAll() async {
    final res = await _api.post('/v1/agents/unfreeze');
    await refresh();
    return (res['resumed'] as num?)?.toInt() ?? 0;
  }

  Future<void> answerApproval(
      String agentId, String approvalId, bool approve) async {
    await _api.post('/v1/agents/$agentId/approvals/$approvalId',
        body: {'approve': approve});
    await refresh();
  }

  Future<void> claimName(String id, String handle) async {
    await _api.post('/v1/agents/$id/name', body: {'handle': handle});
    await refresh();
  }

  Future<List<AgentPayment>> payments(String id) async {
    final res = await _api.get('/v1/agents/$id/payments');
    return [
      for (final p in (res['payments'] as List? ?? const []))
        if (p is Map) AgentPayment.fromJson(Map<String, dynamic>.from(p))
    ];
  }

  Future<List<AgentTaskView>> tasks(String id) async {
    final res = await _api.get('/v1/agents/$id/tasks');
    return [
      for (final t in (res['items'] as List? ?? const []))
        if (t is Map) AgentTaskView.fromJson(Map<String, dynamic>.from(t))
    ];
  }

  Future<void> cancelTask(String agentId, String taskId) async {
    await _api.post('/v1/agents/$agentId/tasks/$taskId/cancel');
  }

  /// The evidence bundle for one payment, as the JSON to hand to whoever
  /// is arguing about it.
  Future<Map<String, dynamic>> evidence(String id, String paymentKey) async {
    return _api
        .get('/v1/agents/$id/evidence/${Uri.encodeComponent(paymentKey)}');
  }

  Future<Map<String, dynamic>> record(String id) async {
    return _api.get('/v1/agents/$id/record');
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

  /// What an agent can pay for here: Evabob paywalls (paid after proof) and
  /// Circle's catalog sellers on this network.
  Future<AgentServices> services() async {
    final res = await _api.get('/v1/agents/marketplace');
    final items = (res['items'] as List?) ?? const [];
    return AgentServices(
      paidExecution: items.isNotEmpty,
      note: res['note']?.toString(),
      items: items
          .map((e) => Map<String, dynamic>.from(e as Map))
          .map((e) => (
                provider: e['seller']?.toString() ?? '',
                description: e['name']?.toString() ?? '',
                priceUsdc: (e['priceUsdc'] as num?)?.toDouble() ?? 0,
                category: e['category']?.toString() ?? '',
                waitsForProof: e['waitsForProof'] == true,
              ))
          .toList(growable: false),
    );
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

class AgentServices {
  const AgentServices({
    required this.paidExecution,
    required this.items,
    this.note,
  });

  final bool paidExecution;
  final String? note;
  final List<
      ({
        String provider,
        String description,
        double priceUsdc,
        String category,
        bool waitsForProof,
      })> items;
}
