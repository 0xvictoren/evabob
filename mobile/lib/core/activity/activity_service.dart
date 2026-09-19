import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../fx/fx_service.dart';
import '../sound/money_sounds.dart';
import '../utils/money_format.dart';

class ActivityEntry {
  ActivityEntry({
    required this.id,
    required this.kind,
    required this.title,
    required this.description,
    required this.amountUsdc,
    required this.createdAt,
    this.counterparty,
    this.txHash,
    this.mode,
    this.sender,
    this.receiver,
    this.token,
    this.amountToken,
    this.status,
    this.jobId,
    this.platformFee,
    this.platformFeeToken,
  });

  factory ActivityEntry.fromJson(Map<String, dynamic> j, FxService fx) {
    final usdc = (j['amountUsdc'] as num?)?.toDouble() ?? 0;
    final token = j['token']?.toString();
    final amountToken = (j['amountToken'] as num?)?.toDouble();
    return ActivityEntry(
      id: j['id']?.toString() ?? '',
      kind: j['kind']?.toString() ?? 'system',
      title: j['title']?.toString() ?? '',
      description: j['description']?.toString() ?? '',
      amountUsdc: usdc,
      createdAt:
          DateTime.tryParse(j['createdAt']?.toString() ?? '') ?? DateTime.now(),
      counterparty: j['counterparty']?.toString(),
      txHash: j['txHash']?.toString(),
      mode: j['mode']?.toString(),
      sender: j['sender']?.toString(),
      receiver: j['receiver']?.toString(),
      token: token,
      amountToken: amountToken,
      status: j['status']?.toString(),
      jobId: j['jobId']?.toString(),
      platformFee: (j['platformFee'] as num?)?.toDouble(),
      platformFeeToken: j['platformFeeToken']?.toString(),
    );
  }

  final String id;
  final String kind;
  final String title;
  final String description;
  final double amountUsdc;
  final DateTime createdAt;
  final String? counterparty;
  final String? txHash;
  final String? mode;
  final String? sender;
  final String? receiver;
  final String? token;
  final double? amountToken;
  final String? status;
  final String? jobId;

  /// Evabob fee charged on top of the amount, in [platformFeeToken].
  final double? platformFee;
  final String? platformFeeToken;

  bool get isPending => status == 'pending';

  /// Payments this person made can be shared as a public link.
  bool get shareable =>
      (kind == 'send' || kind == 'withdraw' || kind == 'bridge') &&
      status != 'cancelled';
  bool get resumable => isPending && jobId != null && jobId!.isNotEmpty;

  /// Inflow when amountUsdc > 0; for non-USDC (e.g. cirBTC swap) use token sign.
  bool get positive {
    if (amountUsdc.abs() > 1e-12) return amountUsdc > 0;
    // Pure token rows (CIRBTC/EURC swaps with amountUsdc=0): treat as out when
    // title starts with Swap and we spent the token, else neutral/out.
    if (kind == 'exchange' || kind == 'send' || kind == 'bridge') return false;
    if (kind == 'receive' || kind == 'fund') return true;
    return amountToken != null && amountToken! > 0 && kind == 'receive';
  }

  String get displayToken {
    final t = token?.trim();
    if (t != null && t.isNotEmpty) {
      if (t.toUpperCase() == 'CIRBTC') return 'cirBTC';
      return t;
    }
    return 'USDC';
  }

  double get displayAmount {
    if (amountToken != null && amountToken!.abs() > 0) {
      return amountToken!.abs();
    }
    return amountUsdc.abs();
  }

  String get amountLine {
    final sign = positive
        ? '+'
        : (amountUsdc < 0 ||
                kind == 'send' ||
                kind == 'bridge' ||
                kind == 'exchange' ||
                kind == 'agent')
            ? '−'
            : '';
    return '$sign${formatMoney(displayAmount, displayToken)}';
  }

  String receiptText({String appName = 'Evabob'}) {
    final local = createdAt.toLocal().toIso8601String();
    final buf = StringBuffer()
      ..writeln('================================')
      ..writeln('  $appName · PAYMENT RECEIPT')
      ..writeln('================================')
      ..writeln('Receipt ID : $id')
      ..writeln('Date       : $local')
      ..writeln('Type       : $kind')
      ..writeln('Title      : $title')
      ..writeln('Amount     : $amountLine');
    final from = sender ?? (positive ? counterparty : null);
    final to = receiver ?? (!positive ? counterparty : null);
    if (from != null && from.isNotEmpty) {
      buf.writeln('Sender     : $from');
    }
    if (to != null && to.isNotEmpty) {
      buf.writeln('Receiver   : $to');
    }
    // Fallback if only counterparty is set
    if ((from == null || from.isEmpty) &&
        (to == null || to.isEmpty) &&
        counterparty != null &&
        counterparty!.isNotEmpty) {
      buf.writeln('Party      : $counterparty');
    }
    buf.writeln('Details    : $description');
    if (mode != null && mode!.isNotEmpty) {
      buf.writeln('Mode       : $mode');
    }
    if (txHash != null && txHash!.isNotEmpty) {
      buf.writeln('Tx hash    : $txHash');
    } else {
      buf.writeln('Tx hash    : confirmed (indexing)');
    }
    buf
      ..writeln('--------------------------------')
      ..writeln('Keep this file for your records.')
      ..writeln('Built on Arc · $appName')
      ..writeln('================================');
    return buf.toString();
  }
}

