import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/api_client.dart';
import '../utils/text_safe.dart';
import '../fx/fx_service.dart';
import '../notify/section_notify.dart';
import '../utils/money_format.dart';
import '../wallet/circle_wallet_service.dart';
import 'chat_models.dart';
import 'command_parser.dart';

/// Prefer a real explorer `0x` hash. Never surface a Circle activity UUID.
String? explorerTxHash(Map<String, dynamic>? data) {
  if (data == null) return null;
  const keys = [
    'txHash',
    'hash',
    'burnTxHash',
    'mintTx',
    'transactionHash',
    'sourceTxHash',
    'fundTxHash',
  ];
  for (final k in keys) {
    final v = data[k]?.toString();
    if (v != null && v.startsWith('0x') && v.length >= 42) return v;
  }
  // `meta` matters: an App Kit job carries its settled hash there, so leaving
  // it out made a completed send look like it had never produced one.
  for (final nestedKey in ['result', 'receipt', 'job', 'data', 'meta']) {
    final nested = data[nestedKey];
    if (nested is Map) {
      final found = explorerTxHash(Map<String, dynamic>.from(nested));
      if (found != null) return found;
    }
  }
  return null;
}

/// Chat backed by Evabob API. Money commands use real Circle UCW sends.
class ChatService extends ChangeNotifier {
  ChatService(FxService fx, this._api, {SectionNotify? notify})
      : _notify = notify {
    // Fx retained for constructor compatibility with MultiProvider wiring.
    // Naira display was removed; token amounts are shown directly.
    assert(fx.usdToNgn > 0 || true);
  }

  final ApiClient _api;
  final SectionNotify? _notify;

  List<ChatThread> threads = [];
  final Map<String, List<ChatMessage>> _messages = {};
  bool loading = false;
  String? _agentJobInFlight;

  /// Placeholder "use @. to send money" once per calendar day.
  bool showMoneyHint = false;

  List<ChatMessage> messagesFor(String threadId) =>
      List.unmodifiable(_messages[threadId] ?? const []);

  /// The conversation on screen, if any: its messages refresh live and it
  /// raises no badge or notification.
  String? openThreadId;

  ChatThread? threadById(String id) {
    for (final t in threads) {
      if (t.id == id) return t;
    }
    return null;
  }

  /// Marks a conversation read when it is opened.
  void markRead(String threadId) {
    final i = threads.indexWhere((t) => t.id == threadId);
    if (i < 0 || threads[i].unread == 0) return;
    threads[i] = threads[i].copyWith(unread: 0);
    notifyListeners();
  }

  /// Whether an alert deserves a notification while the app is open: not for
  /// the conversation the person is already reading.
  bool shouldNotify(Map<String, dynamic> alert) =>
      !(alert['kind'] == 'chat_message' &&
          alert['threadId']?.toString() == openThreadId);

  /// Alerts from the person's own channel (live, or by push).
  ///
  /// Nothing used to tell the app a message had arrived unless that exact
  /// conversation was open, so the Chat tab never showed anything. And nothing
  /// told it when someone changed their name or picture.
  void onAlert(Map<String, dynamic> alert) {
    final kind = alert['kind']?.toString();
    final threadId = alert['threadId']?.toString();
    switch (kind) {
      case 'chat_message':
        if (threadId != null && threadId == openThreadId) {
          loadMessages(threadId);
        } else {
          if (threadId != null) {
            final i = threads.indexWhere((t) => t.id == threadId);
            if (i >= 0) {
              threads[i] = threads[i].copyWith(
                unread: threads[i].unread + 1,
                subtitle: alert['body']?.toString(),
              );
            }
          }
          _notify?.bump('chat');
          notifyListeners();
          refreshThreads();
        }
      case 'request_update':
        if (threadId != null && _messages.containsKey(threadId)) {
          loadMessages(threadId);
        }
      case 'profile_updated':
        refreshThreads();
    }
  }

  Future<void> refreshMoneyHint() async {
    final prefs = await SharedPreferences.getInstance();
    final today = DateTime.now().toIso8601String().substring(0, 10);
    final last = prefs.getString('chat_money_hint_day');
    showMoneyHint = last != today;
    notifyListeners();
  }

  Future<void> dismissMoneyHint() async {
    final prefs = await SharedPreferences.getInstance();
    final today = DateTime.now().toIso8601String().substring(0, 10);
    await prefs.setString('chat_money_hint_day', today);
    showMoneyHint = false;
    notifyListeners();
  }

