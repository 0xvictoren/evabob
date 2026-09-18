import '../api/api_client.dart';
import 'held_payments_api.dart';

/// One cancelled-after-delivery job, as an operator sees it: both sides and
/// the work itself, so a person can decide where the money goes.
class OperatorReview {
  const OperatorReview({
    required this.transferId,
    required this.amountUsdc,
    required this.memo,
    required this.payer,
    required this.recipient,
    required this.status,
    required this.review,
    this.deliveredAt,
    this.deliveryNote,
    this.deliveryLinks = const [],
    this.expiresAt,
  });

  factory OperatorReview.fromJson(Map<String, dynamic> j) => OperatorReview(
        transferId: j['transferId']?.toString() ?? '',
        amountUsdc: (j['amountUsdc'] as num?)?.toDouble() ?? 0,
        memo: j['memo']?.toString() ?? '',
        payer: j['payer'] == null ? 'the payer' : '@${j['payer']}',
        recipient: j['recipient']?.toString() ?? '',
        status: j['status']?.toString() ?? 'pending',
        review: HeldReview.fromJson(
          Map<String, dynamic>.from((j['review'] as Map?) ?? const {}),
        ),
        deliveredAt: DateTime.tryParse(j['deliveredAt']?.toString() ?? ''),
        deliveryNote: j['deliveryNote']?.toString(),
        deliveryLinks: (j['deliveryLinks'] as List?)
                ?.map((e) => e.toString())
                .toList(growable: false) ??
            const [],
        expiresAt: DateTime.tryParse(j['expiresAt']?.toString() ?? ''),
      );

  final String transferId;
  final double amountUsdc;
  final String memo;
  final String payer;
  final String recipient;

  /// The hold itself: pending until decided.
  final String status;
  final HeldReview review;
  final DateTime? deliveredAt;
  final String? deliveryNote;
  final List<String> deliveryLinks;
  final DateTime? expiresAt;

  bool get open => review.open && status == 'pending';
}

class OperatorReviewsApi {
  OperatorReviewsApi(this._api);

  final ApiClient _api;

  /// Whether the signed-in person may decide reviews. False on any error, so
  /// the entry point simply does not appear.
  Future<bool> isOperator() async {
    try {
      final me = await _api.get('/v1/users/me');
      return me['operator'] == true;
    } catch (_) {
      return false;
    }
  }

  Future<List<OperatorReview>> listOpen() async {
    final res = await _api.get('/v1/operator/reviews');
    final items = (res['items'] as List?) ?? const [];
    return items
        .map(
            (e) => OperatorReview.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList(growable: false);
  }

  Future<OperatorReview> get(String transferId) async {
    final res = await _api.get('/v1/operator/reviews/$transferId');
    return OperatorReview.fromJson(
      Map<String, dynamic>.from(res['item'] as Map),
    );
  }

  /// Writes in the conversation as "Reviewer".
  Future<OperatorReview> sendMessage(
    String transferId, {
    required String text,
    List<String> links = const [],
    List<EvidencePhoto> photos = const [],
  }) async {
    final res = await _api.post(
      '/v1/operator/reviews/$transferId/messages',
      body: {
        'text': text,
        if (links.isNotEmpty) 'links': links,
        if (photos.isNotEmpty)
          'photos': photos.map((p) => p.toJson()).toList(),
      },
    );
    return OperatorReview.fromJson(
      Map<String, dynamic>.from(res['item'] as Map),
    );
  }

  /// [release] pays the worker; otherwise the money goes back to the payer.
  /// The note is shown to both people.
  Future<void> decide(
    String transferId, {
    required bool release,
    required String note,
  }) async {
    await _api.post(
      '/v1/operator/reviews/$transferId/decide',
      body: {'outcome': release ? 'release' : 'refund', 'note': note},
    );
  }
}
