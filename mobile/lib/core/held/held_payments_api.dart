import '../api/api_client.dart';

/// Where a held payment stands. Mirrors the server's stages; see
/// server/src/services/heldPayments.ts and docs/HELD_PAYMENTS.md.
enum HeldStage {
  waitingForDelivery,
  delivered,
  underReview,
  coolingOff,
  waitingToClaim,
  released,
  refunded,
  unknown;

  static HeldStage parse(String? raw) => switch (raw) {
        'waiting_for_delivery' => waitingForDelivery,
        'delivered' => delivered,
        'under_review' => underReview,
        'cooling_off' => coolingOff,
        'waiting_to_claim' => waitingToClaim,
        'released' => released,
        'refunded' => refunded,
        _ => unknown,
      };

  bool get settled => this == released || this == refunded;
}

/// Why a payer no longer needs the work — the reconciliation form's choices.
enum CancelReason {
  noLongerNeeded('no_longer_needed', 'I no longer need it'),
  notAsAgreed('not_as_agreed', 'It is not what we agreed'),
  notReceived('not_received', 'I did not receive it'),
  other('other', 'Something else');

  const CancelReason(this.wire, this.label);
  final String wire;
  final String label;

  static CancelReason? parse(String? raw) {
    for (final r in values) {
      if (r.wire == raw) return r;
    }
    return null;
  }
}

/// One message in the conversation on an open review.
class ReviewMessage {
  const ReviewMessage({
    required this.id,
    required this.from,
    required this.text,
    required this.at,
    this.links = const [],
    this.photos = const [],
  });

  factory ReviewMessage.fromJson(Map<String, dynamic> j) => ReviewMessage(
        id: j['id']?.toString() ?? '',
        from: j['from']?.toString() ?? '',
        text: j['text']?.toString() ?? '',
        links: _strings(j['links']),
        photos: _strings(j['photos']),
        at: DateTime.tryParse(j['at']?.toString() ?? '') ?? DateTime.now(),
      );

  final String id;

  /// payer, worker or reviewer. The reviewer is never named.
  final String from;
  final String text;
  final List<String> links;

  /// Server paths (/uploads/evidence_…); resolve against the API base.
  final List<String> photos;
  final DateTime at;
}

/// A photo attached to a review message, ready to send.
class EvidencePhoto {
  const EvidencePhoto({required this.base64, this.mime = 'image/jpeg'});

  final String base64;
  final String mime;

  Map<String, dynamic> toJson() => {'imageBase64': base64, 'mime': mime};
}

class HeldReview {
  const HeldReview({
    required this.status,
    required this.reason,
    required this.details,
    this.payerLinks = const [],
    this.workerStatement,
    this.workerLinks = const [],
    this.decisionNote,
    this.openedAt,
    this.messages = const [],
  });

  factory HeldReview.fromJson(Map<String, dynamic> j) => HeldReview(
        status: j['status']?.toString() ?? '',
        reason: CancelReason.parse(j['reason']?.toString()),
        details: j['details']?.toString() ?? '',
        payerLinks: _strings(j['payerLinks']),
        workerStatement: j['workerStatement']?.toString(),
        workerLinks: _strings(j['workerLinks']),
        decisionNote: j['decisionNote']?.toString(),
        openedAt: DateTime.tryParse(j['openedAt']?.toString() ?? ''),
        messages: ((j['messages'] as List?) ?? const [])
            .map((e) =>
                ReviewMessage.fromJson(Map<String, dynamic>.from(e as Map)))
            .toList(growable: false),
      );

  /// The conversation while the review is open, oldest first.
  final List<ReviewMessage> messages;

  /// under_review, released_to_worker or refunded_to_payer.
  final String status;
  final CancelReason? reason;
  final String details;
  final List<String> payerLinks;
  final String? workerStatement;
  final List<String> workerLinks;
  final String? decisionNote;

  /// When the payer sent the reconciliation form.
  final DateTime? openedAt;

  bool get open => status == 'under_review';
}

/// One held payment, as the signed-in person sees it.
class HeldPayment {
  const HeldPayment({
    required this.transferId,
    required this.purpose,
    required this.role,
    required this.stage,
    required this.actions,
    required this.amountUsdc,
    required this.memo,
    required this.counterparty,
    required this.expiresAt,
    this.deliveredAt,
    this.deliveryNote,
    this.deliveryLinks = const [],
    this.autoReleaseAt,
    this.releaseAt,
    this.settledBy,
    this.review,
    this.payerAgent,
  });

  factory HeldPayment.fromJson(Map<String, dynamic> j) => HeldPayment(
        transferId: j['transferId']?.toString() ?? '',
        purpose: j['purpose']?.toString() ?? 'claim_link',
        role: j['role']?.toString() ?? 'payer',
        stage: HeldStage.parse(j['stage']?.toString()),
        actions: _strings(j['actions']).toSet(),
        amountUsdc: (j['amountUsdc'] as num?)?.toDouble() ?? 0,
        memo: j['memo']?.toString() ?? '',
        counterparty: j['counterparty']?.toString() ?? '',
        expiresAt: DateTime.tryParse(j['expiresAt']?.toString() ?? ''),
        deliveredAt: DateTime.tryParse(j['deliveredAt']?.toString() ?? ''),
        deliveryNote: j['deliveryNote']?.toString(),
        deliveryLinks: _strings(j['deliveryLinks']),
        autoReleaseAt: DateTime.tryParse(j['autoReleaseAt']?.toString() ?? ''),
        releaseAt: DateTime.tryParse(j['releaseAt']?.toString() ?? ''),
        settledBy: j['settledBy']?.toString(),
        review: j['review'] is Map
            ? HeldReview.fromJson(Map<String, dynamic>.from(j['review'] as Map))
            : null,
        payerAgent: j['payerAgent'] is Map
            ? PayerAgent.fromJson(
                Map<String, dynamic>.from(j['payerAgent'] as Map))
            : null,
      );

