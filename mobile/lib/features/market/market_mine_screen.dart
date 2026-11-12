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
import 'market_post_screen.dart';
import 'market_widgets.dart';
import '../../core/platform/locator.dart';

/// Everything of the person's own on the market: their posts, their deals,
/// and the profile buyers see — with the record behind their score and the
/// outside accounts that back it up.
class MarketMineScreen extends StatefulWidget {
  const MarketMineScreen({super.key, this.startOnProfile = false});

  final bool startOnProfile;

  @override
  State<MarketMineScreen> createState() => _MarketMineScreenState();
}

class _MarketMineScreenState extends State<MarketMineScreen>
    with SingleTickerProviderStateMixin {
  late final MarketApi _api = MarketApi(context.read<ApiClient>());
  late final TabController _tabs = TabController(
      length: 3, vsync: this, initialIndex: widget.startOnProfile ? 2 : 0);

  List<MarketPost>? _posts;
  List<MarketDeal> _deals = const [];
  Map<String, dynamic>? _me;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final res = await _api.mine();
      final me = await _api.me();
      if (!mounted) return;
      setState(() {
        _posts = res.posts;
        _deals = res.deals;
        _me = me;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    }
  }

  void _snack(String text) => showTopSnack(
        context,
        SnackBar(content: Text(text), behavior: SnackBarBehavior.floating),
      );

  Future<void> _openPost(String id) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => MarketPostScreen(postId: id)),
    );
    if (mounted) _load();
  }

  Future<void> _pay(MarketDeal d) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (ctx) => PaymentLinkScreen(
          requestId: d.requestId,
          onBack: () => Navigator.of(ctx).pop(),
        ),
      ),
    );
    if (mounted) _load();
  }

  Future<void> _review(MarketDeal d) async {
    final done = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => MarketReviewSheet(api: _api, deal: d),
    );
    if (done == true && mounted) {
      _snack('Thank you. It is on their profile now.');
      _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: EvabobPageHeader(
                title: 'Your market',
                onBack: () => Navigator.of(context).maybePop(),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: Container(
                decoration: BoxDecoration(
                  color: EvabobColors.sheet,
                  borderRadius: Radii.all(Radii.pill),
                ),
                padding: const EdgeInsets.all(Space.xs),
                child: TabBar(
                  controller: _tabs,
                  dividerHeight: 0,
                  indicatorSize: TabBarIndicatorSize.tab,
                  indicator: BoxDecoration(
                    color: EvabobColors.primary,
                    borderRadius: Radii.all(Radii.pill),
                  ),
                  labelColor: EvabobColors.onPrimary,
                  unselectedLabelColor: EvabobColors.navyMuted,
                  labelStyle: Type.body,
                  unselectedLabelStyle: Type.body,
                  splashBorderRadius: Radii.all(Radii.pill),
                  tabs: const [
                    Tab(text: 'Posts'),
                    Tab(text: 'Deals'),
                    Tab(text: 'Profile'),
                  ],
                ),
              ),
            ),
            const SizedBox(height: Space.md),
            Expanded(
              child: _posts == null
                  ? Center(
                      child: _error != null
                          ? Text(_error!, textAlign: TextAlign.center)
                          : const CircularProgressIndicator(),
                    )
                  : TabBarView(
                      controller: _tabs,
                      children: [_postsTab(), _dealsTab(), _profileTab()],
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _postsTab() {
    final posts = _posts!;
    if (posts.isEmpty) {
      return _Hint(
        icon: Icons.storefront_outlined,
        text: 'You have not posted anything yet. Sell something, or post what you need.',
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(Space.page, 0, Space.page, Space.xxl),
        itemCount: posts.length,
        separatorBuilder: (_, __) => const SizedBox(height: Space.md),
        itemBuilder: (_, i) {
          final p = posts[i];
          return RiseIn(
            index: i,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Opacity(
                  opacity: p.active ? 1 : 0.55,
                  child: MarketPostTile(post: p, onTap: () => _openPost(p.id)),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(4, 6, 4, 0),
                  child: Text(
                    [
                      p.isWant ? 'You need this' : 'You sell this',
                      if (!p.active) 'closed',
                      if (p.isWant && p.offers > 0)
                        '${p.offers} ${p.offers == 1 ? 'offer' : 'offers'} waiting',
                    ].join(' · '),
                    style: Type.label.copyWith(
                      color: p.isWant && p.offers > 0
                          ? EvabobColors.emeraldDeep
                          : EvabobColors.inkMuted,
                    ),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _dealsTab() {
    final fx = context.watch<FxService>();
    if (_deals.isEmpty) {
      return _Hint(
        icon: Icons.handshake_outlined,
        text: 'When you buy something or accept an offer, the deal shows here.',
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(Space.page, 0, Space.page, Space.xxl),
        itemCount: _deals.length,
        separatorBuilder: (_, __) => const SizedBox(height: Space.md),
        itemBuilder: (_, i) {
          final d = _deals[i];
          return RiseIn(
            index: i,
            child: Glass(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(d.title,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: Type.body.copyWith(color: EvabobColors.ink)),
                      ),
                      const SizedBox(width: Space.sm),
                      Text(fx.primary(d.priceUsd),
                          style: Type.amount.copyWith(color: EvabobColors.ink)),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '${d.iAmBuyer ? 'From' : 'To'} ${d.withWhom} · ${d.statusLabel}',
                    style: Type.label.copyWith(color: EvabobColors.inkMuted),
                  ),
                  if (d.reviewStars != null) ...[
                    const SizedBox(height: 6),
                    StarRow(stars: d.reviewStars!),
                  ],
                  if (d.iAmBuyer && d.status == 'open') ...[
                    const SizedBox(height: Space.md),
                    FilledButton(
                      onPressed: () => _pay(d),
                      child: const Text('Choose how to pay'),
                    ),
                  ] else if (d.canReview) ...[
                    const SizedBox(height: Space.md),
                    OutlinedButton.icon(
                      onPressed: () => _review(d),
                      icon: const Icon(Icons.star_outline_rounded),
                      label: const Text('Rate this seller'),
                      style: OutlinedButton.styleFrom(shape: const StadiumBorder()),
                    ),
                  ] else if (d.status != 'open') ...[
                    const SizedBox(height: Space.sm),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton(
                        onPressed: () => _pay(d),
                        child: const Text('See the payment'),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _profileTab() {
    final me = _me ?? const <String, dynamic>{};
    return _ProfileEditor(api: _api, me: me, onSaved: _load, snack: _snack);
  }
}

class _Hint extends StatelessWidget {
  const _Hint({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(Space.xl),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, size: 40, color: EvabobColors.inkTertiary),
          const SizedBox(height: Space.md),
          Text(text,
              textAlign: TextAlign.center,
              style: Type.body.copyWith(color: EvabobColors.inkMuted)),
        ],
      ),
    );
  }
}

/// What buyers see about the person, and the proof behind it.
class _ProfileEditor extends StatefulWidget {
  const _ProfileEditor({
    required this.api,
    required this.me,
    required this.onSaved,
    required this.snack,
  });

  final MarketApi api;
  final Map<String, dynamic> me;
  final Future<void> Function() onSaved;
  final void Function(String) snack;

  @override
  State<_ProfileEditor> createState() => _ProfileEditorState();
}

class _ProfileEditorState extends State<_ProfileEditor> {
  static const _platforms = [
    ('instagram', 'Instagram', 'your username'),
    ('x', 'X (Twitter)', 'your username'),
    ('tiktok', 'TikTok', 'your username'),
    ('facebook', 'Facebook', 'your page name'),
    ('whatsapp', 'WhatsApp Business', '+234…'),
    ('website', 'Website', 'yourshop.com'),
  ];

  late final _bio = TextEditingController(text: widget.me['bio']?.toString() ?? '');
  late final _area = TextEditingController(
      text: (widget.me['place'] as Map?)?['area']?.toString() ?? '');
  late String? _state = (widget.me['place'] as Map?)?['state']?.toString();
  late MapPoint? _point = DeviceLocation.fromPlace(widget.me['place']);
  late final Map<String, TextEditingController> _handles = {
    for (final p in _platforms) p.$1: TextEditingController(text: _social(p.$1)?['handle']?.toString() ?? ''),
  };
  bool _busy = false;
  String? _checking;

  Map<String, dynamic>? _social(String platform) {
    for (final s in (widget.me['socials'] as List?) ?? const []) {
      if (s is Map && s['platform'] == platform) return Map<String, dynamic>.from(s);
    }
    return null;
  }

  @override
  void dispose() {
    _bio.dispose();
    _area.dispose();
    for (final c in _handles.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _busy = true);
    try {
      await widget.api.saveMe(
        bio: _bio.text.trim(),
        place: DeviceLocation.place(state: _state, area: _area.text, point: _point),
        socials: [
          for (final p in _platforms)
            if (_handles[p.$1]!.text.trim().isNotEmpty)
              {'platform': p.$1, 'handle': _handles[p.$1]!.text.trim()},
        ],
      );
      widget.snack('Saved.');
      await widget.onSaved();
    } catch (e) {
      widget.snack(friendlyError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _check(String platform) async {
    setState(() => _checking = platform);
    try {
      final res = await widget.api.checkSocial(platform);
      final code = (res['social'] as Map?)?['code']?.toString();
      if (code != null) await Clipboard.setData(ClipboardData(text: code));
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text((res['social'] as Map?)?['status'] == 'verified'
              ? 'Checked'
              : 'Prove it is yours'),
          content: Text(
            '${res['instructions'] ?? ''}'
            '${code != null && (res['social'] as Map?)?['status'] != 'verified' ? '\n\nThe code is copied: $code' : ''}',
          ),
          actions: [
            FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK')),
          ],
        ),
      );
      await widget.onSaved();
    } catch (e) {
      widget.snack(friendlyError(e));
    } finally {
      if (mounted) setState(() => _checking = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final rep = widget.me['reputation'] is Map
        ? Map<String, dynamic>.from(widget.me['reputation'] as Map)
        : const <String, dynamic>{};
    final score = (rep['score'] as num?)?.toInt() ?? 0;
    final reasons = ((rep['reasons'] as List?) ?? const []).map((e) => e.toString()).toList();
    return ListView(
      padding: const EdgeInsets.fromLTRB(Space.page, 0, Space.page, Space.xxl),
      children: [
        Glass(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text('Your record', style: Type.body.copyWith(color: EvabobColors.ink)),
                  const Spacer(),
                  Text('${rep['tierLabel'] ?? 'New here'}',
                      style: Type.label.copyWith(color: EvabobColors.emeraldDeep)),
                ],
              ),
              const SizedBox(height: Space.md),
              Row(
                children: [
                  Expanded(
                    child: ClipRRect(
                      borderRadius: Radii.all(Radii.pill),
                      child: TweenAnimationBuilder<double>(
                        tween: Tween(begin: 0, end: (score / 100).clamp(0.0, 1.0)),
                        duration: Motion.slow,
                        curve: Motion.smooth,
                        builder: (_, v, __) => LinearProgressIndicator(
                          value: v,
                          minHeight: 8,
                          backgroundColor: EvabobColors.pageBg,
                          color: EvabobColors.primary,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: Space.md),
                  Text('$score/100', style: Type.amount.copyWith(color: EvabobColors.ink)),
                ],
              ),
              const SizedBox(height: Space.sm),
              for (final r in reasons)
                Text('· $r', style: Type.label.copyWith(color: EvabobColors.inkMuted)),
              const SizedBox(height: Space.sm),
              Text(
                'It grows with work you deliver and get paid for, ratings from '
                'buyers who paid, and accounts we have checked are yours. '
                'Refunds after a review bring it down.',
                style: Type.label.copyWith(color: EvabobColors.inkMuted),
              ),
            ],
          ),
        ),
        const SizedBox(height: Space.lg),
        Glass(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('About you', style: Type.body.copyWith(color: EvabobColors.ink)),
              const SizedBox(height: Space.sm),
              TextField(
                controller: _bio,
                maxLines: 3,
                maxLength: 400,
                decoration: const InputDecoration(
                  hintText: 'What you do and for how long, e.g. "Home cleaning in Lekki since 2019"',
                ),
              ),
              Text('Where you are', style: Type.body.copyWith(color: EvabobColors.ink)),
              const SizedBox(height: Space.sm),
              PlaceFields(
                state: _state,
                area: _area,
                onState: (v) => setState(() => _state = v),
                point: _point,
                onPoint: (p) => setState(() => _point = p),
              ),
            ],
          ),
        ),
        const SizedBox(height: Space.lg),
        Glass(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Your pages elsewhere', style: Type.body.copyWith(color: EvabobColors.ink)),
              const SizedBox(height: 4),
              Text(
                'Buyers trust what they can look at. Add the pages where you '
                'show your work, then tap Check: you put a short code in that '
                'bio for a moment so we know the page is really yours.',
                style: Type.label.copyWith(color: EvabobColors.inkMuted),
              ),
              const SizedBox(height: Space.md),
              for (final p in _platforms) ...[
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _handles[p.$1],
                        decoration: InputDecoration(labelText: p.$2, hintText: p.$3),
                      ),
                    ),
                    const SizedBox(width: Space.sm),
                    _SocialStatus(
                      status: _social(p.$1)?['status']?.toString(),
                      busy: _checking == p.$1,
                      onCheck: _social(p.$1) == null ? null : () => _check(p.$1),
                    ),
                  ],
                ),
                const SizedBox(height: Space.sm),
              ],
            ],
          ),
        ),
        const SizedBox(height: Space.lg),
        EvabobPrimaryButton(label: 'Save', busy: _busy, onPressed: _save),
      ],
    );
  }
}

class _SocialStatus extends StatelessWidget {
  const _SocialStatus({this.status, required this.busy, this.onCheck});

  final String? status;
  final bool busy;
  final VoidCallback? onCheck;

  @override
  Widget build(BuildContext context) {
    if (status == 'verified') {
      return const Tooltip(
        message: 'Checked: this page is theirs',
        child: Icon(Icons.verified_rounded, color: EvabobColors.success),
      );
    }
    return SizedBox(
      width: 88,
      child: TextButton(
        onPressed: busy || onCheck == null ? null : onCheck,
        child: busy
            ? const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2))
            : Text(status == 'pending' ? 'Waiting' : onCheck == null ? 'Save first' : 'Check',
                textAlign: TextAlign.center),
      ),
    );
  }
}

class MarketReviewSheet extends StatefulWidget {
  const MarketReviewSheet({super.key, required this.api, required this.deal});

  /// Asks for a rating. True once it was sent.
  static Future<bool> show(
    BuildContext context, {
    required MarketApi api,
    required MarketDeal deal,
  }) async =>
      await showModalBottomSheet<bool>(
        context: context,
        isScrollControlled: true,
        backgroundColor: Colors.transparent,
        builder: (_) => MarketReviewSheet(api: api, deal: deal),
      ) ==
      true;

  final MarketApi api;
  final MarketDeal deal;

  @override
  State<MarketReviewSheet> createState() => _ReviewSheetState();
}

class _ReviewSheetState extends State<MarketReviewSheet> {
  int _stars = 0;
  final _text = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    if (_stars == 0) {
      setState(() => _error = 'Choose 1 to 5 stars.');
      return;
    }
    setState(() => _busy = true);
    try {
      await widget.api.review(widget.deal.id, _stars, _text.text);
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
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: Container(
        margin: const EdgeInsets.all(Space.md),
        padding: const EdgeInsets.all(Space.page),
        decoration: BoxDecoration(color: EvabobColors.sheet, borderRadius: Radii.all(Radii.lg)),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('How was ${widget.deal.withWhom}?', style: Type.title),
            const SizedBox(height: Space.md),
            Center(child: StarRow(stars: _stars, size: 36, onPick: (v) => setState(() => _stars = v))),
            const SizedBox(height: Space.md),
            TextField(
              controller: _text,
              maxLines: 3,
              maxLength: 600,
              decoration: const InputDecoration(hintText: 'What went well, or not (optional)'),
            ),
            if (_error != null)
              Text(_error!, style: Type.label.copyWith(color: EvabobColors.alert)),
            const SizedBox(height: Space.sm),
            EvabobPrimaryButton(label: 'Send', busy: _busy, onPressed: _send),
          ],
        ),
      ),
    );
  }
}
