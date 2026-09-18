import '../api/api_client.dart';
import '../config/env.dart';

/// How a seller has done with orders paid into a hold. Counted by the server
/// from finished holds; only fair marks count against them.
class SellerRecord {
  const SellerRecord({
    this.delivered = 0,
    this.notDelivered = 0,
    this.refundedAfterReview = 0,
    this.inProgress = 0,
  });

  factory SellerRecord.fromJson(Map<String, dynamic>? j) => SellerRecord(
        delivered: (j?['delivered'] as num?)?.toInt() ?? 0,
        notDelivered: (j?['notDelivered'] as num?)?.toInt() ?? 0,
        refundedAfterReview: (j?['refundedAfterReview'] as num?)?.toInt() ?? 0,
        inProgress: (j?['inProgress'] as num?)?.toInt() ?? 0,
      );

  final int delivered;
  final int notDelivered;
  final int refundedAfterReview;
  final int inProgress;

  int get finished => delivered + notDelivered + refundedAfterReview;

  String get summary => finished == 0
      ? 'No finished orders yet'
      : '$delivered delivered · $notDelivered not delivered · '
          '$refundedAfterReview refunded after review';
}

/// One of the seller's own links.
class HoldLink {
  const HoldLink({
    required this.id,
    required this.title,
    required this.amount,
    required this.deliveryDays,
    required this.active,
    required this.url,
    this.description = '',
    this.ordersTotal = 0,
    this.ordersWaiting = 0,
    this.ordersPaid = 0,
    this.ordersReturned = 0,
  });

  factory HoldLink.fromJson(Map<String, dynamic> j) {
    final o = j['orders'] is Map
        ? Map<String, dynamic>.from(j['orders'] as Map)
        : const <String, dynamic>{};
    return HoldLink(
      id: j['id']?.toString() ?? '',
      title: j['title']?.toString() ?? '',
      description: j['description']?.toString() ?? '',
      amount: (j['amount'] as num?)?.toDouble() ?? 0,
      deliveryDays: (j['deliveryDays'] as num?)?.toInt() ?? 14,
      active: j['active'] != false,
      url: j['url']?.toString() ?? '',
      ordersTotal: (o['total'] as num?)?.toInt() ?? 0,
      ordersWaiting: (o['waiting'] as num?)?.toInt() ?? 0,
      ordersPaid: (o['paid'] as num?)?.toInt() ?? 0,
      ordersReturned: (o['returned'] as num?)?.toInt() ?? 0,
    );
  }

  final String id;
  final String title;
  final String description;
  final double amount;
  final int deliveryDays;
  final bool active;
  final String url;
  final int ordersTotal;
  final int ordersWaiting;
  final int ordersPaid;
  final int ordersReturned;
}

/// A link as a buyer sees it before paying.
class PublicHoldLink {
  const PublicHoldLink({
    required this.id,
    required this.title,
    required this.description,
    required this.amount,
    required this.deliveryDays,
    required this.active,
    required this.sellerName,
    required this.sellerHandle,
    required this.record,
    this.sellerAvatarUrl,
    this.sellerSince,
  });

  factory PublicHoldLink.fromJson(Map<String, dynamic> j) {
    final s = j['seller'] is Map
        ? Map<String, dynamic>.from(j['seller'] as Map)
        : const <String, dynamic>{};
    final avatar = s['avatarUrl']?.toString();
    return PublicHoldLink(
      id: j['id']?.toString() ?? '',
      title: j['title']?.toString() ?? '',
      description: j['description']?.toString() ?? '',
      amount: (j['amount'] as num?)?.toDouble() ?? 0,
      deliveryDays: (j['deliveryDays'] as num?)?.toInt() ?? 14,
      active: j['active'] != false,
      sellerName: s['name']?.toString() ?? '',
      sellerHandle: s['handle']?.toString() ?? '',
      sellerAvatarUrl: avatar == null || avatar.isEmpty
          ? null
          : avatar.startsWith('http')
              ? avatar
              : '${Env.resolveApiBaseUrl().replaceAll(RegExp(r'/$'), '')}$avatar',
      sellerSince: DateTime.tryParse(s['memberSince']?.toString() ?? ''),
      record: SellerRecord.fromJson(
        j['record'] is Map ? Map<String, dynamic>.from(j['record'] as Map) : null,
      ),
    );
  }

  final String id;
  final String title;
  final String description;
  final double amount;
  final int deliveryDays;
  final bool active;
  final String sellerName;
  final String sellerHandle;
  final String? sellerAvatarUrl;
  final DateTime? sellerSince;
  final SellerRecord record;

  /// What a buyer calls the seller in a sentence.
  String get sellerFirstName {
    final first = sellerName.trim().split(RegExp(r'\s+')).first;
    return first.isEmpty ? sellerHandle : first;
  }
}

class HoldLinksApi {
  HoldLinksApi(this._api);

  final ApiClient _api;

  Future<(List<HoldLink>, SellerRecord)> mine() async {
    final res = await _api.get('/v1/hold-links');
    final items = ((res['items'] as List?) ?? const [])
        .map((e) => HoldLink.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList(growable: false);
    return (
      items,
      SellerRecord.fromJson(
        res['record'] is Map ? Map<String, dynamic>.from(res['record'] as Map) : null,
      ),
    );
  }

  Future<HoldLink> create({
    required String title,
    required double amount,
    String? description,
    int deliveryDays = 14,
  }) async {
    final res = await _api.post('/v1/hold-links', body: {
      'title': title,
      'amount': amount,
      if (description != null && description.isNotEmpty)
        'description': description,
      'deliveryDays': deliveryDays,
    });
    return HoldLink.fromJson(Map<String, dynamic>.from(res['item'] as Map));
  }

  Future<void> setOpen(String id, bool open) async {
    await _api.post('/v1/hold-links/$id/${open ? 'open' : 'close'}');
  }

  Future<PublicHoldLink> view(String id) async {
    final res = await _api.get('/v1/public/hold-links/$id');
    return PublicHoldLink.fromJson(res);
  }
}
