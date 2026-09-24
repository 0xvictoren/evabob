class EvabobUser {
  const EvabobUser({
    required this.id,
    required this.email,
    required this.displayName,
    required this.smartAccount,
    this.handle,
    this.authToken,
    this.phone,
    this.phoneLinked = false,
    this.phoneLinkedAt,
    this.onboardingRequired,
  });

  factory EvabobUser.demo(String email, {String? displayName, String? handle}) {
    final name = displayName ?? email.split('@').first;
    final h = (handle ?? email.split('@').first)
        .toLowerCase()
        .replaceAll(RegExp(r'[^a-z0-9_]'), '');
    return EvabobUser(
      id: 'demo_${email.hashCode.abs()}',
      email: email,
      displayName:
          name.isEmpty ? 'User' : name[0].toUpperCase() + name.substring(1),
      handle: h.isEmpty ? 'user' : h,
      smartAccount: '',
    );
  }

  /// Stable Circle UCW id from Dynamic subject (or email fallback).
  static String circleUserIdFrom(String dynamicSubOrEmail) {
    final s = dynamicSubOrEmail.trim().toLowerCase();
    final cleaned = s.replaceAll(RegExp(r'[^a-z0-9_-]'), '_');
    if (cleaned.length >= 5 && cleaned.length <= 40) return cleaned;
    var h = 5381;
    for (final u in s.codeUnits) {
      h = ((h << 5) + h + u) & 0x7fffffff;
    }
    return 'u_$h';
  }

  /// Friendly name for UI only — never used as @handle for sends.
  static String displayNameFrom({
    required String? username,
    required String? email,
    required String? phone,
  }) {
    final u = username?.trim() ?? '';
    if (u.isNotEmpty) return u;
    final e = email?.trim() ?? '';
    if (e.isNotEmpty) return e.split('@').first;
    final p = phone?.trim() ?? '';
    if (p.isNotEmpty) return p;
    return 'evabob user';
  }

  /// Default @handle seed from email (user can change independently).
  static String defaultHandleFromEmail(String? email) {
    final e = (email ?? '').trim().toLowerCase();
    if (e.isEmpty || !e.contains('@')) return 'user';
    final local = e.split('@').first.replaceAll(RegExp(r'[^a-z0-9_]'), '');
    return local.length >= 3 ? local : 'user$local';
  }

  final String id;
  final String email;

  /// Shown in UI (Hello, …) — free to change anytime.
  final String displayName;

  /// @handle for sends — unique, chosen at signup and permanent after that.
  final String? handle;
  final String smartAccount;

  /// Dynamic access JWT for backend verification.
  final String? authToken;

  /// Optional phone — set later from Profile, never required at login.
  final String? phone;

  /// When true, phone is permanently linked (cannot change).
  final bool phoneLinked;
  final String? phoneLinkedAt;

  /// Null until the server has checked whether this is a new account.
  final bool? onboardingRequired;

  String get handleOrFallback => (handle != null && handle!.isNotEmpty)
      ? handle!
      : defaultHandleFromEmail(email);

  EvabobUser copyWith({
    String? id,
    String? email,
    String? displayName,
    String? handle,
    String? smartAccount,
    String? authToken,
    String? phone,
    bool? phoneLinked,
    String? phoneLinkedAt,
    bool? onboardingRequired,
    bool clearPhone = false,
    bool clearHandle = false,
  }) =>
      EvabobUser(
        id: id ?? this.id,
        email: email ?? this.email,
        displayName: displayName ?? this.displayName,
        handle: clearHandle ? null : (handle ?? this.handle),
        smartAccount: smartAccount ?? this.smartAccount,
        authToken: authToken ?? this.authToken,
        phone: clearPhone ? null : (phone ?? this.phone),
        phoneLinked: phoneLinked ?? this.phoneLinked,
        phoneLinkedAt:
            clearPhone ? null : (phoneLinkedAt ?? this.phoneLinkedAt),
        onboardingRequired: onboardingRequired ?? this.onboardingRequired,
      );
}
