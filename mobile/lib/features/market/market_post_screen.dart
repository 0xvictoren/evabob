import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/fx/fx_service.dart';
import '../../core/market/market_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import '../../core/widgets/motion.dart';
import '../../core/widgets/top_snack.dart';
import '../request/payment_link_screen.dart';
import 'market_widgets.dart';
import 'dart:async';
import '../../core/chat/chat_models.dart';
import '../../core/chat/chat_service.dart';
import '../chat/chat_thread_screen.dart';
import 'market_invoice_sheet.dart';

/// One post. What it shows depends on who is looking:
///
///   someone else's offer     the seller, their record, "Buy" and "Message"
///   someone else's request   "I'm available"; once the buyer has messaged
///                            them, the chat and "Send an invoice"
///   your own request         the people to pick from, best first, each with
///                            "Message"; and the invoices that came back
///   your own offer           buyers who messaged, and close/reopen
///
/// Only a buyer starts a conversation. A seller cannot message first.
class MarketPostScreen extends StatefulWidget {
  const MarketPostScreen({super.key, required this.postId});

  final String postId;

  @override
  State<MarketPostScreen> createState() => _MarketPostScreenState();
}

class _MarketPostScreenState extends State<MarketPostScreen> {
  late final MarketApi _api = MarketApi(context.read<ApiClient>());
  Map<String, dynamic>? _data;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final data = await _api.post(widget.postId);
      if (mounted) setState(() => _data = data);
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    }
  }

  void _snack(String text) => showTopSnack(
        context,
        SnackBar(content: Text(text), behavior: SnackBarBehavior.floating),
      );

  /// Opens the deal's payment: the same screen every request is paid on,
  /// with its three choices.
  Future<void> _pay(MarketDeal deal) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (ctx) => PaymentLinkScreen(
          requestId: deal.requestId,
          onBack: () => Navigator.of(ctx).pop(),
        ),
      ),
    );
    if (mounted) _load();
  }

  Future<void> _run(Future<void> Function() job) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await job();
    } catch (e) {
      if (mounted) _snack(friendlyError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _buy() => _run(() async {
        final deal = await _api.order(widget.postId);
        if (mounted) await _pay(deal);
      });

  Future<void> _accept(Map<String, dynamic> offer, String sellerName) async {
    final fx = context.read<FxService>();
    final price = (offer['priceUsd'] as num).toDouble();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Go with $sellerName?'),
        content: Text(
          'You pay ${fx.primary(price)}. Next you choose how: set it all '
          'aside until it is done, pay half now, or pay it all. The other '
          'offers are declined.',
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Not yet')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Continue to pay')),
        ],
      ),
    );
    if (ok != true) return;
    await _run(() async {
      final deal = await _api.acceptOffer(offer['id'].toString());
      if (mounted) await _pay(deal);
    });
  }

  Future<void> _decline(Map<String, dynamic> offer) => _run(() async {
        await _api.declineOffer(offer['id'].toString());
        await _load();
      });

  /// Opens the chat the server returned, or one already known by its id.
  Future<void> _openChat({Map<String, dynamic>? thread, String? threadId}) async {
    final chat = context.read<ChatService>();
    ChatThread? t;
    if (thread != null) {
      t = ChatThread.fromJson(thread);
    } else if (threadId != null) {
      t = chat.threadById(threadId);
      if (t == null) {
        await chat.refreshThreads();
        t = chat.threadById(threadId);
      }
    }
    if (t == null || !mounted) {
      if (mounted) _snack('Open Chat to continue the conversation.');
      return;
    }
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => ChatThreadScreen(thread: t!)),
    );
    if (mounted) _load();
  }

  /// The buyer reaches out: to the seller of something for sale, or to one
  /// of the people shortlisted for their request.
  Future<void> _message({String? sellerId}) => _run(() async {
        final res = await _api.contact(widget.postId, sellerId: sellerId);
        if (!mounted) return;
        unawaited(context.read<ChatService>().refreshThreads());
        final thread = res['thread'];
        await _openChat(
          thread: thread is Map ? Map<String, dynamic>.from(thread) : null,
          threadId: (res['contact'] as Map?)?['threadId']?.toString(),
        );
      });

  Future<void> _setAvailable(bool available) => _run(() async {
        await _api.setAvailable(widget.postId, available);
        if (mounted && available) {
          _snack('They can see you are available, with your record.');
        }
        await _load();
      });

  Future<void> _invoice(MarketPost post, String contactId, String? threadId) async {
    final sent = await MarketInvoiceSheet.show(
      context,
      api: _api,
      contactId: contactId,
      title: post.title,
      suggestedUsd: post.priceUsd,
      deliveryDays: post.deliveryDays,
      buyerBudget: post.isWant,
      feeBps: (_data?['marketFeeBps'] as num?)?.toInt() ?? 0,
    );
    if (!sent || !mounted) return;
    _snack('Invoice sent. It is in your chat for them to pay.');
    await _load();
    if (mounted && threadId != null) await _openChat(threadId: threadId);
  }

  Future<void> _setActive(bool active) => _run(() async {
        await _api.setActive(widget.postId, active);
        await _load();
      });

  void _copySocial(String url) {
    if (url.isEmpty) return;
    Clipboard.setData(ClipboardData(text: url));
    _snack('Link copied. Open it in your browser to look at their page.');
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: data == null
            ? Column(
                children: [
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: Space.page),
                    child: EvabobPageHeader(
                      title: 'Marketplace',
                      onBack: () => Navigator.of(context).maybePop(),
                    ),
                  ),
                  Expanded(
                    child: Center(
                      child: _error != null
                          ? Text(_error!, textAlign: TextAlign.center)
                          : const CircularProgressIndicator(),
                    ),
                  ),
                ],
              )
            : _body(data),
      ),
    );
  }

  Widget _body(Map<String, dynamic> data) {
    final fx = context.watch<FxService>();
    final post =
        MarketPost.fromJson(Map<String, dynamic>.from(data['post'] as Map));
    final mine = data['mine'] == true;
    final seller = Map<String, dynamic>.from(data['seller'] as Map);
    final offers = ((data['offers'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
    final matches = ((data['matches'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => MarketPost.fromJson(Map<String, dynamic>.from(e)))
        .toList();
    List<Map<String, dynamic>> maps(Object? v) => ((v as List?) ?? const [])
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
    final people = maps(data['people']);
    final buyers = maps(data['contacts']);
    final deals = maps(data['deals']).map(MarketDeal.fromJson).toList();
    final contact = data['contact'] is Map
        ? Map<String, dynamic>.from(data['contact'] as Map)
        : null;
    final available = data['available'] == true;
    final pinged = (data['pinged'] as num?)?.toInt() ?? 0;

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(Space.page, 0, Space.page, Space.xxl),
        children: [
          EvabobPageHeader(
            title: post.isWant ? 'Wanted' : 'For sale',
            onBack: () => Navigator.of(context).maybePop(),
          ),
          if (post.photos.isNotEmpty) ...[
            SizedBox(
              height: 220,
              child: PageView(
                children: [
                  for (final p in post.photos)
                    Padding(
                      padding: const EdgeInsets.only(right: Space.sm),
                      child: ClipRRect(
                        borderRadius: Radii.all(Radii.md),
                        child: Image.network(
                          marketPhotoUrl(p),
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => Container(
                            color: EvabobColors.sheet,
                            child: Icon(marketCategoryIcon(post.category),
                                size: 48, color: EvabobColors.primary),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: Space.lg),
          ],
          Glass(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(marketCategoryIcon(post.category),
                        size: 16, color: EvabobColors.emeraldDeep),
                    const SizedBox(width: 6),
                    Text(
                      '${marketCategoryLabel(post.category)} · ${post.type == 'goods' ? 'Goods' : 'Service'}',
                      style: Type.label.copyWith(color: EvabobColors.emeraldDeep),
                    ),
                    const Spacer(),
                    if (!post.active)
                      Text('Closed',
                          style: Type.label
                              .copyWith(color: EvabobColors.inkMuted)),
                  ],
                ),
                const SizedBox(height: Space.sm),
                Text(post.title,
                    style: Type.title.copyWith(color: EvabobColors.ink)),
                const SizedBox(height: Space.sm),
                Text(
                  post.isWant
                      ? 'Will pay up to ${fx.primary(post.priceUsd)}'
                      : fx.primary(post.priceUsd),
                  style: Type.amount.copyWith(
                      color: EvabobColors.ink, fontSize: 24, height: 1.2),
                ),
                Text(
                  fx.secondary(post.priceUsd),
                  style: Type.label.copyWith(color: EvabobColors.inkMuted),
                ),
                if (post.description.isNotEmpty) ...[
                  const SizedBox(height: Space.md),
                  Text(post.description,
                      style: Type.body.copyWith(color: EvabobColors.ink)),
                ],
                const SizedBox(height: Space.md),
                _Fact(
                  icon: Icons.place_outlined,
                  text: post.remote
                      ? '${post.placeLabel} · can be done from anywhere'
                      : post.near ?? post.placeLabel,
                ),
                _Fact(
                  icon: Icons.schedule_rounded,
                  text: post.isWant
                      ? 'Needed within ${post.deliveryDays} ${post.deliveryDays == 1 ? 'day' : 'days'}'
                      : 'Delivered within ${post.deliveryDays} ${post.deliveryDays == 1 ? 'day' : 'days'}',
                ),
              ],
            ),
          ),
          const SizedBox(height: Space.lg),
          if (!mine && !post.isWant) ...[
            EvabobPrimaryButton(
              label: post.active ? 'Buy for ${fx.primary(post.priceUsd)}' : 'No longer available',
              busy: _busy,
              onPressed: post.active ? _buy : null,
            ),
            const SizedBox(height: Space.sm),
            _SecondaryAction(
              icon: Icons.chat_bubble_outline_rounded,
              label: contact != null ? 'Open your chat' : 'Message the seller',
              onTap: _busy || !post.active && contact == null
                  ? null
                  : () => contact?['threadId'] != null
                      ? _openChat(threadId: contact!['threadId'].toString())
                      : _message(),
            ),
            const SizedBox(height: Space.md),
            const HowPaymentWorks(),
            const SizedBox(height: Space.lg),
          ],
          if (!mine && post.isWant && contact != null) ...[
            // The buyer picked this seller: talk, then invoice.
            EvabobPrimaryButton(
              label: post.active ? 'Send an invoice' : 'This request is closed',
              busy: _busy,
              onPressed: post.active
                  ? () => _invoice(post, contact['id'].toString(),
                      contact['threadId']?.toString())
                  : null,
            ),
            const SizedBox(height: Space.sm),
            _SecondaryAction(
              icon: Icons.chat_bubble_outline_rounded,
              label: 'Open your chat',
              onTap: contact['threadId'] == null
                  ? null
                  : () => _openChat(threadId: contact['threadId'].toString()),
            ),
            const SizedBox(height: Space.md),
            Text(
              'They messaged you about this. Agree the details in chat, then '
              'send your invoice. They set the money aside before you start, '
              'and it is paid to you when the work is done.',
              style: Type.label.copyWith(color: EvabobColors.inkMuted),
            ),
            const SizedBox(height: Space.lg),
          ],
          if (!mine && post.isWant && contact == null) ...[
            if (available)
              _SecondaryAction(
                icon: Icons.check_circle_rounded,
                label: 'You said you are available · undo',
                onTap: _busy ? null : () => _setAvailable(false),
              )
            else
              EvabobPrimaryButton(
                label: post.active ? "I'm available" : 'This request is closed',
                busy: _busy,
                onPressed: post.active ? () => _setAvailable(true) : null,
              ),
            const SizedBox(height: Space.md),
            Text(
              available
                  ? 'They see you, your record and how near you are. If they '
                      'pick you, they message you and you can send an invoice.'
                  : 'Say you can do this and they see you with your record. '
                      'The buyer chooses who to message; sellers cannot '
                      'message first, so nobody is spammed.',
              style: Type.label.copyWith(color: EvabobColors.inkMuted),
            ),
            const SizedBox(height: Space.lg),
          ],
          if (deals.isNotEmpty) ...[
            EvabobSectionLabel(deals.length == 1 ? 'Invoice' : 'Invoices'),
            const SizedBox(height: Space.sm),
            for (final d in deals) ...[
              _DealRow(deal: d, busy: _busy, onPay: () => _pay(d)),
              const SizedBox(height: Space.sm),
            ],
            const SizedBox(height: Space.md),
          ],
          if (mine && !post.isWant && buyers.isNotEmpty) ...[
            EvabobSectionLabel('Buyers who messaged you'),
            const SizedBox(height: Space.sm),
            for (final b in buyers) ...[
              Glass(
                child: Row(
                  children: [
                    Expanded(
                      child: Text(b['buyer']?.toString() ?? 'A buyer',
                          style: Type.body.copyWith(color: EvabobColors.ink)),
                    ),
                    TextButton(
                      onPressed: b['threadId'] == null
                          ? null
                          : () => _openChat(threadId: b['threadId'].toString()),
                      child: const Text('Chat'),
                    ),
                    FilledButton(
                      onPressed: _busy || !post.active
                          ? null
                          : () => _invoice(post, b['id'].toString(),
                              b['threadId']?.toString()),
                      child: const Text('Invoice'),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: Space.sm),
            ],
            const SizedBox(height: Space.md),
          ],
          if (mine && post.isWant) ...[
            EvabobSectionLabel('People for this (${people.length})'),
            const SizedBox(height: 4),
            Text(
              !post.active
                  ? 'This request is closed.'
                  : pinged == 0
                      ? 'Nobody sells this near you yet. Sellers who see your '
                          'request can say they are available.'
                      : 'We told $pinged ${pinged == 1 ? 'seller' : 'sellers'}. '
                          'Best first, by record, distance and who is '
                          'available. Message whoever you like; if nobody is '
                          'available in 7 hours we tell five more.',
              style: Type.label.copyWith(color: EvabobColors.inkMuted),
            ),
            const SizedBox(height: Space.sm),
            for (var i = 0; i < people.length; i++) ...[
              RiseIn(
                index: i,
                child: _PersonCard(
                  person: people[i],
                  first: i == 0,
                  busy: _busy,
                  canMessage: post.active,
                  onCopySocial: _copySocial,
                  onMessage: () => people[i]['threadId'] != null
                      ? _openChat(threadId: people[i]['threadId'].toString())
                      : _message(
                          sellerId: (people[i]['seller'] as Map)['id']
                              ?.toString()),
                ),
              ),
              const SizedBox(height: Space.md),
            ],
            if (offers.isNotEmpty) ...[
              EvabobSectionLabel('Prices sent (${offers.where((o) => o['status'] == 'sent').length})'),
              const SizedBox(height: Space.sm),
            ],
            for (var i = 0; i < offers.length; i++) ...[
              RiseIn(
                index: i,
                child: _OfferCard(
                  offer: offers[i],
                  first: i == 0,
                  budgetUsd: post.priceUsd,
                  busy: _busy,
                  onAccept: (name) => _accept(offers[i], name),
                  onDecline: () => _decline(offers[i]),
                  onCopySocial: _copySocial,
                ),
              ),
              const SizedBox(height: Space.md),
            ],
            if (matches.isNotEmpty) ...[
              const SizedBox(height: Space.md),
              EvabobSectionLabel('Your agent found these'),
              const SizedBox(height: 4),
              Text(
                'People near you who already sell this, ranked by how well '
                'they fit, how near they are and their record. Open one to '
                'buy it as listed.',
                style: Type.label.copyWith(color: EvabobColors.inkMuted),
              ),
              const SizedBox(height: Space.sm),
              for (var i = 0; i < matches.length; i++) ...[
                RiseIn(
                  index: i,
                  child: MarketPostTile(
                    post: matches[i],
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => MarketPostScreen(postId: matches[i].id),
                      ),
                    ),
                  ),
                ),
                if (matches[i].why.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(4, 6, 4, 0),
                    child: Text(
                      matches[i].why.join(' · '),
                      style: Type.label.copyWith(color: EvabobColors.emeraldDeep),
                    ),
                  ),
                const SizedBox(height: Space.md),
              ],
            ],
          ],
          if (!mine) ...[
            EvabobSectionLabel(post.isWant ? 'Who is asking' : 'Who is selling'),
            const SizedBox(height: Space.sm),
            SellerCard(person: seller, onCopySocial: _copySocial),
          ],
          if (mine) ...[
            const SizedBox(height: Space.md),
            OutlinedButton.icon(
              onPressed: _busy ? null : () => _setActive(!post.active),
              icon: Icon(post.active ? Icons.pause_circle_outline : Icons.play_circle_outline),
              label: Text(post.active ? 'Close this post' : 'Open it again'),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size.fromHeight(48),
                shape: const StadiumBorder(),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    if (text.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        children: [
          Icon(icon, size: 16, color: EvabobColors.inkMuted),
          const SizedBox(width: 6),
          Expanded(
            child: Text(text,
                style: Type.label.copyWith(color: EvabobColors.inkMuted)),
          ),
        ],
      ),
    );
  }
}

/// A quieter action under a primary button.
class _SecondaryAction extends StatelessWidget {
  const _SecondaryAction({required this.icon, required this.label, this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final color =
        onTap == null ? EvabobColors.inkMuted : EvabobColors.primary;
    return PressScale(
      onTap: onTap,
      child: Container(
        height: 48,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: EvabobColors.primary.withValues(alpha: 0.08),
          borderRadius: Radii.all(Radii.pill),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 18, color: color),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Type.body.copyWith(color: color),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Someone the buyer could pick for their request.
class _PersonCard extends StatelessWidget {
  const _PersonCard({
    required this.person,
    required this.first,
    required this.busy,
    required this.canMessage,
    required this.onMessage,
    required this.onCopySocial,
  });

  final Map<String, dynamic> person;
  final bool first;
  final bool busy;
  final bool canMessage;
  final VoidCallback onMessage;
  final void Function(String) onCopySocial;

  @override
  Widget build(BuildContext context) {
    final fx = context.watch<FxService>();
    final seller = Map<String, dynamic>.from(person['seller'] as Map);
    final available = person['available'] == true;
    final contacted = person['contacted'] == true;
    final why = ((person['why'] as List?) ?? const [])
        .map((e) => e.toString())
        .where((e) => !e.startsWith('Says they are available'))
        .join(' · ');
    final offer = person['offer'] is Map
        ? Map<String, dynamic>.from(person['offer'] as Map)
        : null;
    Widget pill(String text, {required bool strong}) => Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          decoration: BoxDecoration(
            color: strong
                ? EvabobColors.primary
                : EvabobColors.primary.withValues(alpha: 0.1),
            borderRadius: Radii.all(Radii.pill),
          ),
          child: Text(
            text,
            style: Type.label.copyWith(
              color: strong ? EvabobColors.onPrimary : EvabobColors.primary,
            ),
          ),
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (first || available)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Wrap(
              spacing: 6,
              children: [
                if (first) pill("Agent's pick", strong: true),
                if (available) pill('Available', strong: false),
              ],
            ),
          ),
        SellerCard(person: seller, onCopySocial: onCopySocial),
        if (why.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 6, 4, 0),
            child: Text(why,
                style: Type.label.copyWith(color: EvabobColors.emeraldDeep)),
          ),
        if (offer != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 4, 4, 0),
            child: Text(
              'Sells "${offer['title']}" for '
              '${fx.primary((offer['priceUsd'] as num).toDouble())}',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: Type.label.copyWith(color: EvabobColors.inkMuted),
            ),
          ),
        const SizedBox(height: Space.sm),
        _SecondaryAction(
          icon: Icons.chat_bubble_outline_rounded,
          label: contacted ? 'Open your chat' : 'Message',
          onTap: busy || (!canMessage && !contacted) ? null : onMessage,
        ),
      ],
    );
  }
}

/// An invoice between the two people on this post.
class _DealRow extends StatelessWidget {
  const _DealRow({required this.deal, required this.busy, required this.onPay});

  final MarketDeal deal;
  final bool busy;
  final VoidCallback onPay;

  @override
  Widget build(BuildContext context) {
    final fx = context.watch<FxService>();
    final buyer = deal.role == 'buyer';
    final open = deal.status == 'open';
    return Glass(
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(fx.primary(deal.priceUsd),
                    style: Type.body.copyWith(color: EvabobColors.ink)),
                const SizedBox(height: 2),
                Text(
                  '${buyer ? 'From' : 'To'} ${deal.withWhom} · ${deal.statusLabel}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Type.label.copyWith(color: EvabobColors.inkMuted),
                ),
              ],
            ),
          ),
          if (buyer && open)
            FilledButton(
              onPressed: busy ? null : onPay,
              child: const Text('Pay'),
            ),
        ],
      ),
    );
  }
}

/// One seller's answer to the person's request.
class _OfferCard extends StatelessWidget {
  const _OfferCard({
    required this.offer,
    required this.first,
    required this.budgetUsd,
    required this.busy,
    required this.onAccept,
    required this.onDecline,
    required this.onCopySocial,
  });

  final Map<String, dynamic> offer;
  final bool first;
  final double budgetUsd;
  final bool busy;
  final ValueChanged<String> onAccept;
  final VoidCallback onDecline;
  final void Function(String) onCopySocial;

  @override
  Widget build(BuildContext context) {
    final fx = context.watch<FxService>();
    final person = Map<String, dynamic>.from(offer['seller'] as Map);
    final price = (offer['priceUsd'] as num).toDouble();
    final status = offer['status']?.toString() ?? 'sent';
    final message = offer['message']?.toString() ?? '';
    final days = (offer['deliveryDays'] as num?)?.toInt();
    final name = person['handle']?.toString() ?? person['name']?.toString() ?? 'this seller';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Text(
              fx.primary(price),
              style: Type.amount.copyWith(color: EvabobColors.ink, fontSize: 20),
            ),
            const SizedBox(width: 8),
            if (price <= budgetUsd)
              Text('within your budget',
                  style: Type.label.copyWith(color: EvabobColors.emeraldDeep)),
            const Spacer(),
            if (first && status == 'sent')
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: EvabobColors.primary,
                  borderRadius: Radii.all(Radii.pill),
                ),
                child: Text("Agent's pick",
                    style: Type.label.copyWith(color: EvabobColors.onPrimary)),
              ),
          ],
        ),
        if (message.isNotEmpty || days != null)
          Padding(
            padding: const EdgeInsets.only(top: 4, bottom: 8),
            child: Text(
              [
                if (message.isNotEmpty) '"$message"',
                if (days != null) 'Done within $days ${days == 1 ? 'day' : 'days'}',
              ].join(' · '),
              style: Type.label.copyWith(color: EvabobColors.ink),
            ),
          ),
        SellerCard(person: person, onCopySocial: onCopySocial),
        if (status == 'sent') ...[
          const SizedBox(height: Space.sm),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: busy ? null : onDecline,
                  style: OutlinedButton.styleFrom(
                      minimumSize: const Size.fromHeight(48),
                      shape: const StadiumBorder()),
                  child: const Text('No thanks'),
                ),
              ),
              const SizedBox(width: Space.md),
              Expanded(
                flex: 2,
                child: FilledButton(
                  onPressed: busy ? null : () => onAccept(name),
                  style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(48)),
                  child: const Text('Accept and pay'),
                ),
              ),
            ],
          ),
        ] else
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              switch (status) {
                'accepted' => 'You accepted this offer',
                'declined' => 'Declined',
                'withdrawn' => 'They withdrew it',
                _ => status,
              },
              style: Type.label.copyWith(color: EvabobColors.inkMuted),
            ),
          ),
      ],
    );
  }
}
