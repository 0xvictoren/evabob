/// Helpers to keep long API/error/hash strings from blowing out layout.
library;

/// Shorten arbitrary text for SnackBars / status lines (default ~160 chars).
String shortUiText(Object? value, {int max = 160}) {
  final s = (value?.toString() ?? '').trim().replaceAll(RegExp(r'\s+'), ' ');
  if (s.isEmpty) return '';
  if (s.length <= max) return s;
  final head = (max * 0.7).floor().clamp(20, max - 20);
  final tail = (max - head - 1).clamp(8, 40);
  return '${s.substring(0, head)}…${s.substring(s.length - tail)}';
}

/// Truncate 0x hashes / long ids for display while keeping ends recognizable.
String shortHash(String? hash, {int head = 10, int tail = 8}) {
  final h = (hash ?? '').trim();
  if (h.isEmpty) return '';
  if (h.length <= head + tail + 1) return h;
  return '${h.substring(0, head)}…${h.substring(h.length - tail)}';
}

/// Prefer shortHash for 0x…64, else shortUiText.
String displayData(String? value, {int max = 120}) {
  final v = (value ?? '').trim();
  if (v.isEmpty) return '';
  if (RegExp(r'^0x[a-fA-F0-9]{20,}$').hasMatch(v)) {
    return shortHash(v);
  }
  return shortUiText(v, max: max);
}

/// Turns whatever went wrong into a sentence a person can act on.
///
/// Roughly fifteen places in this app showed a caught exception directly:
/// `SnackBar(content: Text('$e'))`. Because `ApiException` stringifies as
/// `ApiException($status): $message`, a real failure reached the user as
/// `Send failed: ApiException(400): insufficient_balance`. That tells someone
/// nothing they can do anything about, and it tells them the app is broken
/// even when they simply have no money.
///
/// The rules, in order: recognise the failures that have a specific useful
/// answer, strip the wrappers off everything else, and fall back to a plain
/// sentence rather than show anything that still reads as machine output.
String friendlyError(
  Object? error, {
  String fallback = 'Something went wrong. Please try again.',
}) {
  final raw = (error?.toString() ?? '').trim();
  if (raw.isEmpty) return fallback;
  final low = raw.toLowerCase();

  // Connectivity, before anything else: it is the most common failure and the
  // only one where "try again" is genuinely the right advice.
  if (low.contains('socketexception') ||
      low.contains('failed host lookup') ||
      low.contains('connection refused') ||
      low.contains('connection closed') ||
      low.contains('network is unreachable') ||
      low.contains('clientexception')) {
    return 'Cannot reach Evabob right now. Check your connection and try '
        'again.';
  }

  // A timeout is not a failure — the payment may well have gone through, and
  // telling someone to retry is how they send twice.
  if (low.contains('timeoutexception') || low.contains('timed out')) {
    return 'That is taking longer than usual. Check Activity before trying '
        'again — it may already have gone through.';
  }

  // Circle refusing a GA payment because a first-time approval is not final
  // on that network yet. The server now waits for it instead, but an older
  // server, or a race, can still surface Circle's own wording.
  if (low.contains('signer is not authorized')) {
    return 'Your approval of Evabob on that network is still being '
        'confirmed. Try again in about 15 minutes — nothing has left your GA.';
  }

  final stripped = raw
      .replaceFirst(RegExp(r'^_?Exception:\s*'), '')
      .replaceFirst(RegExp(r'^ApiException\(\d+\):\s*'), '')
      .replaceFirst(RegExp(r'^FormatException:\s*'), '')
      .trim();

  const known = <String, String>{
    'unauthorized': 'Your session has expired. Sign in again.',
    'rate_limited': 'Too many tries just now. Wait a moment and try again.',
    'insufficient_balance': 'There is not enough in your balance for that.',
    'handle_taken': 'That username is already taken.',
    'not found': 'We could not find that.',
    'user not found': 'We could not find anyone with those details.',
    'internal_error': 'Something went wrong on our side. Please try again.',
    'invalid_request': 'Something about that request was not right.',
  };
  final hit = known[stripped.toLowerCase()];
  if (hit != null) return hit;

  // Anything still carrying a stack frame, a JSON body or a bare snake_case
  // token is machine output. Showing it is worse than saying nothing useful.
  if (stripped.isEmpty ||
      stripped.contains('#0') ||
      stripped.contains('{') ||
      stripped.contains('\n') ||
      RegExp(r'^[a-z0-9_]+$').hasMatch(stripped)) {
    return fallback;
  }

  final sentence = stripped[0].toUpperCase() + stripped.substring(1);
  return shortUiText(sentence, max: 160);
}
