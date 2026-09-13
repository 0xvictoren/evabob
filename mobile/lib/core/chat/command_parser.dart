/// Parses Evabob chat money commands.
///
/// Supported shapes (case-insensitive):
///   @. send 3500 naira with description food
///   @. send 50 eur for dinner
///   @. send 20 usdc to @maya food money
///   @. send 10000
///   @. buy 10 usdc eurc
///   @. swap 5 usdc to eurc
///   @. bridge 25 usdc to base
///   @. deposit 20 usdc
///   @. compose spend 15 swap eurc bridge base
///
/// The raw command is **never** posted to chat — only a receipt message is.
class SendCommand {
  const SendCommand({
    required this.amount,
    required this.currency,
    this.description = '',
    this.recipientHandle,
  });

  final double amount;

  /// ngn | eur | usdc | usd | eurc | cirbtc
  final String currency;
  final String description;
  final String? recipientHandle;

  /// Settlement token for on-chain send.
  String get token {
    switch (currency) {
      case 'eur':
      case 'eurc':
        return 'EURC';
      case 'cirbtc':
      case 'btc':
        return 'CIRBTC';
      case 'usdc':
      case 'usd':
        return 'USDC';
      default:
        // Naira amounts settle in USDC
        return 'USDC';
    }
  }
}

/// Non-send money actions routed through Circle App Kit.
class MoneyCommand {
  const MoneyCommand({
    required this.action,
    required this.amount,
    this.tokenIn = 'USDC',
    this.tokenOut,
    this.toChain,
    this.fromChain = 'Arc_Testnet',
    this.description = '',
  });

  /// buy | swap | bridge | deposit | spend | compose
  final String action;
  final double amount;
  final String tokenIn;
  final String? tokenOut;
  final String? toChain;
  final String fromChain;
  final String description;
}

final _cmd = RegExp(
  r'''^\s*@\.\s*send\s+([\d,]+(?:\.\d+)?)\s*([a-zA-Z₦$€]*)(?:\s+to\s+(@?[\w.]+))?(?:\s+(?:with\s+description|for|desc)\s+(.+))?\s*$''',
  caseSensitive: false,
);

/// Alternate: `@. send 3500 naira food money` (trailing text = description)
final _cmdLoose = RegExp(
  r'''^\s*@\.\s*send\s+([\d,]+(?:\.\d+)?)\s*([a-zA-Z₦$€]+)?\s*(?:to\s+(@?[\w.]+)\s*)?(.*)?$''',
  caseSensitive: false,
);

bool looksLikeSendCommand(String text) {
  final t = text.trim().toLowerCase();
  return t.startsWith('@.') && t.contains('send');
}

/// Structured send intent. Never executes — callers must confirm (button/PIN).
class SendIntent {
  const SendIntent({
    required this.intent,
    required this.amount,
    required this.asset,
    required this.chain,
    required this.to,
    required this.toType,
    required this.confidence,
    required this.needsConfirmation,
    required this.originalMessage,
    this.clarification,
  });

  /// `send` or `clarification_needed`
  final String intent;
  final double? amount;
  final String asset; // USDC | EURC | CBTC
  final String chain; // Arc | Base | Ethereum
  final String? to;
  final String? toType; // address | email | handle | thread
  final double confidence;
  final bool needsConfirmation;
  final String originalMessage;
  final String? clarification;

  Map<String, dynamic> toJson() => {
        'intent': intent,
        'amount': amount,
        'asset': asset,
        'chain': chain,
        'to': to,
        'toType': toType,
        'confidence': confidence,
        'needsConfirmation': needsConfirmation,
        'originalMessage': originalMessage,
        if (clarification != null) 'clarification': clarification,
      };

  String get onchainToken {
    switch (asset.toUpperCase()) {
      case 'EURC':
        return 'EURC';
      case 'CBTC':
      case 'CIRBTC':
        return 'CIRBTC';
      default:
        return 'USDC';
    }
  }

  String get appKitChain {
    switch (chain) {
      case 'Base':
        return 'Base_Sepolia';
      case 'Ethereum':
        return 'Ethereum_Sepolia';
      default:
        return 'Arc_Testnet';
    }
  }
}

String _normalizeIntentAsset(String? raw) {
  final x = (raw ?? '').trim().toLowerCase();
  if (x == 'eurc' || x == 'eur' || x == 'euro' || x == 'euros') return 'EURC';
  if (x == 'cbtc' || x == 'cirbtc' || x == 'btc' || x.contains('bitcoin')) {
    return 'CBTC';
  }
  return 'USDC';
}

String _normalizeIntentChain(String? raw) {
  final x = (raw ?? '').trim().toLowerCase().replaceAll(' ', '_');
  if (x.startsWith('base')) return 'Base';
  if (x.startsWith('eth') || x == 'sepolia' || x == 'ethereum') {
    return 'Ethereum';
  }
  return 'Arc';
}