class SharedPaymentLink {
  const SharedPaymentLink({required this.publicId, required this.url});

  final String publicId;
  final String url;
}

class ActivityService extends ChangeNotifier {
  ActivityService(this._api, this._fx);

  final ApiClient _api;
  final FxService _fx;

  List<ActivityEntry> items = [];
  bool loading = false;
  String? error;
  bool _loadedOnce = false;

  void clear() {
    _loadedOnce = false;
    items = [];
    loading = false;
    error = null;
    notifyListeners();
  }

  Future<void> refresh() async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      final data = await _api.get('/v1/activity');
      final list = data['items'] as List? ?? [];
      final before = items.map((e) => e.id).toSet();
      final hadLoaded = _loadedOnce;
      items = list
          .whereType<Map>()
          .map((e) => ActivityEntry.fromJson(Map<String, dynamic>.from(e), _fx))
          .toList();
      _loadedOnce = true;
      // Money that arrived without its live alert reaching this phone still
      // gets its sound — once, and only if it is new and recent.
      if (hadLoaded) {
        final now = DateTime.now();
        for (final e in items) {
          if (e.kind == 'receive' &&
              !before.contains(e.id) &&
              now.difference(e.createdAt).inMinutes < 5) {
            MoneySounds.instance.playIn(key: e.txHash ?? e.id);
            break;
          }
        }
      }
    } catch (e) {
      error = e.toString();
      debugPrint('activity: $e');
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  /// A public link for one of your payments, which anyone can open to see
  /// who paid, how much and when, with a fresh check against the Arc network.
  /// While the money is still moving the same link shows where it is.
  Future<SharedPaymentLink> shareLink(String activityId) async {
    final res = await _api.post('/v1/activity/$activityId/share');
    return SharedPaymentLink(
      publicId: res['publicId']?.toString() ?? '',
      url: res['url']?.toString() ?? '',
    );
  }

  /// Money that has come in, newest first. With [since], only what arrived
  /// after it, so a screen can poll and react once per new payment.
  Future<List<ActivityEntry>> incoming({DateTime? since}) async {
    final q = since == null
        ? ''
        : '?since=${Uri.encodeQueryComponent(since.toUtc().toIso8601String())}';
    final data = await _api.get('/v1/activity/incoming$q');
    final list = data['items'] as List? ?? [];
    return list
        .whereType<Map>()
        .map((e) => ActivityEntry.fromJson(Map<String, dynamic>.from(e), _fx))
        .toList(growable: false);
  }

  /// Attach on-chain hash to receipt after UCW confirms (best-effort).
  Future<void> attachTxHash(String activityId, String txHash) async {
    try {
      await _api.patch('/v1/activity/$activityId', body: {
        'txHash': txHash,
      });
    } catch (e) {
      debugPrint('attachTxHash: $e');
    }
  }
}

/// What happened, in a word a person would use.
///
/// The raw values are the server's enum names — `send`, `bridge`, `exchange`,
/// `agent` — and they were printed straight onto every activity row and every
/// receipt badge, so a receipt for moving money between networks read `BRIDGE`.
String kindLabel(String kind) => switch (kind) {
      'send' => 'Sent',
      'receive' => 'Received',
      'bridge' || 'cctp' => 'Moved',
      'exchange' => 'Converted',
      'gateway' => 'Topped up',
      'fund' => 'Added',
      'escrow' => 'Held',
      'agent' => 'Software payment',
      'system' => 'Update',
      _ => 'Payment',
    };

/// How the money travelled.
///
/// `direct_evm`, `claim_link` and `protected_escrow` were printed verbatim on
/// the receipt under the heading "Mode". Anything unrecognised falls back to a
/// plain description rather than leaking the next new mode string.
String modeLabel(String mode) => switch (mode) {
      'direct_evm' ||
      'direct_user' ||
      'onchain_ucw' ||
      'app_kit_ucw_send' ||
      'instant' =>
        'Straight to them',
      'onchain_inbound' => 'Straight to you',
      'escrow' || 'protected_escrow' => 'Held until released',
      'protected_escrow_claim' => 'Released to them',
      'claim_link' => 'Held until they join',
      'cctp_burn' ||
      'cctp_mint' ||
      'cctp_complete' ||
      'cctp_burn_pending_hash' =>
        'Moved between networks',
      'synthra' => 'Converted',
      'agent_ucw_fund' => 'Into an agent wallet',
      'agent_withdraw' => 'Out of an agent wallet',
      _ => 'Sent',
    };
