import '../api/api_client.dart';

/// The marketplace: what people sell, what people want.
///
/// The server ranks every list (how well it fits, how near, how good the
/// seller's record is) and sends the reasons with it, so the app only shows.

class MarketCategoryInfo {
  const MarketCategoryInfo(this.id, this.label);
  final String id;
  final String label;
}

/// Kept in step with the server's list (services/market.ts). Bundled so the
/// chips are there before the first request returns.
const marketCategories = <MarketCategoryInfo>[
  MarketCategoryInfo('home', 'Home and cleaning'),
  MarketCategoryInfo('food', 'Food and catering'),
  MarketCategoryInfo('repairs', 'Repairs and trades'),
  MarketCategoryInfo('fashion', 'Fashion and tailoring'),
  MarketCategoryInfo('beauty', 'Beauty and wellness'),
  MarketCategoryInfo('phones', 'Phones and electronics'),
  MarketCategoryInfo('design', 'Design and media'),
  MarketCategoryInfo('tech', 'Tech and software'),
  MarketCategoryInfo('lessons', 'Lessons and tutoring'),
  MarketCategoryInfo('events', 'Events'),
  MarketCategoryInfo('delivery', 'Delivery and errands'),
  MarketCategoryInfo('farm', 'Farm produce'),
  MarketCategoryInfo('rentals', 'Rentals'),
  MarketCategoryInfo('other', 'Everything else'),
];

String marketCategoryLabel(String id) => marketCategories
    .firstWhere((c) => c.id == id, orElse: () => marketCategories.last)
    .label;

/// Nigerian states, for the "where are you" picker. "Elsewhere" lets someone
/// outside Nigeria type their own.
const marketStates = <String>[
  'Abia', 'Abuja (FCT)', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi',
  'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo',
  'Ekiti', 'Enugu', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina',
  'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo',
  'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
];

class MarketSeller {
  const MarketSeller({
    required this.id,
    required this.name,
    this.handle,
    this.avatarUrl,
    this.avatarBundleIndex,
    required this.score,
    required this.tier,
    required this.tierLabel,
    this.rating,
    required this.reviews,
    required this.delivered,
    required this.verifiedSocials,
  });

  factory MarketSeller.fromJson(Map<String, dynamic> j) => MarketSeller(
        id: j['id']?.toString() ?? '',
        name: j['name']?.toString() ?? 'Someone',
        handle: j['handle']?.toString(),
        avatarUrl: j['avatarUrl']?.toString(),
        avatarBundleIndex: (j['avatarBundleIndex'] as num?)?.toInt(),
        score: (j['score'] as num?)?.toInt() ?? 0,
        tier: j['tier']?.toString() ?? 'new',
        tierLabel: j['tierLabel']?.toString() ?? 'New here',
        rating: (j['rating'] as num?)?.toDouble(),
        reviews: (j['reviews'] as num?)?.toInt() ?? 0,
        delivered: (j['delivered'] as num?)?.toInt() ?? 0,
        verifiedSocials: ((j['verifiedSocials'] as List?) ?? const [])
            .map((e) => e.toString())
            .toList(growable: false),
      );

  final String id;
  final String name;
  final String? handle;
  final String? avatarUrl;
  final int? avatarBundleIndex;

  /// 0 to 100.
  final int score;
  final String tier;
  final String tierLabel;
  final double? rating;
  final int reviews;
  final int delivered;
  final List<String> verifiedSocials;

  String get shownName => handle ?? name;
}

class MarketPost {
  const MarketPost({
    required this.id,
    required this.kind,
    required this.type,
    required this.category,
    required this.title,
    required this.description,
    required this.priceUsd,
    required this.photos,
    required this.state,
    required this.area,
    required this.remote,
    required this.deliveryDays,
    required this.active,
    required this.createdAt,
    this.near,
    required this.why,
    required this.seller,
    this.offers = 0,
  });

  factory MarketPost.fromJson(Map<String, dynamic> j) {
    final place = j['place'] is Map
        ? Map<String, dynamic>.from(j['place'] as Map)
        : const <String, dynamic>{};
    return MarketPost(
      id: j['id']?.toString() ?? '',
      kind: j['kind']?.toString() ?? 'offer',
      type: j['type']?.toString() ?? 'service',
      category: j['category']?.toString() ?? 'other',
      title: j['title']?.toString() ?? '',
      description: j['description']?.toString() ?? '',
      priceUsd: (j['priceUsd'] as num?)?.toDouble() ?? 0,
      photos: ((j['photos'] as List?) ?? const [])
          .map((e) => e.toString())
          .toList(growable: false),
      state: place['state']?.toString() ?? '',
      area: place['area']?.toString() ?? '',
      remote: j['remote'] == true,
      deliveryDays: (j['deliveryDays'] as num?)?.toInt() ?? 7,
      active: j['active'] != false,
      createdAt:
          DateTime.tryParse(j['createdAt']?.toString() ?? '') ?? DateTime.now(),
      near: j['near']?.toString(),
      why: ((j['why'] as List?) ?? const [])
          .map((e) => e.toString())
          .toList(growable: false),
      seller: MarketSeller.fromJson(j['seller'] is Map
          ? Map<String, dynamic>.from(j['seller'] as Map)
          : const {}),
      offers: (j['offers'] as num?)?.toInt() ?? 0,
    );
  }

