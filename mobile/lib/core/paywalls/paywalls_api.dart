import '../api/api_client.dart';

/// A booking of the person's time, waiting for them to accept.
class PaywallBooking {
  const PaywallBooking({
    required this.id,
    required this.amountUsdc,
    required this.buyer,
    this.message = '',
    this.createdAt,
  });

  factory PaywallBooking.fromJson(Map<String, dynamic> j) => PaywallBooking(
        id: j['id']?.toString() ?? '',
        amountUsdc: (j['amountUsdc'] as num?)?.toDouble() ?? 0,
        buyer: j['buyer']?.toString() ?? '',
        message: j['message']?.toString() ?? '',
        createdAt: DateTime.tryParse(j['createdAt']?.toString() ?? ''),
      );

  final String id;
  final double amountUsdc;
  final String buyer;
  final String message;
  final DateTime? createdAt;
}

/// Something a person sells to software, behind a paywall Evabob hosts.
class Paywall {
  const Paywall({
    required this.id,
    required this.kind,
    required this.title,
    required this.priceUsdc,
    required this.active,
    required this.url,
    required this.resourceUrl,
    this.description = '',
    this.sales = 0,
    this.earnedUsdc = 0,
    this.paidOutUsdc = 0,
    this.bookings = const [],
    this.files = const [],
    this.minutes,
  });

  factory Paywall.fromJson(Map<String, dynamic> j) => Paywall(
        id: j['id']?.toString() ?? '',
        kind: j['kind']?.toString() ?? 'text',
        title: j['title']?.toString() ?? '',
        description: j['description']?.toString() ?? '',
        priceUsdc: (j['priceUsdc'] as num?)?.toDouble() ?? 0,
        active: j['active'] != false,
        url: j['url']?.toString() ?? '',
        resourceUrl: j['resourceUrl']?.toString() ?? '',
        sales: (j['sales'] as num?)?.toInt() ?? 0,
        earnedUsdc: (j['earnedUsdc'] as num?)?.toDouble() ?? 0,
        paidOutUsdc: (j['paidOutUsdc'] as num?)?.toDouble() ?? 0,
        bookings: [
          for (final b in (j['bookings'] as List? ?? const []))
            if (b is Map) PaywallBooking.fromJson(Map<String, dynamic>.from(b))
        ],
        files: [
          for (final f in (j['files'] as List? ?? const []))
            if (f is Map) f['name']?.toString() ?? ''
        ],
        minutes: j['time'] is Map
            ? ((j['time'] as Map)['minutes'] as num?)?.toInt()
            : null,
      );

  final String id;

  /// file, text, api or time.
  final String kind;
  final String title;
  final String description;
  final double priceUsdc;
  final bool active;

  /// The link to share: a page for people, a payment for software.
  final String url;

  /// Where software fetches it directly.
  final String resourceUrl;
  final int sales;
  final double earnedUsdc;
  final double paidOutUsdc;
  final List<PaywallBooking> bookings;
  final List<String> files;
  final int? minutes;

  String get kindWord => switch (kind) {
        'file' => files.length == 1 ? 'File' : '${files.length} files',
        'api' => 'Your API',
        'time' => '${minutes ?? 60} minutes of your time',
        _ => 'Text',
      };
}

/// How the person has done selling to software.
class PaywallRecord {
  const PaywallRecord(
      {this.delivered = 0, this.notCharged = 0, this.declined = 0});

  factory PaywallRecord.fromJson(Map<String, dynamic>? j) => PaywallRecord(
        delivered: (j?['delivered'] as num?)?.toInt() ?? 0,
        notCharged: (j?['notCharged'] as num?)?.toInt() ?? 0,
        declined: (j?['declined'] as num?)?.toInt() ?? 0,
      );

  final int delivered;
  final int notCharged;
  final int declined;
}

class NewPaywallFile {
  const NewPaywallFile({required this.name, required this.base64, this.mime});

  final String name;
  final String base64;
  final String? mime;
}

class PaywallsApi {
  PaywallsApi(this._api);

  final ApiClient _api;

  Future<(List<Paywall>, PaywallRecord)> mine() async {
    final res = await _api.get('/v1/paywalls');
    return (
      [
        for (final p in (res['items'] as List? ?? const []))
          if (p is Map) Paywall.fromJson(Map<String, dynamic>.from(p))
      ],
      PaywallRecord.fromJson(res['record'] is Map
          ? Map<String, dynamic>.from(res['record'] as Map)
          : null),
    );
  }

  Future<Paywall> create({
    required String kind,
    required String title,
    required double priceUsdc,
    String? description,
    String? category,
    List<NewPaywallFile> files = const [],
    String? text,
    String? apiUrl,
    String? headerName,
    String? headerValue,
    int? minutes,
    String? note,
  }) async {
    final res = await _api.post('/v1/paywalls', body: {
      'kind': kind,
      'title': title,
      'priceUsdc': priceUsdc,
      if (description != null && description.isNotEmpty)
        'description': description,
      if (category != null) 'category': category,
      if (kind == 'file')
        'files': [
          for (final f in files)
            {
              'name': f.name,
              'base64': f.base64,
              if (f.mime != null) 'mime': f.mime
            }
        ],
      if (kind == 'text') 'text': text,
      if (kind == 'api')
        'api': {
          'url': apiUrl,
          if (headerName != null && headerName.isNotEmpty)
            'headerName': headerName,
          if (headerValue != null && headerValue.isNotEmpty)
            'headerValue': headerValue,
        },
      if (kind == 'time')
        'time': {
          'minutes': minutes ?? 60,
          if (note != null && note.isNotEmpty) 'note': note
        },
    });
    return Paywall.fromJson(Map<String, dynamic>.from(res['item'] as Map));
  }

  Future<void> setOpen(String id, bool open) async {
    await _api.post('/v1/paywalls/$id/${open ? 'open' : 'close'}');
  }

  Future<void> answerBooking(String saleId,
      {required bool accept, String? details}) async {
    await _api.post('/v1/paywalls/bookings/$saleId', body: {
      'accept': accept,
      if (details != null) 'details': details,
    });
  }
}