final _addrRe = RegExp(r'0x[a-fA-F0-9]{6,40}');
final _emailRe =
    RegExp(r'[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}', caseSensitive: false);
final _phoneRe = RegExp(r'\+\d{7,15}|\b0\d{9,14}\b');
final _handleRe = RegExp(r'@([a-zA-Z0-9_.]{2,32})');
final _assetWord =
    r'(?:usdc|eurc|cbtc|cirbtc|eur|usd|btc|dollar|dollars|euro|euros)';
final _chainWord = r'(?:aarc|arc|base|ethereum|eth|sepolia)';

({String? to, String? toType}) _classifyRecipient(
  String? raw, {
  String? peerHandle,
  String? peerAddress,
}) {
  if (raw == null || raw.trim().isEmpty) {
    if (peerAddress != null && _addrRe.hasMatch(peerAddress)) {
      return (to: peerAddress, toType: 'address');
    }
    if (peerHandle != null && peerHandle.trim().isNotEmpty) {
      final h = peerHandle.replaceFirst(RegExp(r'^@'), '');
      return (to: '@$h', toType: 'handle');
    }
    return (to: null, toType: 'thread');
  }
  final t = raw.trim();
  final addr = _addrRe.firstMatch(t);
  if (addr != null) return (to: addr.group(0), toType: 'address');
  final email = _emailRe.firstMatch(t);
  if (email != null) return (to: email.group(0), toType: 'email');
  if (_phoneRe.hasMatch(t.replaceAll(RegExp(r'[\s()-]'), ''))) {
    return (to: t, toType: null);
  }
  final handle = _handleRe.firstMatch(t);
  if (handle != null) return (to: '@${handle.group(1)}', toType: 'handle');
  final bare =
      t.replaceFirst(RegExp(r'^@'), '').replaceAll(RegExp(r'[^\w.]'), '');
  if (bare.length >= 2 &&
      bare.length <= 32 &&
      RegExp(r'[a-zA-Z]').hasMatch(bare)) {
    return (to: '@${bare.toLowerCase()}', toType: 'handle');
  }
  return (to: t, toType: null);
}

bool _looksLikeSend(String text, bool strict) {
  final t = text.toLowerCase();
  if (strict && t.contains('send')) return true;
  if (RegExp(r'^\s*send\b').hasMatch(t)) return true;
  if (RegExp(r'\bsend\s+\$?\s*[\d,]').hasMatch(t)) return true;
  if (RegExp(r'\b(please\s+)?(send|transfer|pay)\s+\$?\s*[\d,]').hasMatch(t)) {
    return true;
  }
  return false;
}

