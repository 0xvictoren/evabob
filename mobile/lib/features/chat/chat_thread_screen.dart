import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:provider/provider.dart';

import '../../core/auth/evabob_auth.dart';
import '../../core/utils/text_safe.dart';
import '../../core/chat/chat_models.dart';
import '../../core/chat/chat_service.dart';
import '../../core/chat/pusher_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/widgets/confirm_action_dialog.dart';
import '../held/held_payment_screen.dart';
import '../../core/widgets/confirm_payment_sheet.dart';
import '../../core/widgets/family_code_sheet.dart';
import '../../core/widgets/contact_picker_sheet.dart';
import '../../core/widgets/glass.dart';
import '../../core/widgets/agent_avatar.dart';

class ChatThreadScreen extends StatefulWidget {
  const ChatThreadScreen({super.key, required this.thread});

  final ChatThread thread;

  @override
  State<ChatThreadScreen> createState() => _ChatThreadScreenState();
}

class _ChatThreadScreenState extends State<ChatThreadScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  String? _confirmingId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final chat = context.read<ChatService>();
      await chat.refreshMoneyHint();
      await chat.loadMessages(widget.thread.id);
      // Land on the newest message, not the oldest.
      _scrollToBottom();
      if (!mounted) return;
      final pusher = context.read<PusherService>();
      await pusher.subscribeChat(widget.thread.id, (_) {
        chat.loadMessages(widget.thread.id).then((_) {
          if (mounted) _scrollToBottom(animate: true);
        });
      });
    });
  }

  /// Pins the view to the newest message.
  ///
  /// Opening a thread used to leave you at the top, reading the oldest message
  /// in the conversation — only sending scrolled down. The list builds lazily,
  /// so the bottom is not known until after layout: this waits for the frame,
  /// then settles once more shortly after, because bubbles that size
  /// themselves (receipts, confirm cards) change the extent as they lay out.
  void _scrollToBottom({bool animate = false}) {
    void jump() {
      if (!mounted || !_scroll.hasClients) return;
      final target = _scroll.position.maxScrollExtent;
      if (animate) {
        _scroll.animateTo(
          target,
          duration: const Duration(milliseconds: 260),
          curve: Curves.easeOutCubic,
        );
      } else {
        _scroll.jumpTo(target);
      }
    }

    WidgetsBinding.instance.addPostFrameCallback((_) {
      jump();
      Future<void>.delayed(const Duration(milliseconds: 180), jump);
    });
  }

  @override
  void dispose() {
    try {
      context.read<PusherService>().unsubscribeChat(widget.thread.id);
    } catch (_) {}
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _input.text;
    _input.clear();
    final auth = context.read<EvabobAuth>();
    final chat = context.read<ChatService>();
    final circle = context.read<CircleWalletService>();
    // Use Circle/API user id so server senderId matches bubble alignment + peer sends.
    final myId = auth.circleUserId;
    // Peer is always the *other* party from thread metadata (server sets per-viewer).
    final peerHandle = (widget.thread.handle ?? widget.thread.title)
        .replaceFirst(RegExp(r'^@'), '')
        .trim();
    await chat.send(
      threadId: widget.thread.id,
      rawText: text,
      myId: myId,
      peerName: widget.thread.title,
      peerHandle: peerHandle.isEmpty ? widget.thread.title : peerHandle,
      context: context,
      circle: circle,
      isAgent: widget.thread.isAgent,
    );
    _scrollToBottom(animate: true);
  }

  Future<void> _openAttachMenu(String myId) async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (ctx) => Glass(
        heavy: true,
        borderRadius: 24,
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'Attach',
              style: TextStyle(
                fontWeight: FontWeight.w400,
                fontSize: 14,
                color: EvabobColors.navy,
              ),
            ),
            const SizedBox(height: 8),
            // Removed rather than left in place to announce that it does
            // nothing: its only behaviour was a snackbar saying so.
            ListTile(
              leading: const Icon(Icons.contacts_outlined),
              title: const Text('Contact'),
              onTap: () => Navigator.pop(ctx, 'contact'),
            ),
            ListTile(
              leading: const Icon(Icons.request_page_outlined),
              title: const Text('Request'),
              subtitle: const Text('Invoice amount + note into this chat'),
              onTap: () => Navigator.pop(ctx, 'request'),
            ),
          ],
        ),
      ),
    );
    if (!mounted || choice == null) return;

    if (choice == 'contact') {
      final picked = await ContactPickerSheet.open(context);
      if (picked != null && picked.isNotEmpty && mounted) {
        final cleaned = picked.replaceAll(RegExp(r'\s+'), '').trim();
        if (cleaned.isEmpty) return;
        if (!cleaned.contains('@') || cleaned.startsWith('@')) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Only emails from contacts can be pasted.'),
              behavior: SnackBarBehavior.floating,
            ),
          );
          return;
        }
        final cur = _input.text;
        setState(() {
          if (cur.trim().isEmpty) {
            _input.text = cleaned;
          } else {
            _input.text = '$cur $cleaned';
          }
          _input.selection = TextSelection.fromPosition(
            TextPosition(offset: _input.text.length),
          );
        });
      }
      return;
    }

    if (choice == 'request') {
      await _promptAndSendRequest(myId);
    }
  }

  Future<void> _promptAndSendRequest(String myId) async {
    final amountCtrl = TextEditingController();
    final descCtrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Payment request'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: amountCtrl,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(
                labelText: 'Amount',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: descCtrl,
              decoration: const InputDecoration(
                labelText: 'Description (optional)',
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Send request'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final amount = double.tryParse(amountCtrl.text.trim());
    if (amount == null || amount <= 0) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Enter a valid amount'),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    await context.read<ChatService>().sendPaymentRequest(
          threadId: widget.thread.id,
          myId: myId,
          amount: amount,
          token: 'USDC',
          description: descCtrl.text.trim(),
        );
    _scrollToBottom(animate: true);
  }

  Future<void> _payRequestMode(
    ChatMessage m,
    String myId,
    String mode,
  ) async {
    final meta = m.meta ?? {};
    final peerHandle = (widget.thread.handle ?? widget.thread.title)
        .replaceFirst(RegExp(r'^@'), '')
        .trim();
    final chat = context.read<ChatService>();
    final circle = context.read<CircleWalletService>();
    final res = await chat.payPaymentRequest(
      context: context,
      circle: circle,
      threadId: widget.thread.id,
      myId: myId,
      peerHandle: peerHandle.isEmpty ? widget.thread.title : peerHandle,
      meta: meta,
      mode: mode, // instant | split | escrow
    );
    if (!mounted) return;
    if (res['ok'] != true) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            friendlyError(
              res['error'],
              fallback: 'The payment did not go through.',
            ),
          ),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    final label = mode == 'instant'
        ? 'Paid in full'
        : mode == 'split'
            ? 'Half paid, half held until the work arrives'
            : 'Held until the work arrives';
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(label), behavior: SnackBarBehavior.floating),
    );
  }

  /// Asks how the payer wants to settle an invoice.
  ///
  /// Three genuinely different commitments, so each says what happens to the
  /// money rather than naming a mechanism. The word "escrow" appears nowhere:
  /// what matters to someone deciding is whether the money leaves now, and
  /// whether they can get it back.
  Future<void> _choosePayMode(ChatMessage m, String myId) async {
    final amount = (m.meta?['amount'] as num?)?.toDouble() ??
        (m.meta?['amountUsdc'] as num?)?.toDouble() ??
        0;
    final token = m.meta?['token']?.toString() ?? 'USDC';
    final symbol = token == 'EURC' ? '€' : r'$';
    String money(double v) => symbol + v.toStringAsFixed(2);

    final options = <(String, String, String)>[
      (
        'instant',
        'Pay it all now',
        '${money(amount)} leaves your balance and reaches them straight away.',
      ),
      (
        'split',
        'Pay half, hold half',
        '${money(amount / 2)} now, and ${money(amount / 2)} held until you say '
            'the work arrived.',
      ),
      (
        'escrow',
        'Hold it all',
        '${money(amount)} leaves your balance but only reaches them when you '
            'release it. It comes back to you if you never do.',
      ),
    ];

    final choice = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (ctx) => SafeArea(
        top: false,
        child: Container(
          margin: const EdgeInsets.all(Space.md),
          decoration: BoxDecoration(
            color: EvabobColors.sheet,
            borderRadius: Radii.all(Radii.lg),
            border: Border.all(color: EvabobColors.hairline),
            boxShadow: Shadows.raised,
          ),
          padding: const EdgeInsets.symmetric(vertical: Space.sm),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(
                    Space.lg, Space.md, Space.lg, Space.sm),
                child: Row(
                  children: [
                    Text(
                      'How do you want to pay?',
                      style:
                          Type.section.copyWith(color: EvabobColors.nearBlack),
                    ),
                    const Spacer(),
                    Text(
                      money(amount),
                      style:
                          Type.amount.copyWith(color: EvabobColors.nearBlack),
                    ),
                  ],
                ),
              ),
              for (final o in options)
                ListTile(
                  title: Text(
                    o.$2,
                    style: Type.label.copyWith(color: EvabobColors.nearBlack),
                  ),
                  subtitle: Text(
                    o.$3,
                    style: Type.caption.copyWith(color: EvabobColors.navyMuted),
                  ),
                  onTap: () => Navigator.pop(ctx, o.$1),
                ),
            ],
          ),
        ),
      ),
    );
    if (choice == null || !mounted) return;

    // Picking an option used to pay on that same tap. The sheet above is a
    // choice between three things, not a decision to part with the money, so
    // the commitment gets its own step — and this is where "cannot be undone"
    // is said, because the PIN screen after it says nothing at all.
    final leavingNow = choice == 'split' ? amount / 2 : amount;
    final confirmed = await confirmPayment(
      context,
      PaymentReview(
        payee: widget.thread.title,
        payeeDetail: widget.thread.handle,
        amount: leavingNow,
        token: token,
        firstTime: false,
        warning: choice == 'escrow'
            ? PaymentReview.heldFirst
            : PaymentReview.irreversible,
        note: switch (choice) {
          'split' => 'The other ${money(amount / 2)} is held until you say the '
              'work arrived, and comes back to you if you never do.',
          'escrow' => null,
          _ => 'It reaches them straight away.',
        },
      ),
    );
    if (!confirmed || !mounted) return;
    // Family above the chosen amount needs the emailed code first. One code
    // covers the whole amount, however it leaves (all now, or half held).
    final handle = (widget.thread.handle ?? '').replaceFirst(RegExp(r'^@'), '').trim();
    final payee = handle.isEmpty ? widget.thread.title : '@$handle';
    if (!await passFamilyCheck(context, to: payee, amount: amount, token: token) ||
        !mounted) {
      return;
    }
    await _payRequestMode(m, myId, choice);
  }

  Future<void> _releaseEscrow(ChatMessage m) async {
    // transferId first: holds now live in the escrow contract, and the old
    // escrowJobId named a row in a server-side ledger instead.
    final jobId = m.meta?['transferId']?.toString() ??
        m.meta?['escrowJobId']?.toString() ??
        m.meta?['jobId']?.toString();
    if (jobId == null || jobId.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Nothing held on this message'),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    // Releasing hands the money over for good. It was one tap with nothing in
    // between, which is the same weight as tapping "Delivered" — and one of
    // the two cannot be taken back.
    final amount = (m.meta?['amount'] as num?)?.toDouble() ??
        (m.meta?['amountUsdc'] as num?)?.toDouble();
    final token = m.meta?['token']?.toString() ?? 'USDC';
    final ok = await confirmAction(
      context,
      title: 'Send them the money you held?',
      message: amount == null
          ? 'It reaches them straight away, and you cannot get it back '
              'afterwards.'
          : '${formatMoney(amount, token)} reaches them straight away. You '
              'cannot get it back afterwards.',
      confirmLabel: 'Send it',
    );
    if (!ok || !mounted) return;
    try {
      await context.read<ChatService>().releaseEscrow(
            threadId: widget.thread.id,
            transferId: jobId,
          );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Sent to them'),
          behavior: SnackBarBehavior.floating,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
            content: Text(friendlyError(e)),
            behavior: SnackBarBehavior.floating),
      );
    }
  }

  Future<void> _markDelivered(ChatMessage m) async {
    final jobId = m.meta?['escrowJobId']?.toString() ??
        m.meta?['jobId']?.toString() ??
        m.receipt?.hash;
    if (jobId == null || jobId.isEmpty) return;
    final ok = await confirmAction(
      context,
      title: 'Say the work has arrived?',
      message: 'This tells them you are happy with it, so they can send you '
          'the money they are holding.',
      confirmLabel: 'Yes, it arrived',
    );
    if (!ok || !mounted) return;
    try {
      await context.read<ChatService>().markEscrowDelivered(
            threadId: widget.thread.id,
            jobId: jobId,
          );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
            content: Text(friendlyError(e)),
            behavior: SnackBarBehavior.floating),
      );
    }
  }

  Future<void> _confirmAgent(ChatMessage m, String myId) async {
    if (_confirmingId != null) return;
    final status = (m.meta?['status']?.toString() ?? '').toLowerCase();
    if (m.meta?['confirmed'] == true ||
        status == 'done' ||
        status == 'executing') {
      return;
    }
    final intent = Map<String, dynamic>.from(
      (m.meta?['intent'] as Map?) ?? const {},
    );
    final route = Map<String, dynamic>.from(
      (m.meta?['route'] as Map?) ?? const {},
    );
    if (intent.isEmpty) return;
    final peerHandle = (widget.thread.handle ?? widget.thread.title)
        .replaceFirst(RegExp(r'^@'), '')
        .trim();
    final chat = context.read<ChatService>();
    final circle = context.read<CircleWalletService>();
    setState(() => _confirmingId = m.id);
    try {
      await chat.executeAgentIntent(
        threadId: widget.thread.id,
        intent: intent,
        route: route,
        myId: myId,
        peerHandle: peerHandle.isEmpty ? widget.thread.title : peerHandle,
        confirmMessageId: m.id,
        context: context,
        circle: circle,
      );
    } finally {
      if (mounted) setState(() => _confirmingId = null);
    }
  }

  /// Own-message alignment: senderId must match logged-in user (never peer).
  bool _isMine(ChatMessage m, EvabobAuth auth) {
    final sid = m.senderId.trim().toLowerCase();
    if (sid.isEmpty || sid == 'system') {
      // Optimistic local post before server stamps senderId.
      return m.meta?['fromMe'] == true;
    }

    final me = auth.circleUserId.trim().toLowerCase();
    final rawId = (auth.user?.id ?? '').trim().toLowerCase();
    final email = (auth.user?.email ?? '').trim().toLowerCase();
    final fromId = rawId.isEmpty ? '' : EvabobUser.circleUserIdFrom(rawId);
    final fromEmail = email.isEmpty ? '' : EvabobUser.circleUserIdFrom(email);

    // Exact match against stable ids only.
    if (sid == me ||
        (rawId.isNotEmpty && sid == rawId) ||
        (fromId.isNotEmpty && sid == fromId) ||
        (fromEmail.isNotEmpty && sid == fromEmail) ||
        sid == 'me') {
      return true;
    }

    // Prefix / hash collision guard: circle ids sometimes differ by casing only
    // (already lowercased) or by dynamic sub vs circle-mapped form.
    if (me.isNotEmpty && (sid == me || me.endsWith(sid) || sid.endsWith(me))) {
      if (me.length >= 5 && sid.length >= 5) return true;
    }

    // Never use meta.fromMe for server-loaded history with a real foreign senderId.
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final chat = context.watch<ChatService>();
    final messages = chat.messagesFor(widget.thread.id);
    final auth = context.watch<EvabobAuth>();
    final myId = auth.circleUserId;

    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(gradient: EvabobColors.meshWarm),
        child: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 4, 16, 8),
                child: Row(
                  children: [
                    IconButton(
                      onPressed: () => Navigator.pop(context),
                      tooltip: 'Back',
                      icon: const Icon(Icons.chevron_left_rounded),
                    ),
                    widget.thread.isAgent
                        ? const EvabobAgentAvatar(size: 36)
                        : CircleAvatar(
                            radius: 18,
                            backgroundColor:
                                EvabobColors.emerald.withValues(alpha: 0.15),
                            child: Text(
                              widget.thread.title.characters.first,
                              style: const TextStyle(
                                color: EvabobColors.emeraldDeep,
                                fontWeight: FontWeight.w400,
                              ),
                            ),
                          ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            widget.thread.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontWeight: FontWeight.w400,
                              fontSize: 22,
                              color: EvabobColors.navy,
                            ),
                          ),
                          Text(
                            '@${widget.thread.handle ?? (widget.thread.isAgent ? 'evabob' : widget.thread.title)}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 10,
                              color: EvabobColors.navyMuted,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: messages.isEmpty
                    // A brand-new thread was a blank white area above a
                    // composer, with nothing saying what to type.
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(32),
                          child: Text(
                            widget.thread.isAgent
                                ? 'Ask anything — what you can spend, how to '
                                    'pay someone, what a payment cost.'
                                : 'Say hello, or ask them for money.',
                            textAlign: TextAlign.center,
                            style: Type.body
                                .copyWith(color: EvabobColors.navyMuted),
                          ),
                        ),
                      )
                    : ListView.builder(
                        controller: _scroll,
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                        itemCount: messages.length,
                        itemBuilder: (context, i) {
                          final m = messages[i];
                          return Padding(
                            padding: const EdgeInsets.only(bottom: 10),
                            child: _bubble(m, myId, auth),
                          );
                        },
                      ),
              ),
              // Composer
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                child: Glass(
                  borderRadius: 20,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                  child: Row(
                    children: [
                      IconButton(
                        tooltip: 'Attach',
                        onPressed: () => _openAttachMenu(myId),
                        icon: const Icon(
                          Icons.attach_file_rounded,
                          color: EvabobColors.emeraldDeep,
                        ),
                      ),
                      Expanded(
                        child: TextField(
                          controller: _input,
                          minLines: 1,
                          maxLines: 4,
                          textInputAction: TextInputAction.send,
                          onSubmitted: (_) => _send(),
                          decoration: InputDecoration(
                            hintText: widget.thread.isAgent
                                ? 'Send \$25 to @john…'
                                : context.watch<ChatService>().showMoneyHint
                                    ? 'use @. to send money'
                                    : 'Message…',
                            border: InputBorder.none,
                            isDense: true,
                            contentPadding: const EdgeInsets.symmetric(
                                horizontal: 12, vertical: 10),
                          ),
                          onTap: () {
                            final chat = context.read<ChatService>();
                            if (chat.showMoneyHint) {
                              chat.dismissMoneyHint();
                            }
                          },
                        ),
                      ),
                      Semantics(
                        button: true,
                        label: 'Send message',
                        child: PressScale(
                          onTap: _send,
                          child: Container(
                            width: 44,
                            height: 44,
                            decoration: const BoxDecoration(
                              shape: BoxShape.circle,
                              gradient: EvabobColors.gradientEmerald,
                            ),
                            child: const Icon(Icons.arrow_upward_rounded,
                                color: EvabobColors.onPrimary, size: 20),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _bubble(ChatMessage m, String myId, EvabobAuth auth) {
    if (m.kind == ChatMessageKind.system &&
        m.meta?['type']?.toString() == 'agent_confirm') {
      final status = (m.meta?['status']?.toString() ?? '').toLowerCase();
      final done = m.meta?['confirmed'] == true || status.contains('done');
      final executing = _confirmingId != null ||
          status == 'executing' ||
          _confirmingId == m.id;
      return Align(
        alignment: Alignment.centerLeft,
        child: Glass(
          heavy: true,
          borderRadius: 20,
          padding: const EdgeInsets.all(16),
          child: SizedBox(
            width: 280,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Confirm action',
                  style: TextStyle(
                    fontWeight: FontWeight.w400,
                    color: EvabobColors.navy,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  m.text ?? '',
                  style: const TextStyle(
                    fontSize: 10,
                    color: EvabobColors.navyMuted,
                  ),
                ),
                if (!done) ...[
                  const SizedBox(height: 12),
                  FilledButton(
                    onPressed: executing ? null : () => _confirmAgent(m, myId),
                    child: (executing &&
                            (_confirmingId == m.id || status == 'executing'))
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: EvabobColors.onPrimary,
                            ),
                          )
                        : const Text('Confirm'),
                  ),
                ] else
                  const Padding(
                    padding: EdgeInsets.only(top: 10),
                    child: Text(
                      'Confirmed',
                      style: TextStyle(
                        fontWeight: FontWeight.w400,
                        color: EvabobColors.emeraldDeep,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      );
    }

    if (m.kind == ChatMessageKind.system) {
      return Center(
        child: Text(
          m.text ?? '',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 10, color: EvabobColors.chalk),
        ),
      );
    }

    if (m.kind == ChatMessageKind.receipt && m.receipt != null) {
      final r = m.receipt!;
      // Align to the sender: mine = right, peer = left (never invert / never peer id).
      final mine = _isMine(m, auth);
      return Align(
        alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
        child: Glass(
          heavy: true,
          borderRadius: 20,
          padding: const EdgeInsets.all(16),
          child: SizedBox(
            width: 260,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: EvabobColors.emerald.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        r.statusLabel,
                        style: const TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w400,
                          color: EvabobColors.emeraldDeep,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  r.amountLabel,
                  style: const TextStyle(
                    fontSize: 48,
                    fontWeight: FontWeight.w400,
                    color: EvabobColors.navy,
                    fontFeatures: [FontFeature.tabularFigures()],
                  ),
                ),
                Text(
                  r.fxLabel,
                  style: const TextStyle(
                    fontSize: 10,
                    color: EvabobColors.navyMuted,
                  ),
                ),
                const SizedBox(height: 8),
                if (r.description.isNotEmpty)
                  Text(
                    r.description,
                    style: const TextStyle(
                      fontSize: 14,
                      color: EvabobColors.navy,
                    ),
                  ),
                const SizedBox(height: 8),
                if (r.sender != null && r.sender!.isNotEmpty)
                  Text(
                    'From ${r.sender}',
                    style: const TextStyle(
                      fontSize: 10,
                      color: EvabobColors.chalk,
                    ),
                  ),
                if ((r.receiver ?? r.peerName) != null)
                  Text(
                    'To ${r.receiver ?? r.peerName}',
                    style: const TextStyle(
                      fontSize: 10,
                      color: EvabobColors.chalk,
                    ),
                  ),
                if (r.dateLabel != null && r.dateLabel!.isNotEmpty)
                  Text(
                    r.dateLabel!,
                    style: const TextStyle(
                      fontSize: 10,
                      color: EvabobColors.chalk,
                    ),
                  ),
                if (r.hash != null && r.hash!.isNotEmpty)
                  Text(
                    '${r.hash!.startsWith('0x') ? 'Tx' : 'Hash'} ${r.hash!.length > 18 ? '${r.hash!.substring(0, 10)}…${r.hash!.substring(r.hash!.length - 6)}' : r.hash}',
                    style: const TextStyle(
                      fontSize: 10,
                      fontFamily: 'monospace',
                      color: EvabobColors.navyMuted,
                    ),
                  ),
                // One Pay button, payer side only. The three ways to settle
                // live behind it: stacked inline they made a chat bubble read
                // like a form, and the choice only matters once you have
                // decided to pay at all.
                if (!mine &&
                    (m.meta?['type']?.toString() == 'payment_request' ||
                        m.meta?['kind']?.toString() == 'payment_request') &&
                    !(m.meta?['status']
                            ?.toString()
                            .toLowerCase()
                            .contains('paid') ??
                        false) &&
                    !(m.meta?['status']
                            ?.toString()
                            .toLowerCase()
                            .contains('escrow') ??
                        false)) ...[
                  const SizedBox(height: 12),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: () => _choosePayMode(m, myId),
                      child: const Text('Pay'),
                    ),
                  ),
                ],
                // Escrow status + release / delivered (both parties).
                if ((m.meta?['type']?.toString() == 'escrow' ||
                        m.meta?['mode']?.toString().contains('escrow') ==
                            true ||
                        (m.meta?['escrowJobId']?.toString().isNotEmpty ??
                            false)) &&
                    !(m.meta?['status']
                            ?.toString()
                            .toLowerCase()
                            .contains('released') ??
                        false) &&
                    !(m.meta?['status']
                            ?.toString()
                            .toLowerCase()
                            .contains('completed') ??
                        false)) ...[
                  const SizedBox(height: 10),
                  Text(
                    '${m.meta?['status'] ?? r.statusLabel}',
                    style: const TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w400,
                      color: EvabobColors.navyMuted,
                    ),
                  ),
                  const SizedBox(height: 8),
                  // A hold on the contract has its own screen with the right
                  // actions for each side: the worker marks it delivered, the
                  // payer pays or raises a problem, and silence pays after 7
                  // days. The two buttons below only serve old ledger rows.
                  if ((m.meta?['transferId']?.toString() ?? '').isNotEmpty)
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton(
                        onPressed: () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => HeldPaymentScreen(
                              transferId: m.meta!['transferId'].toString(),
                            ),
                          ),
                        ),
                        child: Text(mine ? 'See where it stands' : 'Open'),
                      ),
                    )
                  else
                  Row(
                    children: [
                      if (!mine)
                        Expanded(
                          child: OutlinedButton(
                            onPressed: () => _markDelivered(m),
                            child: const Text('Delivered'),
                          ),
                        ),
                      if (!mine) const SizedBox(width: 8),
                      if (mine ||
                          m.meta?['status']
                                  ?.toString()
                                  .toLowerCase()
                                  .contains('submitted') ==
                              true)
                        Expanded(
                          child: FilledButton(
                            onPressed: () => _releaseEscrow(m),
                            child: const Text('Release'),
                          ),
                        ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ),
      ).animate().fadeIn(duration: 320.ms).scale(
            begin: const Offset(0.96, 0.96),
            end: const Offset(1, 1),
            curve: Curves.easeOutCubic,
          );
    }

    final mine = _isMine(m, auth);
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 280),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: mine
              ? EvabobColors.emerald.withValues(alpha: 0.16)
              : EvabobColors.sheet,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(18),
            topRight: const Radius.circular(18),
            bottomLeft: Radius.circular(mine ? 18 : 4),
            bottomRight: Radius.circular(mine ? 4 : 18),
          ),
          border: Border.all(
            color: mine
                ? EvabobColors.emerald.withValues(alpha: 0.3)
                : EvabobColors.hairline,
          ),
        ),
        child: Text(
          m.text ?? '',
          style: const TextStyle(
            color: EvabobColors.nearBlack,
            fontSize: 14,
            height: 1.35,
          ),
        ),
      ),
    );
  }
}
