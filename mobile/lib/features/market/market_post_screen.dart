import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/fx/fx_service.dart';
import '../../core/market/market_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/amount_input.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import '../../core/widgets/motion.dart';
import '../../core/widgets/top_snack.dart';
import '../request/payment_link_screen.dart';
import 'market_widgets.dart';

/// One post. What it shows depends on who is looking:
///
///   someone else's offer     the seller, their record, and "Buy"
///   someone else's request   the request, and "Send your price"
///   your own request         the offers that came in, and the agent's
///                            shortlist of sellers who already sell this
///   your own offer           the post as others see it, and close/reopen
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

  Future<void> _sendPrice(MarketPost post, Map<String, dynamic>? mine) async {
    final sent = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _OfferSheet(api: _api, post: post, existing: mine),
    );
    if (sent == true && mounted) {
      _snack('Sent. They will see your price and your record.');
      await _load();
    }
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
    final myOffer = data['myOffer'] is Map
        ? Map<String, dynamic>.from(data['myOffer'] as Map)
        : null;

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
            const SizedBox(height: Space.md),
            const HowPaymentWorks(),
            const SizedBox(height: Space.lg),
          ],
          if (!mine && post.isWant) ...[
            EvabobPrimaryButton(
              label: !post.active
                  ? 'This request is closed'
                  : myOffer != null && myOffer['status'] == 'sent'
                      ? 'Change your price (${fx.primary((myOffer['priceUsd'] as num).toDouble())})'
                      : 'Send your price',
              busy: _busy,
              onPressed: post.active ? () => _sendPrice(post, myOffer) : null,
            ),
            const SizedBox(height: Space.md),
            Text(
              'If they accept, they set the money aside before you start, '
              'and it is paid to you when the work is done.',
              style: Type.label.copyWith(color: EvabobColors.inkMuted),
            ),
            const SizedBox(height: Space.lg),
          ],
          if (mine && post.isWant) ...[
            EvabobSectionLabel('Offers (${offers.where((o) => o['status'] == 'sent').length})'),
            const SizedBox(height: Space.sm),
            if (offers.isEmpty)
              Glass(
                child: Text(
                  post.active
                      ? 'Sellers near you have been told. Their prices appear here, best first.'
                      : 'This request is closed.',
                  style: Type.label.copyWith(color: EvabobColors.inkMuted),
                ),
              ),
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

/// A seller sends their price for a request.
class _OfferSheet extends StatefulWidget {
  const _OfferSheet({required this.api, required this.post, this.existing});

  final MarketApi api;
  final MarketPost post;
  final Map<String, dynamic>? existing;

  @override
  State<_OfferSheet> createState() => _OfferSheetState();
}

class _OfferSheetState extends State<_OfferSheet> {
  late final _price = TextEditingController();
  late final _message = TextEditingController(
      text: widget.existing?['message']?.toString() ?? '');
  late int _days = (widget.existing?['deliveryDays'] as num?)?.toInt() ??
      widget.post.deliveryDays;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final fx = context.read<FxService>();
    final usd = (widget.existing?['priceUsd'] as num?)?.toDouble() ??
        widget.post.priceUsd;
    _price.text = fx.fromUsd(usd).toStringAsFixed(fx.isNaira ? 0 : 2);
  }

  @override
  void dispose() {
    _price.dispose();
    _message.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final fx = context.read<FxService>();
    final typed = double.tryParse(_price.text.replaceAll(',', ''));
    if (typed == null || typed <= 0) {
      setState(() => _error = 'Enter your price.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.sendOffer(
        widget.post.id,
        priceUsd: fx.toUsd(typed),
        message: _message.text.trim(),
        deliveryDays: _days,
      );
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = friendlyError(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final fx = context.watch<FxService>();
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: Container(
        margin: const EdgeInsets.all(Space.md),
        padding: const EdgeInsets.all(Space.page),
        decoration: BoxDecoration(
          color: EvabobColors.sheet,
          borderRadius: Radii.all(Radii.lg),
        ),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Your price', style: Type.title),
              const SizedBox(height: 4),
              Text(
                'They will pay up to ${fx.primary(widget.post.priceUsd)}.',
                style: Type.label.copyWith(color: EvabobColors.inkMuted),
              ),
              const SizedBox(height: Space.md),
              TextField(
                controller: _price,
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: const [AmountInputFormatter()],
                decoration: InputDecoration(
                  labelText: 'Price in ${fx.isNaira ? 'naira' : 'dollars'}',
                  prefixText: fx.isNaira ? '₦ ' : '\$ ',
                ),
              ),
              const SizedBox(height: Space.md),
              TextField(
                controller: _message,
                maxLines: 3,
                maxLength: 600,
                decoration: const InputDecoration(
                  hintText: 'What you will do, when you can start, your experience',
                ),
              ),
              Row(
                children: [
                  Expanded(
                    child: Text('Done within',
                        style: Type.body.copyWith(color: EvabobColors.ink)),
                  ),
                  IconButton(
                    onPressed: _days > 1 ? () => setState(() => _days--) : null,
                    icon: const Icon(Icons.remove_circle_outline),
                  ),
                  Text('$_days ${_days == 1 ? 'day' : 'days'}', style: Type.body),
                  IconButton(
                    onPressed: _days < 60 ? () => setState(() => _days++) : null,
                    icon: const Icon(Icons.add_circle_outline),
                  ),
                ],
              ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: Space.sm),
                  child: Text(_error!,
                      style: Type.label.copyWith(color: EvabobColors.alert)),
                ),
              const SizedBox(height: Space.sm),
              EvabobPrimaryButton(label: 'Send', busy: _busy, onPressed: _send),
            ],
          ),
        ),
      ),
    );
  }
}