  final String transferId;

  /// job, cooling_off or claim_link.
  final String purpose;

  /// payer or worker.
  final String role;
  final HeldStage stage;

  /// What this person may do next; the server enforces the same list.
  final Set<String> actions;
  final double amountUsdc;
  final String memo;

  /// The other person: who the money is for, or who is paying.
  final String counterparty;
  final DateTime? expiresAt;
  final DateTime? deliveredAt;
  final String? deliveryNote;
  final List<String> deliveryLinks;
  final DateTime? autoReleaseAt;
  final DateTime? releaseAt;
  final String? settledBy;
  final HeldReview? review;

  /// Set when an agent put this money aside; its owner answers for it.
  final PayerAgent? payerAgent;

  bool get isPayer => role == 'payer';
  bool get isJob => purpose == 'job';
  bool get isCoolingOff => purpose == 'cooling_off';
  bool can(String action) => actions.contains(action);

  /// Something the person should act on now.
  bool get needsMe =>
      can('mark_delivered') ||
      can('respond') ||
      (isPayer && stage == HeldStage.delivered) ||
      (isCoolingOff && can('cancel'));
}

List<String> _strings(Object? v) =>
    v is List ? v.map((e) => e.toString()).toList(growable: false) : const [];

/// Held payments: jobs, cooling-off payments and claim links.
///
/// Every action returns the updated payment. Errors surface as
/// [ApiException] with the server's plain-language message.
class HeldPaymentsApi {
  HeldPaymentsApi(this._api);

  final ApiClient _api;

  Future<List<HeldPayment>> list() async {
    final res = await _api.get('/v1/escrow/held');
    final items = (res['items'] as List?) ?? const [];
    return items
        .map((e) => HeldPayment.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList(growable: false);
  }

  Future<HeldPayment> get(String transferId) async =>
      _hold(await _api.get('/v1/escrow/held/$transferId'));

  Future<HeldPayment> markDelivered(
    String transferId, {
    required String note,
    List<String> links = const [],
  }) async =>
      _hold(await _api.post(
        '/v1/escrow/held/$transferId/deliver',
        body: {'note': note, 'links': links},
      ));

  Future<HeldPayment> confirm(String transferId) async =>
      _hold(await _api.post('/v1/escrow/held/$transferId/confirm'));

  /// Before delivery: the money comes straight back. After delivery pass
  /// [reason] and [details]; it then goes to a person for review.
  Future<({HeldPayment hold, bool underReview})> cancel(
    String transferId, {
    CancelReason? reason,
    String? details,
    List<String> links = const [],
  }) async {
    final res = await _api.post(
      '/v1/escrow/held/$transferId/cancel',
      body: {
        if (reason != null) 'reason': reason.wire,
        if (details != null) 'details': details,
        if (links.isNotEmpty) 'links': links,
      },
    );
    return (hold: _hold(res), underReview: res['underReview'] == true);
  }

  Future<HeldPayment> giveBack(String transferId) async =>
      _hold(await _api.post('/v1/escrow/held/$transferId/give-back'));

  Future<HeldPayment> respond(
    String transferId, {
    required String statement,
    List<String> links = const [],
  }) async =>
      _hold(await _api.post(
        '/v1/escrow/held/$transferId/respond',
        body: {'statement': statement, 'links': links},
      ));

  /// Adds to the conversation on an open review, with evidence.
  Future<HeldPayment> sendMessage(
    String transferId, {
    required String text,
    List<String> links = const [],
    List<EvidencePhoto> photos = const [],
  }) async =>
      _hold(await _api.post(
        '/v1/escrow/held/$transferId/messages',
        body: {
          'text': text,
          if (links.isNotEmpty) 'links': links,
          if (photos.isNotEmpty)
            'photos': photos.map((p) => p.toJson()).toList(),
        },
      ));

  static HeldPayment _hold(Map<String, dynamic> res) =>
      HeldPayment.fromJson(Map<String, dynamic>.from(res['hold'] as Map));
}

/// The agent that put a hold's money aside, and the person who owns it.
class PayerAgent {
  const PayerAgent({required this.label, this.handle, this.owner});

  factory PayerAgent.fromJson(Map<String, dynamic> j) => PayerAgent(
        label: j['label']?.toString() ?? 'An agent',
        handle: j['handle']?.toString(),
        owner: j['owner']?.toString(),
      );

  final String label;
  final String? handle;
  final String? owner;

  /// "Research agent · owned by @ada".
  String get byline => owner == null ? label : '$label · owned by $owner';
}
