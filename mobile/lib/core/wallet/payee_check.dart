import '../api/api_client.dart';
import '../config/env.dart';

/// What the server knows about a payee before any money moves: who they
/// really are, whether this sender has paid them before, and whether a
/// ten-minute cooling-off hold can be offered.
///
/// Built for the scam pattern regulators now make banks reimburse: pressure to
/// pay someone new, right now, in a way that cannot be undone.
class PayeeCheck {
  const PayeeCheck({
    required this.label,
    required this.address,
    required this.isEvabobUser,
    required this.paidBefore,
    required this.warnings,
    this.displayName,
    this.avatarUrl,
    this.resembles,
    this.coolingOffAvailable = false,
    this.coolingOffRecommended = false,
    this.coolingOffMinutes = 10,
    this.holdRecipient,
    this.family = false,
  });

  factory PayeeCheck.fromJson(Map<String, dynamic> j) {
    final cooling = j['coolingOff'] is Map
        ? Map<String, dynamic>.from(j['coolingOff'] as Map)
        : const <String, dynamic>{};
    return PayeeCheck(
      label: j['label']?.toString() ?? '',
      address: j['address']?.toString() ?? '',
      displayName: j['displayName']?.toString(),
      avatarUrl: _absolute(j['avatarUrl']?.toString()),
      isEvabobUser: j['isEvabobUser'] == true,
      paidBefore: j['paidBefore'] == true,
      warnings: (j['warnings'] as List?)?.map((e) => e.toString()).toSet() ??
          const {},
      resembles: j['resembles']?.toString(),
      coolingOffAvailable: cooling['available'] == true,
      coolingOffRecommended: cooling['recommended'] == true,
      coolingOffMinutes: (cooling['minutes'] as num?)?.toInt() ?? 10,
      holdRecipient: cooling['recipient']?.toString(),
      family: j['family'] == true,
    );
  }

  /// @handle, else email, else a shortened address.
  final String label;
  final String address;
  final String? displayName;

  /// The payee's profile photo, as an absolute URL, when they have set one.
  final String? avatarUrl;
  final bool isEvabobUser;
  final bool paidBefore;
  final Set<String> warnings;

  /// For an address that only looks like one already paid: the real one.
  final String? resembles;
  final bool coolingOffAvailable;
  final bool coolingOffRecommended;
  final int coolingOffMinutes;

  /// The identity a cooling-off hold is locked for.
  final String? holdRecipient;

  /// A contact marked as family: large payments need the emailed code.
  final bool family;

  /// Plain-language cautions for the review sheet, strongest first.
  List<String> get cautions => [
        if (warnings.contains('looks_like_known_address'))
          'This address looks like one you have paid before, but it is a '
              'different address. Scammers make addresses that match the '
              'first and last few characters. Check every character.',
        if (warnings.contains('raw_address_not_evabob'))
          'This address is not an Evabob account. Money sent to a wrong '
              'address cannot be recovered.',
      ];
}

/// Profile photos are served by the API as `/uploads/...` paths.
String? _absolute(String? u) {
  if (u == null || u.isEmpty) return null;
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  final base = Env.resolveApiBaseUrl().replaceAll(RegExp(r'/$'), '');
  return u.startsWith('/') ? '$base$u' : '$base/$u';
}

Future<PayeeCheck?> checkPayee(ApiClient api, String to) async {
  try {
    final res = await api.get('/v1/payees/check', query: {'to': to});
    return PayeeCheck.fromJson(res);
  } on ApiException {
    rethrow;
  } catch (_) {
    // Unreachable server: the send screen falls back to its own review
    // without the cooling-off offer rather than blocking the payment.
    return null;
  }
}