  final String id;

  /// "offer" (someone sells this) or "want" (someone needs this).
  final String kind;

  /// "goods" or "service".
  final String type;
  final String category;
  final String title;
  final String description;

  /// The price of an offer, or the most a want will pay. Dollars.
  final double priceUsd;
  final List<String> photos;
  final String state;
  final String area;
  final bool remote;
  final int deliveryDays;
  final bool active;
  final DateTime createdAt;

  /// "In Lekki, like you", "About 4.2 km away".
  final String? near;

  /// Why the server ranked it where it did.
  final List<String> why;
  final MarketSeller seller;

  /// Offers waiting on the person's own request.
  final int offers;

  bool get isWant => kind == 'want';
  String get placeLabel =>
      [area, state].where((s) => s.isNotEmpty).join(', ');
}

class MarketDeal {
  const MarketDeal({
    required this.id,
    required this.postId,
    required this.title,
    required this.priceUsd,
    required this.requestId,
    required this.role,
    required this.withWhom,
    required this.status,
    required this.paid,
    required this.canReview,
    this.reviewStars,
  });

  factory MarketDeal.fromJson(Map<String, dynamic> j) => MarketDeal(
        id: j['id']?.toString() ?? '',
        postId: j['postId']?.toString() ?? '',
        title: j['title']?.toString() ?? '',
        priceUsd: (j['priceUsd'] as num?)?.toDouble() ?? 0,
        requestId: j['requestId']?.toString() ?? '',
        role: j['role']?.toString() ?? 'buyer',
        withWhom: j['with']?.toString() ?? '',
        status: j['status']?.toString() ?? 'open',
        paid: j['paid'] == true,
        canReview: j['canReview'] == true,
        reviewStars: j['review'] is Map
            ? ((j['review'] as Map)['stars'] as num?)?.toInt()
            : null,
      );

  final String id;
  final String postId;
  final String title;
  final double priceUsd;

  /// The payment request behind the deal: paid like any other request.
  final String requestId;
  final String role;
  final String withWhom;
  final String status;
  final bool paid;
  final bool canReview;
  final int? reviewStars;

  bool get iAmBuyer => role == 'buyer';

  /// What to say about where the money is, in plain words.
  String get statusLabel => switch (status) {
        'open' => iAmBuyer ? 'Waiting for you to pay' : 'Waiting for payment',
        'escrow' => 'Money set aside until delivered',
        'partial' => 'Half paid, half set aside',
        'paid' => 'Paid',
        'released' => 'Paid out',
        'refunded' => 'Money returned',
        'declined' => 'Declined',
        'cancelled' => 'Cancelled',
        'expired' => 'Not paid in time',
        _ => status,
      };
}

class MarketApi {
  MarketApi(this._api);

  final ApiClient _api;

  static List<MarketPost> _posts(dynamic rows) => ((rows as List?) ?? const [])
      .whereType<Map>()
      .map((r) => MarketPost.fromJson(Map<String, dynamic>.from(r)))
      .toList(growable: false);

  Future<({List<MarketPost> items, bool hasPlace, bool hasPoint})> browse({
    required String kind,
    String? category,
    String? query,
    String? sort,
  }) async {
    final res = await _api.get('/v1/market/posts', query: {
      'kind': kind,
      if (category != null) 'category': category,
      if (query != null && query.trim().isNotEmpty) 'q': query.trim(),
      if (sort != null) 'sort': sort,
    });
    return (
      items: _posts(res['items']),
      hasPlace: res['hasPlace'] == true,
      hasPoint: res['hasPoint'] == true,
    );
  }

  /// The whole answer for one post: the card, the seller, and — for the
  /// person who posted a request — the offers that came in and the agent's
  /// shortlist.
  Future<Map<String, dynamic>> post(String id) => _api.get('/v1/market/posts/$id');

  Future<({MarketPost post, List<MarketPost> matches})> create({
    required String kind,
    required String type,
    String? category,
    required String title,
    String? description,
    required double priceUsd,
    Map<String, dynamic>? display,
    List<String> photos = const [],
    Map<String, dynamic>? place,
    bool remote = false,
    int deliveryDays = 7,
  }) async {
    final res = await _api.post('/v1/market/posts', body: {
      'kind': kind,
      'type': type,
      if (category != null) 'category': category,
      'title': title,
      if (description != null && description.isNotEmpty)
        'description': description,
      'priceUsd': priceUsd,
      if (display != null) 'display': display,
      if (photos.isNotEmpty) 'photos': photos,
      if (place != null) 'place': place,
      'remote': remote,
      'deliveryDays': deliveryDays,
    });
    return (
      post: MarketPost.fromJson(Map<String, dynamic>.from(res['post'] as Map)),
      matches: _posts(res['matches']),
    );
  }

