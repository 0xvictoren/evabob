import 'package:flutter/foundation.dart';

import '../api/api_client.dart';

class SavedContact {
  SavedContact({
    required this.id,
    required this.name,
    required this.address,
    this.email,
    this.createdAt,
    this.family = false,
  });

  factory SavedContact.fromJson(Map<String, dynamic> j) => SavedContact(
        id: j['id']?.toString() ?? '',
        name: j['name']?.toString() ?? '',
        address: j['address']?.toString() ?? '',
        email: j['email']?.toString(),
        createdAt: j['createdAt']?.toString(),
        family: j['family'] == true,
      );

  final String id;
  final String name;
  final String address;
  final String? email;
  final String? createdAt;

  /// Marked as family: large payments to them need a code from email first.
  final bool family;
}

class ContactsService extends ChangeNotifier {
  ContactsService(this._api);

  final ApiClient _api;
  List<SavedContact> items = [];
  bool loading = false;

  Future<void> refresh() async {
    loading = true;
    notifyListeners();
    try {
      final data = await _api.get('/v1/contacts');
      final list = data['contacts'] as List? ?? [];
      items = list
          .whereType<Map>()
          .map((e) => SavedContact.fromJson(Map<String, dynamic>.from(e)))
          .toList();
    } catch (e) {
      debugPrint('contacts: $e');
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> add({
    required String name,
    required String address,
    String? email,
  }) async {
    await _api.post('/v1/contacts', body: {
      'name': name,
      'address': address,
      if (email != null && email.isNotEmpty) 'email': email,
    });
    await refresh();
  }

  /// Marks or unmarks a contact as family.
  Future<void> setFamily(String id, bool family) async {
    await _api.post('/v1/contacts/$id/family', body: {'family': family});
    await refresh();
  }

  /// The amount above which a payment to family needs the emailed code.
  Future<double> familyCheckAbove() async {
    final res = await _api.get('/v1/users/me/family-check');
    return (res['above'] as num?)?.toDouble() ?? 100;
  }

  Future<void> setFamilyCheckAbove(double above) async {
    await _api.post('/v1/users/me/family-check', body: {'above': above});
  }

  Future<void> remove(String id) async {
    await _api.post('/v1/contacts/$id/delete', body: {});
    await refresh();
  }

  List<SavedContact> match(String query) {
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return items;
    return items
        .where(
          (c) =>
              c.name.toLowerCase().contains(q) ||
              c.address.toLowerCase().contains(q) ||
              (c.email?.toLowerCase().contains(q) ?? false),
        )
        .toList();
  }
}
