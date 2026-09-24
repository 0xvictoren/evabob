/// One rule for how a typed payee is read, everywhere in the app.
///
/// Handles are not case sensitive and the @ is optional to type: "ekuma",
/// "@Ekuma" and "EKUMA" are all @ekuma. Treating the bare word as something
/// else — a name to search for, or an unregistered recipient — is how a
/// payment to a real user ended up held instead of delivered.
library;

final _address = RegExp(r'^0x[a-fA-F0-9]{40}$');
final _phone = RegExp(r'^\+?[\d\s\-()]{7,}$');
final _handleBody = RegExp(r'^[a-z0-9_.]{2,32}$');

/// `@name` in lowercase when [raw] is a handle, with or without its @.
/// Returns null for anything else (an address, email, phone, or a name with
/// spaces in it).
String? asHandle(String? raw) {
  final t = (raw ?? '').trim();
  if (t.isEmpty) return null;
  final body = (t.startsWith('@') ? t.substring(1) : t).toLowerCase();
  if (_address.hasMatch(t) || _phone.hasMatch(t)) return null;
  // An email has an @ inside it, not in front.
  if (body.contains('@')) return null;
  if (!_handleBody.hasMatch(body)) return null;
  return '@$body';
}

/// The payee to send to: a handle normalised to `@lowercase`, an email
/// lowercased, and an address or phone number left as typed.
String normalizePayee(String? raw) {
  final t = (raw ?? '').trim();
  final h = asHandle(t);
  if (h != null) return h;
  if (t.contains('@') && !t.startsWith('@') && !_address.hasMatch(t)) {
    return t.toLowerCase();
  }
  return t;
}

/// The handle without its @, lowercased — for APIs that take the bare form.
String bareHandle(String? raw) =>
    (raw ?? '').trim().replaceFirst(RegExp(r'^@+'), '').toLowerCase();