  Future<String> uploadPhoto(String base64, String mime) async {
    final res = await _api.post('/v1/market/photos',
        body: {'imageBase64': base64, 'mime': mime});
    return res['path']?.toString() ?? '';
  }

  /// A sentence turned into the fields of a post, for the person to check.
  Future<Map<String, dynamic>> assist(String text) =>
      _api.post('/v1/market/assist', body: {'text': text});

  Future<void> setActive(String id, bool active) =>
      _api.post('/v1/market/posts/$id/${active ? 'open' : 'close'}');

  Future<({List<MarketPost> posts, List<MarketDeal> deals, List<Map<String, dynamic>> sent})>
      mine() async {
    final res = await _api.get('/v1/market/mine');
    return (
      posts: _posts(res['posts']),
      deals: ((res['deals'] as List?) ?? const [])
          .whereType<Map>()
          .map((r) => MarketDeal.fromJson(Map<String, dynamic>.from(r)))
          .toList(growable: false),
      sent: ((res['sent'] as List?) ?? const [])
          .whereType<Map>()
          .map((r) => Map<String, dynamic>.from(r))
          .toList(growable: false),
    );
  }

  Future<void> sendOffer(String postId,
          {required double priceUsd, String? message, int? deliveryDays}) =>
      _api.post('/v1/market/posts/$postId/offers', body: {
        'priceUsd': priceUsd,
        if (message != null && message.isNotEmpty) 'message': message,
        if (deliveryDays != null) 'deliveryDays': deliveryDays,
      });

  Future<void> declineOffer(String id) =>
      _api.post('/v1/market/offers/$id/decline');

  Future<void> withdrawOffer(String id) =>
      _api.post('/v1/market/offers/$id/withdraw');

  /// Buys an offer as posted. The deal carries the request to pay.
  Future<MarketDeal> order(String postId) async {
    final res = await _api.post('/v1/market/posts/$postId/order');
    return MarketDeal.fromJson(Map<String, dynamic>.from(res['deal'] as Map));
  }

  /// Accepts one seller's offer on the person's own request.
  Future<MarketDeal> acceptOffer(String offerId) async {
    final res = await _api.post('/v1/market/offers/$offerId/accept');
    return MarketDeal.fromJson(Map<String, dynamic>.from(res['deal'] as Map));
  }

  Future<void> review(String dealId, int stars, String text) =>
      _api.post('/v1/market/deals/$dealId/review', body: {
        'stars': stars,
        if (text.trim().isNotEmpty) 'text': text.trim(),
      });

  Future<Map<String, dynamic>> me() => _api.get('/v1/market/me');

  Future<Map<String, dynamic>> saveMe({
    String? bio,
    Map<String, dynamic>? place,
    List<Map<String, String>>? socials,
  }) =>
      _api.post('/v1/market/me', body: {
        if (bio != null) 'bio': bio,
        if (place != null) 'place': place,
        if (socials != null) 'socials': socials,
      });

  /// Asks for an outside account to be checked; returns what to do next.
  Future<Map<String, dynamic>> checkSocial(String platform) =>
      _api.post('/v1/market/me/socials/$platform/check');

  /// A seller says they can do a request (or takes it back). No price and
  /// no message: the buyer decides who to talk to.
  Future<void> setAvailable(String postId, bool available) => _api.post(
      '/v1/market/posts/$postId/${available ? 'available' : 'unavailable'}');

  /// The buyer messages a seller about a post. Returns the chat to open.
  Future<Map<String, dynamic>> contact(String postId, {String? sellerId}) =>
      _api.post('/v1/market/posts/$postId/contact', body: {
        if (sellerId != null) 'sellerId': sellerId,
      });

  /// The seller's invoice to a buyer who messaged them; it lands in their
  /// chat as a request to pay.
  Future<Map<String, dynamic>> sendInvoice(
    String contactId, {
    required List<Map<String, dynamic>> items,
    String? note,
    int? deliveryDays,
    Map<String, dynamic>? display,
  }) =>
      _api.post('/v1/market/contacts/$contactId/invoice', body: {
        'items': items,
        if (note != null && note.isNotEmpty) 'note': note,
        if (deliveryDays != null) 'deliveryDays': deliveryDays,
        if (display != null) 'display': display,
      });

  /// Operators only: outside accounts waiting for a person to look.
  Future<List<Map<String, dynamic>>> socialChecks() async {
    final res = await _api.get('/v1/operator/market/socials');
    return [
      for (final e in (res['items'] as List?) ?? const [])
        if (e is Map) Map<String, dynamic>.from(e),
    ];
  }

  /// Operators only: the code was found on the account, or it was not.
  Future<void> decideSocialCheck({
    required String userId,
    required String platform,
    required bool verified,
  }) =>
      _api.post('/v1/operator/market/socials', body: {
        'userId': userId,
        'platform': platform,
        'verified': verified,
      });

  Future<Map<String, dynamic>> person(String idOrHandle) =>
      _api.get('/v1/market/people/${Uri.encodeComponent(idOrHandle)}');
}
