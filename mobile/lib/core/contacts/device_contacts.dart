import 'package:flutter/foundation.dart';
import 'package:flutter_contacts/flutter_contacts.dart' as fc;
import 'package:permission_handler/permission_handler.dart';

class DeviceContact {
  DeviceContact({
    required this.id,
    required this.displayName,
    this.phone,
    this.email,
  });

  final String id;
  final String displayName;
  final String? phone;
  final String? email;
}

/// Load phone contacts for send / chat pickers (flutter_contacts 2.x API).
class DeviceContactsHelper {
  static Future<bool> ensurePermission() async {
    if (kIsWeb) return false;

    try {
      final status =
          await fc.FlutterContacts.permissions.request(fc.PermissionType.read);
      if (status == fc.PermissionStatus.granted ||
          status == fc.PermissionStatus.limited) {
        return true;
      }
    } catch (e) {
      debugPrint('flutter_contacts permission: $e');
    }

    var status = await Permission.contacts.status;
    if (status.isGranted) return true;
    status = await Permission.contacts.request();
    return status.isGranted;
  }

  static Future<List<DeviceContact>> load({int limit = 200}) async {
    final ok = await ensurePermission();
    if (!ok) return [];

    final raw = await fc.FlutterContacts.getAll(
      properties: {
        fc.ContactProperty.phone,
        fc.ContactProperty.email,
        fc.ContactProperty.name,
      },
      limit: limit,
    );

    final out = <DeviceContact>[];
    for (final c in raw) {
      final phone = c.phones.isNotEmpty ? c.phones.first.number : null;
      final email = c.emails.isNotEmpty ? c.emails.first.address : null;
      if ((phone == null || phone.isEmpty) &&
          (email == null || email.isEmpty)) {
        continue;
      }
      final name = (c.displayName ?? '').trim();
      out.add(
        DeviceContact(
          id: c.id ?? name,
          displayName: name.isNotEmpty ? name : 'Contact',
          phone: phone,
          email: email,
        ),
      );
    }
    out.sort(
      (a, b) =>
          a.displayName.toLowerCase().compareTo(b.displayName.toLowerCase()),
    );
    return out;
  }
}