/// Smart send parser: strict `@.` commands and natural language.
/// Always returns [needsConfirmation] = true. Never moves funds.
SendIntent parseSendIntent(
  String message, [
  Map<String, dynamic>? threadContext,
]) {
  final original = message;
  final trimmed = message.trim();
  final strict = RegExp(r'^\s*@\.').hasMatch(trimmed);
  var text =
      trimmed.replaceFirst(RegExp(r'^\s*@\.\s*', caseSensitive: false), '');
  text = text.trim();

  SendIntent unclear(double confidence, String clarification,
      {double? amount,
      String? asset,
      String? chain,
      String? to,
      String? toType}) {
    return SendIntent(
      intent: 'clarification_needed',
      amount: amount,
      asset: asset ?? 'USDC',
      chain: chain ?? 'Arc',
      to: to,
      toType: toType ?? (threadContext != null ? 'thread' : null),
      confidence: confidence,
      needsConfirmation: true,
      originalMessage: original,
      clarification: clarification,
    );
  }

  if (!_looksLikeSend(text, strict) && !strict) {
    return unclear(0.15, r"I didn't detect a send. Try: send $5 to @handle");
  }
  if (strict && !RegExp(r'\bsend\b', caseSensitive: false).hasMatch(text)) {
    return unclear(
        0.2, r"That's an @. command but not a send. Try: @. send $5");
  }

  String? fromChain;
  String? toRaw;
  final fromMatch = RegExp('\\bfrom\\s+($_chainWord)\\b', caseSensitive: false)
      .firstMatch(text);
  if (fromMatch != null) {
    fromChain = fromMatch.group(1);
    text = text.replaceFirst(fromMatch.group(0)!, ' ');
  }
  final toMatch =
      RegExp(r'\bto\s+(\S+(?:\s+\S+)?)', caseSensitive: false).firstMatch(text);
  if (toMatch != null) {
    toRaw = (toMatch.group(1) ?? '').replaceFirst(
      RegExp('\\s+from\\s+$_chainWord\\s*\$', caseSensitive: false),
      '',
    );
    text = text.replaceFirst(toMatch.group(0)!, ' ');
  }
  text = text.replaceAll(RegExp(r'\s+'), ' ').trim();

  final sendRe = RegExp(
    '\\bsend\\s+\\\$?\\s*([\\d,]+(?:\\.\\d+)?)\\s*($_assetWord|\\\$)?',
    caseSensitive: false,
  );
  final m = sendRe.firstMatch(text) ?? sendRe.firstMatch(trimmed);
  final amount = double.tryParse(
    (m?.group(1) ?? '').replaceAll(RegExp(r'[$,]'), ''),
  );
  final asset = _normalizeIntentAsset(m?.group(2) ?? 'USDC');
  final chain = _normalizeIntentChain(fromChain);
  final recipient = _classifyRecipient(
    toRaw,
    peerHandle: threadContext?['peerHandle']?.toString(),
    peerAddress: threadContext?['peerAddress']?.toString(),
  );

  if (toRaw != null &&
      _phoneRe.hasMatch(toRaw.replaceAll(RegExp(r'[\s()-]'), ''))) {
    return unclear(
      0.3,
      "Phone numbers aren't payees. Use @username, email, or a 0x address.",
      amount: amount,
      asset: asset,
      chain: chain,
    );
  }

  if (amount == null || amount <= 0) {
    return unclear(
      0.35,
      'How much should I send, and in which asset?',
      asset: asset,
      chain: chain,
      to: recipient.to,
      toType: recipient.toType,
    );
  }
  if (recipient.toType == 'address' &&
      recipient.to != null &&
      recipient.to!.length != 42) {
    return unclear(
      0.55,
      "That looks like an address but it isn't 42 characters. Paste the full 0x address.",
      amount: amount,
      asset: asset,
      chain: chain,
      to: recipient.to,
      toType: 'address',
    );
  }

  return SendIntent(
    intent: 'send',
    amount: amount,
    asset: asset,
    chain: chain,
    to: recipient.to,
    toType: recipient.toType,
    confidence: strict ? 0.95 : (recipient.toType == 'thread' ? 0.82 : 0.9),
    needsConfirmation: true,
    originalMessage: original,
  );
}

bool looksLikeMoneyCommand(String text) {
  final t = text.trim().toLowerCase();
  if (!t.startsWith('@.')) return false;
  return RegExp(r'@\.\s*(buy|swap|bridge|deposit|spend|compose)\b').hasMatch(t);
}

/// Maps casual chain names → App Kit chain ids.
String? normalizeAppKitChain(String? raw) {
  if (raw == null || raw.trim().isEmpty) return null;
  final x = raw.trim().toLowerCase().replaceAll(' ', '_');
  switch (x) {
    case 'arc':
    case 'arc_testnet':
    case 'arctestnet':
      return 'Arc_Testnet';
    case 'base':
    case 'base_sepolia':
    case 'basesepolia':
      return 'Base_Sepolia';
    case 'eth':
    case 'ethereum':
    case 'sepolia':
    case 'ethereum_sepolia':
      return 'Ethereum_Sepolia';
    case 'arb':
    case 'arbitrum':
    case 'arbitrum_sepolia':
      return 'Arbitrum_Sepolia';
    case 'avax':
    case 'avalanche':
    case 'fuji':
    case 'avalanche_fuji':
      return 'Avalanche_Fuji';
    case 'sol':
    case 'solana':
    case 'solana_devnet':
      return 'Solana_Devnet';
    default:
      // Pass through if already canonical
      if (raw.contains('_')) return raw;
      return raw;
  }
}

final _buyCmd = RegExp(
  r'''^\s*@\.\s*(buy|swap)\s+([\d,]+(?:\.\d+)?)\s*([a-zA-Z]+)?(?:\s+(?:to|for|->|→)\s*([a-zA-Z]+))?(?:\s+(.*))?\s*$''',
  caseSensitive: false,
);

final _bridgeCmd = RegExp(
  r'''^\s*@\.\s*bridge\s+([\d,]+(?:\.\d+)?)\s*(?:usdc)?\s*(?:to\s+)?([a-zA-Z0-9_\-]+)?(?:\s+(.*))?\s*$''',
  caseSensitive: false,
);

final _depositCmd = RegExp(
  r'''^\s*@\.\s*deposit\s+([\d,]+(?:\.\d+)?)\s*(?:usdc)?(?:\s+from\s+([a-zA-Z0-9_\-]+))?(?:\s+(.*))?\s*$''',
  caseSensitive: false,
);

final _composeCmd = RegExp(
  r'''^\s*@\.\s*compose\b(.*)$''',
  caseSensitive: false,
);