  Future<void> refreshThreads() async {
    loading = true;
    notifyListeners();
    try {
      final data = await _api.get('/v1/chat/threads');
      final list = data['threads'] as List? ?? [];
      // Unread counts live here, not on the server; keep them across reloads.
      final unread = {for (final t in threads) t.id: t.unread};
      threads = list.map((raw) {
        final t = ChatThread.fromJson(Map<String, dynamic>.from(raw as Map));
        return t.copyWith(unread: unread[t.id] ?? 0);
      }).toList();
      threads.sort((a, b) {
        if (a.isAgent && !b.isAgent) return -1;
        if (!a.isAgent && b.isAgent) return 1;
        return 0;
      });
    } catch (e) {
      debugPrint('chat threads: $e');
      if (threads.isEmpty) {
        threads = const [
          ChatThread(
            id: 't_evabob_agent',
            title: 'evabob Agent',
            subtitle: 'Offline — start API (server npm run dev)',
            handle: 'evabob',
            isAgent: true,
          ),
          ChatThread(
            id: 't_adaobi',
            title: 'Adaobi',
            subtitle: 'Offline — start API (server npm run dev)',
            handle: 'adaobi',
          ),
        ];
      }
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  /// Start a thread by @username / name / phone contact string.
  Future<ChatThread?> startThread({required String peer}) async {
    final data = await _api.post('/v1/chat/threads', body: {
      'peer': peer.trim(),
    });
    final j = Map<String, dynamic>.from(data['thread'] as Map? ?? {});
    if (j.isEmpty) return null;
    final parsed = ChatThread.fromJson(j, fallbackTitle: peer);
    final t = parsed.subtitle.isEmpty
        ? parsed.copyWith(subtitle: 'New conversation')
        : parsed;
    final idx = threads.indexWhere((x) => x.id == t.id);
    if (idx >= 0) {
      threads[idx] = t;
    } else {
      threads.insert(0, t);
    }
    // (own action: no unread badge)
    notifyListeners();
    return t;
  }

  Future<bool> acceptThread(String threadId) async {
    final data = await _api.post('/v1/chat/threads/$threadId/accept');
    final raw = data['thread'];
    if (raw is! Map) return false;
    final accepted = ChatThread.fromJson(Map<String, dynamic>.from(raw));
    final index = threads.indexWhere((thread) => thread.id == threadId);
    if (index >= 0) threads[index] = accepted;
    notifyListeners();
    return true;
  }

  Future<void> blockThread(String threadId) async {
    await _api.post('/v1/chat/threads/$threadId/block');
    threads.removeWhere((thread) => thread.id == threadId);
    _messages.remove(threadId);
    notifyListeners();
  }

  Future<void> reportThread(String threadId, String reason) async {
    await _api.post(
      '/v1/chat/threads/$threadId/report',
      body: {'reason': reason.trim()},
    );
  }

  Future<void> loadMessages(String threadId) async {
    try {
      final data = await _api.get('/v1/chat/threads/$threadId/messages');
      final list = data['messages'] as List? ?? [];
      _messages[threadId] = list.map((raw) {
        final j = Map<String, dynamic>.from(raw as Map);
        final kind = _kind(j['kind']?.toString());
        final text = j['text']?.toString() ?? '';
        final meta = j['meta'] is Map
            ? Map<String, dynamic>.from(j['meta'] as Map)
            : null;
        ReceiptData? receipt;
        // A request card is built by the server from the request itself; its
        // lines and status render from meta (see RequestCard).
        final isCard = meta?['type']?.toString() == 'invoice_card';
        if (kind == ChatMessageKind.receipt && !isCard) {
          final usdc = (meta?['amountUsdc'] as num?)?.toDouble();
          final amount = (meta?['amount'] as num?)?.toDouble() ?? usdc;
          final token = meta?['token']?.toString() ?? 'USDC';
          final when =
              j['createdAt']?.toString() ?? meta?['date']?.toString() ?? '';
          final isRequest = meta?['type']?.toString() == 'payment_request' ||
              meta?['kind']?.toString() == 'payment_request';
          receipt = ReceiptData(
            amountLabel: amount == null ? '' : formatMoney(amount, token),
            fxLabel: usdc != null && token == 'USDC'
                ? formatUsdc(usdc)
                : (isRequest
                    ? 'Payment request'
                    : token == 'EURC'
                        ? 'Euros'
                        : 'Bitcoin'),
            description: meta?['memo']?.toString() ??
                meta?['description']?.toString() ??
                '',
            statusLabel: isRequest
                ? (meta?['status']?.toString() ?? 'Request · unpaid')
                : 'Sent',
            peerName: meta?['receiver']?.toString(),
            sender: meta?['sender']?.toString(),
            receiver: meta?['receiver']?.toString(),
            hash: explorerTxHash(meta),
            dateLabel: when,
          );
        }
        return ChatMessage(
          id: j['id']?.toString() ?? '',
          threadId: threadId,
          senderId: j['senderId']?.toString() ?? '',
          kind: kind,
          text: text,
          receipt: receipt,
          meta: meta,
          createdAt: DateTime.tryParse(j['createdAt']?.toString() ?? '') ??
              DateTime.now(),
        );
      }).toList();
      notifyListeners();
    } catch (e) {
      debugPrint('load messages: $e');
    }
  }

  ChatMessageKind _kind(String? k) {
    switch (k) {
      case 'receipt':
        return ChatMessageKind.receipt;
      case 'system':
        return ChatMessageKind.system;
      default:
        return ChatMessageKind.text;
    }
  }

  bool isAgentThread(String threadId) {
    final t = threads.where((x) => x.id == threadId);
    return t.isNotEmpty && t.first.isAgent;
  }

  /// Agent chat turn: parse on the server, never auto-executes money.
  Future<void> sendAgentMessage({
    required String threadId,
    required String text,
  }) async {
    try {
      final recent = messagesFor(threadId);
      final history = recent
          .where((m) => (m.text ?? '').trim().isNotEmpty)
          .toList()
          .reversed
          .take(8)
          .toList()
          .reversed
          .map((m) {
        final assistant = m.kind == ChatMessageKind.system ||
            m.senderId == 'evabob-agent' ||
            m.senderId == 'sendit-agent';
        return {
          'role': assistant ? 'assistant' : 'user',
          'content': m.text!.trim(),
        };
      }).toList();
      await _api.post('/v1/agent/message', body: {
        'text': text,
        'threadId': threadId,
        if (history.isNotEmpty) 'history': history,
      });
    } catch (e) {
      debugPrint('agent message: $e');
      _localSystem(threadId, 'Agent unavailable: $e');
      return;
    }
    await loadMessages(threadId);
    // (own action: no unread badge)
  }

  bool _isAgentSelf(String? dest) {
    final d = (dest ?? '').replaceFirst('@', '').toLowerCase().trim();
    return d.isEmpty ||
        d == 'evabob' ||
        d == 'evabob-agent' ||
        d == 'sendit' ||
        d == 'sendit-agent';
  }

  /// After the user taps Confirm on an agent card, route to existing PIN flows.
  /// Returns true only when the action completed (so the card can be locked).
  Future<bool> executeAgentIntent({
    required String threadId,
    required Map<String, dynamic> intent,
    required Map<String, dynamic> route,
    required String myId,
    required String peerHandle,
    String? confirmMessageId,
    BuildContext? context,
    CircleWalletService? circle,
  }) async {
    final jobKey = confirmMessageId ?? '$threadId:${intent['intent']}';
    if (_agentJobInFlight != null) {
      _localSystem(
        threadId,
        'Already running a confirmed action. Wait for PIN to finish.',
      );
      return false;
    }
    _agentJobInFlight = jobKey;

    var claimed = false;
    if (confirmMessageId != null && confirmMessageId.isNotEmpty) {
      _patchMessage(threadId, confirmMessageId, {'status': 'executing'});
      final claim = await _agentConfirmAction(
        threadId: threadId,
        messageId: confirmMessageId,
        action: 'claim',
      );
      if (claim['already'] == true) {
        _agentJobInFlight = null;
        _localSystem(
          threadId,
          'This Confirm card is already in progress or done. Nothing moved.',
        );
        return false;
      }
      if (claim['ok'] == false) {
        _agentJobInFlight = null;
        _patchMessage(threadId, confirmMessageId, {'status': 'open'});
        _localSystem(
          threadId,
          'Could not lock this Confirm card. Try again — nothing moved.',
        );
        return false;
      }
      claimed = true;
    }

    try {
      if (context != null && !context.mounted) {
        return false;
      }
      return await _runAgentIntent(
        threadId: threadId,
        intent: intent,
        route: route,
        myId: myId,
        peerHandle: peerHandle,
        confirmMessageId: confirmMessageId,
        context: context,
        circle: circle,
        claimed: claimed,
      );
    } catch (e) {
      if (claimed && confirmMessageId != null && confirmMessageId.isNotEmpty) {
        await _agentConfirmAction(
          threadId: threadId,
          messageId: confirmMessageId,
          action: 'release',
        );
        _patchMessage(threadId, confirmMessageId, {'status': 'open'});
      }
      _localSystem(threadId, 'Confirm failed: $e');
      return false;
    } finally {
      _agentJobInFlight = null;
    }
  }

  Future<bool> _runAgentIntent({
    required String threadId,
    required Map<String, dynamic> intent,
    required Map<String, dynamic> route,
    required String myId,
    required String peerHandle,
    String? confirmMessageId,
    BuildContext? context,
    CircleWalletService? circle,
    required bool claimed,
  }) async {
    final name = intent['intent']?.toString() ?? '';
    final amount = (intent['amount'] as num?)?.toDouble();
    final asset = intent['asset']?.toString() ?? 'USDC';
    final token = route['token']?.toString() ??
        (asset == 'CBTC'
            ? 'CIRBTC'
            : asset == 'EURC'
                ? 'EURC'
                : 'USDC');
    final to = intent['to']?.toString();
    final recipients = (intent['recipients'] is List)
        ? (intent['recipients'] as List)
            .map((e) => e.toString())
            .where((e) => e.startsWith('0x') && e.length == 42)
            .toList()
        : const <String>[];

    var ok = false;
    if (name == 'invoice') {
      if (amount == null || amount <= 0) {
        _localSystem(threadId, 'Invoice needs an amount.');
      } else {
        ok = await sendPaymentRequest(
          threadId: threadId,
          myId: myId,
          amount: amount,
          token: token,
          description: intent['description']?.toString() ?? '',
        );
        if (ok) {
          _localSystem(
            threadId,
            'Invoice created for ${formatMoney(amount, token)}.',
          );
        }
      }
    } else if (name == 'escrow') {
      if (context == null || circle == null || amount == null) {
        _localSystem(threadId,
            'Tell me how much to hold, and set up your account first.');
      } else if (_isAgentSelf(to) && _isAgentSelf(peerHandle)) {
        _localSystem(
          threadId,
          'Who am I holding it for? Try: hold $amount for @handle',
        );
      } else {
        final dest = (to != null && to.isNotEmpty)
            ? to
            : (peerHandle.startsWith('@') ? peerHandle : '@$peerHandle');
        final res = await payPaymentRequest(
          context: context,
          circle: circle,
          threadId: threadId,
          myId: myId,
          peerHandle: dest.replaceFirst('@', ''),
          meta: {
            'amount': amount,
            'token': token,
            'description': intent['description'] ?? 'Agent escrow',
          },
          mode: 'escrow',
        );
        if (res['ok'] != true) {
          _localSystem(
            threadId,
            res['error']?.toString() ?? 'Escrow cancelled — no funds moved.',
          );
        } else {
          ok = true;
        }
      }
    } else if (name == 'send') {
      if (amount == null || amount <= 0) {
        _localSystem(threadId, 'Send needs an amount.');
      } else if (recipients.length > 1) {
        _localSystem(
          threadId,
          'Atomic batch sending is not ready yet. Send to one recipient at a '
          'time so a partially completed batch is never shown as successful.',
        );
      } else if (_isAgentSelf(to) && _isAgentSelf(peerHandle)) {
        _localSystem(
          threadId,
          'Who should I send to? Try: send ${formatMoney(amount, token)} to @handle',
        );
      } else {
        final dest = (to != null && to.isNotEmpty)
            ? to
            : (peerHandle.startsWith('@') ? peerHandle : '@$peerHandle');
        ok = await _executeSendCommand(
          threadId: threadId,
          cmd: SendCommand(
            amount: amount,
            currency: token.toLowerCase() == 'cirbtc'
                ? 'cirbtc'
                : token.toLowerCase() == 'eurc'
                    ? 'eurc'
                    : 'usdc',
            recipientHandle: dest.startsWith('@') ? dest.substring(1) : null,
          ),
          myId: myId,
          peerHandle: dest.replaceFirst('@', ''),
          context: context,
          circle: circle,
          destinationOverride: dest,
        );
      }
    } else if (name == 'bridge' ||
        name == 'buy' ||
        name == 'swap' ||
        name == 'deposit') {
      final fromChain = route['appKitChain']?.toString() ?? 'Arc_Testnet';
      final toChain = route['toAppKitChain']?.toString();
      if (name == 'bridge' && (toChain == null || toChain.isEmpty)) {
        _localSystem(
          threadId,
          'Bridge needs an explicit destination (Base or Ethereum). Nothing moved.',
        );
        return false;
      }
      ok = await _executeMoneyCommand(
        threadId: threadId,
        cmd: MoneyCommand(
          action: name == 'buy' ? 'swap' : name,
          amount: amount ?? 0,
          tokenIn:
              route['tokenIn']?.toString() ?? (name == 'buy' ? 'EURC' : 'USDC'),
          tokenOut: route['tokenOut']?.toString() ??
              (name == 'buy' ? 'USDC' : 'EURC'),
          fromChain: fromChain,
          toChain: toChain,
        ),
        context: context,
        circle: circle,
      );
    } else {
      _localSystem(threadId, 'I cannot run "$name" from this card.');
    }

    // Settling an invoice has to close it, or the person who raised it never
    // learns they were paid and the request sits open forever. Best-effort:
    // the money has already moved, so a failure to mark must not present as a
    // failed payment.
    final invoiceId = intent['invoiceId']?.toString();
    if (ok && name == 'send' && invoiceId != null && invoiceId.isNotEmpty) {
      final txHash = circle?.lastVerifiedTxHash;
      try {
        if (txHash == null) throw StateError('Payment hash is still pending');
        await _api.post('/v1/payment-requests/$invoiceId/mark', body: {
          'status': 'paid',
          'chosenStructure': 'full',
          'paidTxHash': txHash,
        });
      } catch (e) {
        debugPrint('mark invoice $invoiceId paid: $e');
      }
    }

    if (ok && confirmMessageId != null && confirmMessageId.isNotEmpty) {
      await markAgentConfirmed(
        threadId: threadId,
        messageId: confirmMessageId,
      );
    } else if (!ok &&
        claimed &&
        confirmMessageId != null &&
        confirmMessageId.isNotEmpty) {
      await _agentConfirmAction(
        threadId: threadId,
        messageId: confirmMessageId,
        action: 'release',
      );
      _patchMessage(threadId, confirmMessageId, {'status': 'open'});
    }
    return ok;
  }

  void _patchMessage(
    String threadId,
    String messageId,
    Map<String, dynamic> metaPatch, {
    String? text,
  }) {
    final list = _messages[threadId];
    if (list == null) return;
    final i = list.indexWhere((m) => m.id == messageId);
    if (i < 0) return;
    final m = list[i];
    final meta = Map<String, dynamic>.from(m.meta ?? {});
    meta.addAll(metaPatch);
    list[i] = ChatMessage(
      id: m.id,
      threadId: m.threadId,
      senderId: m.senderId,
      kind: m.kind,
      text: text ?? m.text,
      receipt: m.receipt,
      meta: meta,
      createdAt: m.createdAt,
    );
    notifyListeners();
  }

  Future<Map<String, dynamic>> _agentConfirmAction({
    required String threadId,
    required String messageId,
    required String action,
  }) async {
    try {
      final data = await _api.post('/v1/agent/confirm', body: {
        'threadId': threadId,
        'messageId': messageId,
        'action': action,
      });
      return Map<String, dynamic>.from(data);
    } catch (e) {
      debugPrint('agent confirm $action: $e');
      return {'ok': false, 'error': e.toString()};
    }
  }

  Future<void> markAgentConfirmed({
    required String threadId,
    required String messageId,
  }) async {
    _patchMessage(threadId, messageId, {
      'confirmed': true,
      'status': 'done',
    });
    await _agentConfirmAction(
      threadId: threadId,
      messageId: messageId,
      action: 'done',
    );
  }

  Future<void> send({
    required String threadId,
    required String rawText,
    required String myId,
    String? peerName,
    String? peerHandle,
    BuildContext? context,
    CircleWalletService? circle,
    bool isAgent = false,
  }) async {
    final text = rawText.trim();
    if (text.isEmpty) return;

    if (isAgent || isAgentThread(threadId)) {
      await sendAgentMessage(threadId: threadId, text: text);
      return;
    }

    if (looksLikeSendCommand(text)) {
      final cmd = parseSendCommand(text);
      if (cmd == null) {
        _localSystem(
          threadId,
          'Couldn’t read that send command. Try:\n@. send 5 usdc\n@. send 2 eurc\n@. send 0.001 cirbtc',
        );
        return;
      }
      await _executeSendCommand(
        threadId: threadId,
        cmd: cmd,
        myId: myId,
        peerHandle: peerHandle ?? cmd.recipientHandle ?? peerName ?? 'user',
        context: context,
        circle: circle,
      );
      return;
    }

    if (looksLikeMoneyCommand(text)) {
      final cmd = parseMoneyCommand(text);
      if (cmd == null) {
        _localSystem(
          threadId,
          'Couldn’t read that command. Try:\n@. buy 10 usdc to eurc\n@. bridge 25 to base\n@. deposit 20\n@. compose spend 15 swap eurc bridge base',
        );
        return;
      }
      await _executeMoneyCommand(
        threadId: threadId,
        cmd: cmd,
        context: context,
        circle: circle,
      );
      return;
    }

    // Natural-language money stays in the agent thread (confirm card).
    // Peer chats only auto-run explicit `@.` commands.

    try {
      await _api.post('/v1/chat/threads/$threadId/messages', body: {
        'text': text,
        'senderId': myId,
        'kind': 'text',
      });
    } catch (e) {
      debugPrint('chat send api: $e');
    }

    final msg = ChatMessage(
      id: DateTime.now().microsecondsSinceEpoch.toString(),
      threadId: threadId,
      senderId: myId,
      kind: ChatMessageKind.text,
      text: text,
      createdAt: DateTime.now(),
    );
    _messages.putIfAbsent(threadId, () => []).add(msg);
    _touchThread(threadId, text);
    // (own action: no unread badge)
    notifyListeners();
  }

  double _tokenAmount(SendCommand cmd) {
    switch (cmd.currency) {
      case 'eur':
      case 'eurc':
      case 'usdc':
      case 'usd':
      case 'cirbtc':
      case 'btc':
        return cmd.amount;
      default:
        // Unknown unit: treat as USDC amount (naira removed from app).
        return cmd.amount;
    }
  }

  Future<bool> _executeMoneyCommand({
    required String threadId,
    required MoneyCommand cmd,
    BuildContext? context,
    CircleWalletService? circle,
  }) async {
    if (context == null || circle == null) {
      _localSystem(
        threadId,
        'Your account is not set up yet. Open Profile to finish, then try again.',
      );
      return false;
    }

    _localSystem(
      threadId,
      '${cmd.action} ${cmd.amount} — confirm with your PIN…',
    );

    try {
      Map<String, dynamic> res;
      switch (cmd.action) {
        case 'buy':
        case 'swap':
          res = await circle.appKitSwap(
            context: context,
            tokenIn: cmd.tokenIn,
            tokenOut: cmd.tokenOut ?? 'EURC',
            amountIn: cmd.amount,
          );
          break;
        case 'bridge':
          res = await circle.appKitBridge(
            context: context,
            amount: cmd.amount,
            toChain: cmd.toChain ?? 'Base_Sepolia',
            fromChain: cmd.fromChain,
          );
          break;
        case 'deposit':
          res = await circle.appKitDeposit(
            context: context,
            amount: cmd.amount,
            chain: cmd.fromChain,
          );
          break;
        case 'compose':
          _localSystem(
            threadId,
            'Compose (spend + swap + bridge) is disabled so we never double-move funds. Run one action at a time.',
          );
          return false;
        default:
          res = {'ok': false, 'error': 'Unknown action ${cmd.action}'};
      }

      if (res['ok'] != true) {
        _localSystem(
          threadId,
          res['error']?.toString() ??
              'That did not go through. No money moved.',
        );
        return false;
      }

      final tx = explorerTxHash(res);
      final msg = ChatMessage(
        id: DateTime.now().microsecondsSinceEpoch.toString(),
        threadId: threadId,
        senderId: 'system',
        kind: ChatMessageKind.receipt,
        text: '${cmd.action} done',
        receipt: ReceiptData(
          amountLabel: '${cmd.amount} ${cmd.tokenIn}',
          fxLabel: cmd.action,
          description: cmd.description.isEmpty ? 'Sent' : cmd.description,
          statusLabel: 'Done',
          peerName: cmd.toChain ?? cmd.tokenOut ?? cmd.action,
          hash: tx,
          dateLabel: DateTime.now().toIso8601String(),
        ),
        meta: {
          if (tx != null) 'txHash': tx,
          if (tx != null) 'hash': tx,
          'jobId': res['jobId'],
        },
        createdAt: DateTime.now(),
      );
      _messages.putIfAbsent(threadId, () => []).add(msg);
      _touchThread(threadId, msg.text ?? 'Receipt');
      // (own action: no unread badge)
      notifyListeners();
      return true;
    } catch (e) {
      debugPrint('money command: $e');
      _localSystem(
          threadId, friendlyError(e, fallback: 'That did not go through.'));
      return false;
    }
  }

  Future<bool> _executeSendCommand({
    required String threadId,
    required SendCommand cmd,
    required String myId,
    required String peerHandle,
    BuildContext? context,
    CircleWalletService? circle,
    String? destinationOverride,
  }) async {
    final amountToken = _tokenAmount(cmd);
    final token = cmd.token;
    final to = (destinationOverride != null && destinationOverride.isNotEmpty)
        ? destinationOverride
        : cmd.recipientHandle != null
            ? '@${cmd.recipientHandle}'
            : (peerHandle.startsWith('@') ? peerHandle : '@$peerHandle');

    if (context == null || circle == null) {
      _localSystem(
        threadId,
        'Wallet not ready for on-chain send. Open Profile → Set up wallet, then try again.',
      );
      return false;
    }

    _localSystem(
      threadId,
      'Confirm with PIN to send ${formatMoney(amountToken, token)}…',
    );

    try {
      final res = await circle.send(
        context: context,
        to: to,
        amountUsdc: amountToken,
        token: token,
        memo: cmd.description.isEmpty ? null : cmd.description,
      );

      if (res['ok'] != true) {
        _localSystem(
          threadId,
          res['error']?.toString() ??
              'Send cancelled or failed — no funds moved, no receipt.',
        );
        return false;
      }

      final activityId = res['activityId']?.toString();
      final dest = res['destinationAddress']?.toString();
      final tx = explorerTxHash(res);
      final data = await _api.post(
        '/v1/chat/threads/$threadId/send-command',
        body: {
          'amountUsdc': amountToken,
          'memo': cmd.description,
          'peerHandle': peerHandle,
          'myId': myId,
          'token': token,
          'confirmed': true,
          if (activityId != null) 'activityId': activityId,
          if (tx != null) 'txHash': tx,
          if (dest != null) 'destinationAddress': dest,
        },
      );
      final r = Map<String, dynamic>.from(data['receipt'] as Map? ?? {});
      final meta = r['meta'] is Map
          ? Map<String, dynamic>.from(r['meta'] as Map)
          : <String, dynamic>{};
      final hash =
          explorerTxHash({...meta, ...res}) ?? explorerTxHash(meta) ?? tx;
      final when =
          r['createdAt']?.toString() ?? DateTime.now().toIso8601String();
      final msg = ChatMessage(
        id: r['id']?.toString() ??
            DateTime.now().microsecondsSinceEpoch.toString(),
        threadId: threadId,
        // Keep on sender's side of the thread (not always right via system).
        senderId: myId,
        kind: ChatMessageKind.receipt,
        text: r['text']?.toString(),
        receipt: ReceiptData(
          amountLabel: formatMoney(amountToken, token),
          fxLabel: formatMoney(amountToken, token),
          description: cmd.description,
          statusLabel: 'Sent',
          peerName: peerHandle,
          sender: meta['sender']?.toString(),
          receiver: meta['receiver']?.toString() ?? '@$peerHandle',
          hash: hash,
          dateLabel: when,
        ),
        meta: {
          ...meta,
          'token': token,
          'amount': amountToken,
          'hash': hash,
          'fromMe': true,
        },
        createdAt: DateTime.tryParse(when) ?? DateTime.now(),
      );
      // Remove the "Confirm with PIN…" system line
      final list = _messages[threadId] ?? [];
      if (list.isNotEmpty &&
          list.last.kind == ChatMessageKind.system &&
          (list.last.text?.contains('Confirm with PIN') ?? false)) {
        list.removeLast();
      }
      _messages.putIfAbsent(threadId, () => []).add(msg);
      _touchThread(threadId, 'Receipt · ${formatMoney(amountToken, token)}');
      // (own action: no unread badge)
      _notify?.bump('activity');
      HapticFeedback.mediumImpact();
      notifyListeners();
      return true;
    } catch (e) {
      _localSystem(threadId, 'On-chain send failed: $e');
      return false;
    }
  }

  void _localSystem(String threadId, String text) {
    _messages.putIfAbsent(threadId, () => []).add(
          ChatMessage(
            id: DateTime.now().microsecondsSinceEpoch.toString(),
            threadId: threadId,
            senderId: 'system',
            kind: ChatMessageKind.system,
            text: text,
            createdAt: DateTime.now(),
          ),
        );
    notifyListeners();
  }

  void _touchThread(String threadId, String subtitle) {
    final i = threads.indexWhere((t) => t.id == threadId);
    if (i >= 0) {
      final t = threads[i];
      threads[i] = t.copyWith(subtitle: subtitle, unread: 0);
    }
  }

  /// Sends a photo into a chat. Returns null when it went, or what went wrong.
  Future<String?> sendPhoto({
    required String threadId,
    required String base64,
    required String mime,
    String caption = '',
  }) async {
    try {
      await _api.post('/v1/chat/threads/$threadId/photo', body: {
        'imageBase64': base64,
        'mime': mime,
        if (caption.trim().isNotEmpty) 'caption': caption.trim(),
      });
      await loadMessages(threadId);
      _touchThread(threadId, caption.trim().isEmpty ? '📷 Photo' : caption.trim());
      notifyListeners();
      return null;
    } catch (e) {
      return friendlyError(e);
    }
  }

  /// Create a payment request and post it into the chat thread immediately.
  Future<bool> sendPaymentRequest({
    required String threadId,
    required String myId,
    required double amount,
    required String token,
    String description = '',
  }) async {
    try {
      final created = await _api.post('/v1/payment-requests', body: {
        'amount': amount,
        'token': token,
        'description': description,
      });
      final requestId = created['id']?.toString() ?? '';
      if (requestId.isEmpty) return false;
      // The server posts the card, so both people see it — and it is built
      // from the request itself. The app used to post it as a receipt, which
      // the server rightly refuses from a client, and then showed a copy only
      // on the sender's phone.
      await _api.post('/v1/chat/threads/$threadId/request', body: {
        'requestId': requestId,
      });
      await loadMessages(threadId);
      _touchThread(threadId,
          'Payment request · ${formatMoney(amount, token)}');
      return true;
    } catch (e) {
      _localSystem(threadId, 'Could not create request: $e');
      return false;
    }
  }

  /// Pay a chat payment request.
  /// [mode]: `instant` (100% now) | `split` (50% now + 50% escrow) | `escrow` (100% lock).
  Future<Map<String, dynamic>> payPaymentRequest({
    required BuildContext context,
    required CircleWalletService circle,
    required String threadId,
    required String myId,
    required String peerHandle,
    required Map<String, dynamic> meta,
    required String mode, // instant | split | escrow
  }) async {
    final amount = (meta['amount'] as num?)?.toDouble() ??
        (meta['amountUsdc'] as num?)?.toDouble() ??
        0;
    final token = meta['token']?.toString() ?? 'USDC';
    final description =
        meta['description']?.toString() ?? meta['memo']?.toString() ?? '';
    final requestId = meta['requestId']?.toString();
    if (amount <= 0) {
      return {'ok': false, 'error': 'Invalid amount'};
    }
    final to = peerHandle.startsWith('@') ? peerHandle : '@$peerHandle';

    void markRequestLocal(String statusLabel) {
      if (requestId == null) return;
      final list = _messages[threadId] ?? [];
      for (var i = 0; i < list.length; i++) {
        final m = list[i];
        final rid =
            m.meta?['requestId']?.toString() ?? m.meta?['id']?.toString();
        final isReq = m.meta?['type']?.toString() == 'payment_request' ||
            m.meta?['kind']?.toString() == 'payment_request';
        if (isReq && (rid == requestId || m.meta?['requestId'] == requestId)) {
          final meta = Map<String, dynamic>.from(m.meta ?? {});
          meta['status'] = statusLabel;
          list[i] = ChatMessage(
            id: m.id,
            threadId: m.threadId,
            senderId: m.senderId,
            kind: m.kind,
            text: m.text,
            receipt: m.receipt == null
                ? null
                : ReceiptData(
                    amountLabel: m.receipt!.amountLabel,
                    fxLabel: m.receipt!.fxLabel,
                    description: m.receipt!.description,
                    statusLabel: statusLabel,
                    peerName: m.receipt!.peerName,
                    sender: m.receipt!.sender,
                    receiver: m.receipt!.receiver,
                    hash: m.receipt!.hash,
                    dateLabel: m.receipt!.dateLabel,
                  ),
            meta: meta,
            createdAt: m.createdAt,
          );
        }
      }
      notifyListeners();
    }

    Future<bool> markRequestServer(
      String status, {
      String? paidTxHash,
      String? escrowTxHash,
      String? chosenStructure,
      double? instantPaidUsdc,
      double? escrowLockedUsdc,
    }) async {
      if (requestId == null) return false;
      try {
        await _api.post('/v1/payment-requests/$requestId/mark', body: {
          'status': status,
          'threadId': threadId,
          if (paidTxHash != null) 'paidTxHash': paidTxHash,
          if (escrowTxHash != null) 'escrowTxHash': escrowTxHash,
          if (chosenStructure != null) 'chosenStructure': chosenStructure,
          if (instantPaidUsdc != null) 'instantPaidUsdc': instantPaidUsdc,
          if (escrowLockedUsdc != null) 'escrowLockedUsdc': escrowLockedUsdc,
        });
        return true;
      } catch (e) {
        debugPrint('mark request: $e');
        return false;
      }
    }

    /// Real lock: UCW send USDC → platform hold, then create escrow job.
    /// Locks the money in the escrow contract until the payer releases it.
    ///
    /// This used to send USDC to a platform hold wallet and write a ledger
    /// row, so "held" meant only that the server said so, and releasing paid
    /// the recipient out of the ops wallet. Now it is a real on-chain hold the
    /// payer funded: releasing pays the recipient, and if nobody ever releases
    /// it the contract refunds the payer without anyone having to act.
    Future<Map<String, dynamic>> fundEscrow(double lockAmount) async {
      // The contract releases to whoever the identity registry resolves, so
      // the payee must be an identity. A raw wallet address has no identity
      // key and the hold could never be claimed.
      if (to.startsWith('0x')) {
        return {
          'ok': false,
          'error':
              'Holding money needs a @handle or an email address, not a wallet address.',
        };
      }

      final held = await circle.holdForRecipient(
        context: context,
        recipient: to,
        amountUsdc: lockAmount,
        purpose: 'job',
        memo: description.isEmpty ? 'Chat payment request' : description,
      );
      if (held['ok'] != true) {
        return {
          'ok': false,
          'error': held['error']?.toString() ?? 'Could not hold that payment',
        };
      }

      final id = held['transferId']?.toString() ?? '';
      final txHash = held['txHash']?.toString();
      final msg = ChatMessage(
        id: DateTime.now().microsecondsSinceEpoch.toString(),
        threadId: threadId,
        senderId: myId,
        kind: ChatMessageKind.receipt,
        text: 'Held until you release it',
        receipt: ReceiptData(
          amountLabel: formatMoney(lockAmount, token),
          fxLabel: mode == 'split' ? 'half held' : 'held',
          description: description,
          statusLabel: 'Held · release when the work arrives',
          peerName: peerHandle,
          hash: txHash ?? id,
          dateLabel: DateTime.now().toIso8601String(),
        ),
        meta: {
          'fromMe': true,
          'type': 'escrow',
          'mode': mode == 'split' ? 'split_escrow' : 'full_escrow',
          'status': 'Held · release when the work arrives',
          'transferId': id,
          'token': token,
          'amount': lockAmount,
          if (txHash != null) 'fundTxHash': txHash,
          if (held['expiresAt'] != null) 'expiresAt': held['expiresAt'],
          if (requestId != null) 'requestId': requestId,
        },
        createdAt: DateTime.now(),
      );
      try {
        await _api.post('/v1/chat/threads/$threadId/messages', body: {
          'text': 'Held ${formatMoney(lockAmount, token)} for $peerHandle',
          'senderId': myId,
          'kind': 'receipt',
          'meta': msg.meta,
        });
      } catch (_) {}
      _messages.putIfAbsent(threadId, () => []).add(msg);
      markRequestLocal('Request · held');
      _touchThread(threadId, 'Held ${formatMoney(lockAmount, token)}');
      // (own action: no unread badge)
      _notify?.bump('activity');
      notifyListeners();
      return {'ok': true, 'mode': mode, 'transferId': id, ...held};
    }

    if (mode == 'escrow') {
      try {
        final out = await fundEscrow(amount);
        if (out['ok'] == true) {
          await markRequestServer(
            'escrow',
            escrowTxHash: explorerTxHash(out),
            chosenStructure: 'escrow',
            escrowLockedUsdc: amount,
          );
        }
        return out;
      } catch (e) {
        return {'ok': false, 'error': e.toString()};
      }
    }

    if (mode == 'split') {
      final half = double.parse((amount / 2).toStringAsFixed(6));
      final instant = double.parse((amount - half).toStringAsFixed(6));
      final res = await circle.send(
        context: context,
        to: to,
        amountUsdc: instant,
        token: token,
        memo: description.isEmpty
            ? 'Payment request (50% now)'
            : '$description (50% now)',
      );
      if (res['ok'] != true) {
        return {
          'ok': false,
          'error': res['error']?.toString() ?? 'Instant half failed',
        };
      }
      try {
        final escrowOut = await fundEscrow(half);
        if (escrowOut['ok'] != true) {
          return {
            'ok': false,
            'error':
                'The first half was sent. We could not hold the second half — '
                    'try holding it again.',
            'instantHalf': instant,
          };
        }
        await markRequestServer(
          'escrow',
          paidTxHash: explorerTxHash(res),
          escrowTxHash: explorerTxHash(escrowOut),
          chosenStructure: 'split',
          instantPaidUsdc: instant,
          escrowLockedUsdc: half,
        );
        final paidMsg = ChatMessage(
          id: DateTime.now().microsecondsSinceEpoch.toString(),
          threadId: threadId,
          senderId: myId,
          kind: ChatMessageKind.receipt,
          text: 'Paid 50% now',
          receipt: ReceiptData(
            amountLabel: formatMoney(instant, token),
            fxLabel: 'Half now, half held',
            description: description,
            statusLabel: 'Paid · 50% instant',
            peerName: peerHandle,
            hash: explorerTxHash(res),
            dateLabel: DateTime.now().toIso8601String(),
          ),
          meta: {
            'fromMe': true,
            'token': token,
            'amount': instant,
            'type': 'payment',
            'mode': 'split_instant',
          },
          createdAt: DateTime.now(),
        );
        try {
          await _api.post('/v1/chat/threads/$threadId/messages', body: {
            'text': 'Paid 50% · ${formatMoney(instant, token)}',
            'senderId': myId,
            'kind': 'receipt',
            'meta': paidMsg.meta,
          });
        } catch (_) {}
        _messages.putIfAbsent(threadId, () => []).add(paidMsg);
        markRequestLocal('Held for them');
        _touchThread(threadId, 'Split pay · ${formatMoney(amount, token)}');
        // (own action: no unread badge)
        notifyListeners();
        return {
          'ok': true,
          'mode': 'split',
          'instant': instant,
          ...escrowOut,
        };
      } catch (e) {
        return {
          'ok': false,
          'error': 'The first half was sent. We could not hold the second '
              'half — try holding it again.',
        };
      }
    }

    // Instant on-chain send (100% now)
    final res = await circle.send(
      context: context,
      to: to,
      amountUsdc: amount,
      token: token,
      memo: description.isEmpty ? 'Payment request' : description,
    );
    if (res['ok'] == true) {
      final marked = await markRequestServer(
        'paid',
        paidTxHash: explorerTxHash(res),
        chosenStructure: 'full',
        instantPaidUsdc: amount,
      );
      if (marked) markRequestLocal('Request · paid');
      final msg = ChatMessage(
        id: DateTime.now().microsecondsSinceEpoch.toString(),
        threadId: threadId,
        senderId: myId,
        kind: ChatMessageKind.receipt,
        text: 'Paid request',
        receipt: ReceiptData(
          amountLabel: formatMoney(amount, token),
          fxLabel: 'Instant pay',
          description: description,
          statusLabel: 'Paid · instant',
          peerName: peerHandle,
          hash: explorerTxHash(res),
          dateLabel: DateTime.now().toIso8601String(),
        ),
        meta: {
          'fromMe': true,
          'token': token,
          'amount': amount,
          'type': 'payment',
          if (requestId != null) 'requestId': requestId,
          if (explorerTxHash(res) != null) 'txHash': explorerTxHash(res),
          if (explorerTxHash(res) != null) 'hash': explorerTxHash(res),
        },
        createdAt: DateTime.now(),
      );
      try {
        await _api.post('/v1/chat/threads/$threadId/messages', body: {
          'text': 'Paid · ${formatMoney(amount, token)}',
          'senderId': myId,
          'kind': 'receipt',
          'meta': msg.meta,
        });
      } catch (_) {}
      _messages.putIfAbsent(threadId, () => []).add(msg);
      _touchThread(threadId, 'Paid · ${formatMoney(amount, token)}');
      // (own action: no unread badge)
      _notify?.bump('activity');
      notifyListeners();
    }
    return res;
  }

  /// Freelancer marks escrow job as delivered (submit deliverable).
  Future<void> markEscrowDelivered({
    required String threadId,
    required String jobId,
  }) async {
    final data = await _api.post('/v1/escrow/job/$jobId/submit', body: {
      'summary': 'Marked delivered in chat',
      'threadId': threadId,
      'deliverable': {
        'source': 'chat',
        'at': DateTime.now().toIso8601String(),
      },
    });
    final status = data['job'] is Map
        ? (data['job'] as Map)['status']?.toString()
        : 'submitted';
    _localSystem(threadId, 'Escrow $jobId · marked delivered ($status)');
    // Patch local receipt meta if present
    final list = _messages[threadId] ?? [];
    for (var i = 0; i < list.length; i++) {
      final m = list[i];
      final id = m.meta?['escrowJobId']?.toString() ?? m.meta?['jobId'];
      if (id == jobId) {
        final meta = Map<String, dynamic>.from(m.meta ?? {});
        meta['status'] = 'Escrow · submitted';
        list[i] = ChatMessage(
          id: m.id,
          threadId: m.threadId,
          senderId: m.senderId,
          kind: m.kind,
          text: m.text,
          receipt: m.receipt == null
              ? null
              : ReceiptData(
                  amountLabel: m.receipt!.amountLabel,
                  fxLabel: m.receipt!.fxLabel,
                  description: m.receipt!.description,
                  statusLabel: 'Escrow · submitted',
                  peerName: m.receipt!.peerName,
                  sender: m.receipt!.sender,
                  receiver: m.receipt!.receiver,
                  hash: m.receipt!.hash,
                  dateLabel: m.receipt!.dateLabel,
                ),
          meta: meta,
          createdAt: m.createdAt,
        );
      }
    }
    // (own action: no unread badge)
    notifyListeners();
  }

  /// The payer hands the held money to the person who did the work.
  ///
  /// Takes the on-chain transfer id, because that is what the contract
  /// understands. The old ledger job id named a row in a JSON file and a
  /// release paid the recipient out of the ops wallet; this releases the
  /// money the payer actually locked.
  Future<void> releaseEscrow({
    required String threadId,
    required String transferId,
  }) async {
    final data = await _api.post(
      '/v1/escrow/protected/$transferId/release',
      body: {},
    );
    if (data['error'] != null) throw Exception(data['error'].toString());
    final amount = (data['amountUsdc'] as num?)?.toDouble();
    _localSystem(
      threadId,
      amount == null
          ? 'Released to them'
          : 'Released ${amount.toStringAsFixed(2)} to them',
    );
    final list = _messages[threadId] ?? [];
    for (var i = 0; i < list.length; i++) {
      final m = list[i];
      final id = m.meta?['transferId']?.toString() ??
          m.meta?['escrowJobId']?.toString() ??
          m.meta?['jobId']?.toString();
      if (id == transferId) {
        final meta = Map<String, dynamic>.from(m.meta ?? {});
        meta['status'] = 'Released';
        list[i] = ChatMessage(
          id: m.id,
          threadId: m.threadId,
          senderId: m.senderId,
          kind: m.kind,
          text: m.text,
          receipt: m.receipt == null
              ? null
              : ReceiptData(
                  amountLabel: m.receipt!.amountLabel,
                  fxLabel: m.receipt!.fxLabel,
                  description: m.receipt!.description,
                  statusLabel: 'Escrow · released',
                  peerName: m.receipt!.peerName,
                  sender: m.receipt!.sender,
                  receiver: m.receipt!.receiver,
                  hash: m.receipt!.hash,
                  dateLabel: m.receipt!.dateLabel,
                ),
          meta: meta,
          createdAt: m.createdAt,
        );
      }
    }
    // (own action: no unread badge)
    _notify?.bump('activity');
    notifyListeners();
  }
}