MoneyCommand? parseMoneyCommand(String text) {
  final t = text.trim();
  final buy = _buyCmd.firstMatch(t);
  if (buy != null) {
    final amount = double.tryParse((buy.group(2) ?? '').replaceAll(',', ''));
    if (amount == null || amount <= 0) return null;
    final tokenIn = (buy.group(3) ?? 'usdc').toUpperCase();
    final tokenOut = (buy.group(4) ?? 'eurc').toUpperCase();
    return MoneyCommand(
      action: buy.group(1)!.toLowerCase() == 'buy' ? 'buy' : 'swap',
      amount: amount,
      tokenIn: tokenIn == 'EUR' ? 'USDC' : tokenIn,
      tokenOut: tokenOut == 'EUR' ? 'EURC' : tokenOut,
      description: (buy.group(5) ?? '').trim(),
    );
  }

  final bridge = _bridgeCmd.firstMatch(t);
  if (bridge != null && t.toLowerCase().contains('bridge')) {
    final amount = double.tryParse((bridge.group(1) ?? '').replaceAll(',', ''));
    if (amount == null || amount <= 0) return null;
    return MoneyCommand(
      action: 'bridge',
      amount: amount,
      tokenIn: 'USDC',
      toChain: normalizeAppKitChain(bridge.group(2) ?? 'Base_Sepolia'),
      description: (bridge.group(3) ?? '').trim(),
    );
  }

  final deposit = _depositCmd.firstMatch(t);
  if (deposit != null && t.toLowerCase().contains('deposit')) {
    final amount =
        double.tryParse((deposit.group(1) ?? '').replaceAll(',', ''));
    if (amount == null || amount <= 0) return null;
    return MoneyCommand(
      action: 'deposit',
      amount: amount,
      tokenIn: 'USDC',
      fromChain: normalizeAppKitChain(deposit.group(2) ?? 'Arc_Testnet') ??
          'Arc_Testnet',
      description: (deposit.group(3) ?? '').trim(),
    );
  }

  final compose = _composeCmd.firstMatch(t);
  if (compose != null) {
    // Lightweight: amount from first number if present; client fills compose body.
    final nums = RegExp(r'([\d,]+(?:\.\d+)?)').firstMatch(t);
    final amount =
        double.tryParse((nums?.group(1) ?? '0').replaceAll(',', '')) ?? 0;
    return MoneyCommand(
      action: 'compose',
      amount: amount > 0 ? amount : 1,
      description: (compose.group(1) ?? '').trim(),
    );
  }

  return null;
}

SendCommand? parseSendCommand(String text) {
  final m = _cmd.firstMatch(text.trim()) ?? _cmdLoose.firstMatch(text.trim());
  if (m == null) return null;

  final rawAmount = m.group(1)?.replaceAll(',', '') ?? '';
  final amount = double.tryParse(rawAmount);
  if (amount == null || amount <= 0) return null;

  var currency = (m.group(2) ?? 'ngn').trim().toLowerCase();
  currency = _normalizeCurrency(currency);

  String? handle;
  String desc = '';

  if (m.groupCount >= 3) {
    handle = m.group(3);
    if (handle != null && handle.startsWith('@')) {
      handle = handle.substring(1);
    }
  }
  if (m.groupCount >= 4) {
    desc = (m.group(4) ?? '').trim();
    // strip leading "with description" artifacts
    desc = desc
        .replaceFirst(
            RegExp(r'^(with\s+description|for|desc)\s+', caseSensitive: false),
            '')
        .trim();
  }

  // If currency token was actually part of description
  if (currency == 'ngn' && (m.group(2) == null || m.group(2)!.trim().isEmpty)) {
    currency = 'ngn';
  }

  return SendCommand(
    amount: amount,
    currency: currency,
    description: desc,
    recipientHandle: handle,
  );
}

String _normalizeCurrency(String c) {
  final x = c
      .toLowerCase()
      .replaceAll('₦', 'ngn')
      .replaceAll('€', 'eur')
      .replaceAll('\$', 'usd');
  if (x.isEmpty) return 'ngn';
  if (x.startsWith('nair') || x == 'ngn' || x == 'n') return 'ngn';
  if (x == 'eurc' || x.startsWith('eur') || x == 'e') {
    return x == 'eurc' ? 'eurc' : 'eur';
  }
  if (x == 'cirbtc' || x == 'cbtc' || x == 'btc' || x.contains('bitcoin')) {
    return 'cirbtc';
  }
  if (x == 'usdc' ||
      x == 'usd' ||
      x == 'u' ||
      x == 'dollar' ||
      x == 'dollars') {
    return x == 'usdc' ? 'usdc' : 'usd';
  }
  // unknown word — treat as ngn and leave word for description upstream
  return 'ngn';
}
