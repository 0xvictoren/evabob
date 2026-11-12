import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/market/market_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import '../../core/widgets/motion.dart';
import 'market_mine_screen.dart';
import 'market_post_form.dart';
import 'market_post_screen.dart';
import 'market_widgets.dart';
import '../../core/platform/locator.dart';
import '../../core/widgets/top_snack.dart';

/// The marketplace: what people near you sell, and what people near you need.
///
/// Two tabs over one list. "For sale" is goods and services on offer;
/// "Wanted" is what people are looking for, which a seller answers with a
/// price. Every list comes from the server already ranked by how well it
/// fits, how near it is, and how good the seller's record is.
class MarketScreen extends StatefulWidget {
  const MarketScreen({super.key, this.startOnWanted = false});

  final bool startOnWanted;

  @override
  State<MarketScreen> createState() => _MarketScreenState();
}

class _MarketScreenState extends State<MarketScreen>
    with SingleTickerProviderStateMixin {
  late final MarketApi _api = MarketApi(context.read<ApiClient>());
  late final TabController _tabs = TabController(
    length: 2,
    vsync: this,
    initialIndex: widget.startOnWanted ? 1 : 0,
  )..addListener(() {
      if (!_tabs.indexIsChanging) _load();
    });
  final _search = TextEditingController();
  Timer? _debounce;

  String? _category;
  String _sort = 'best';
  List<MarketPost>? _items;
  bool _hasPoint = true;
  bool _locating = false;
  String? _error;
  int _loadId = 0;

  String get _kind => _tabs.index == 0 ? 'offer' : 'want';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    _tabs.dispose();
    super.dispose();
  }

  void _say(String text) => showTopSnack(
        context,
        SnackBar(content: Text(text), behavior: SnackBarBehavior.floating),
      );

  /// One tap to be ranked by real distance: keeps the state and area the
  /// person already gave and adds a position rounded to about a kilometre.
  Future<void> _useMyLocation() async {
    if (_locating) return;
    setState(() => _locating = true);
    try {
      final point = await DeviceLocation.here();
      final me = await _api.me();
      final place = me['place'];
      await _api.saveMe(
        place: DeviceLocation.place(
          state: place is Map ? place['state']?.toString() : null,
          area: place is Map ? place['area']?.toString() : null,
          point: point,
        ),
      );
      if (!mounted) return;
      _say('Now showing who is nearest to you.');
      await _load();
    } on LocationProblem catch (e) {
      if (mounted) _say(e.message);
    } catch (e) {
      if (mounted) _say(friendlyError(e));
    } finally {
      if (mounted) setState(() => _locating = false);
    }
  }

  Future<void> _load() async {
    final id = ++_loadId;
    setState(() => _error = null);
    try {
      final res = await _api.browse(
        kind: _kind,
        category: _category,
        query: _search.text,
        sort: _sort,
      );
      if (!mounted || id != _loadId) return;
      setState(() {
        _items = res.items;
        _hasPoint = res.hasPoint;
      });
    } catch (e) {
      if (!mounted || id != _loadId) return;
      setState(() {
        _items ??= const [];
        _error = friendlyError(e);
      });
    }
  }

  void _onSearch(String _) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), _load);
  }

  Future<void> _open(MarketPost p) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => MarketPostScreen(postId: p.id)),
    );
    if (mounted) _load();
  }

  Future<void> _post({required bool want}) async {
    final made = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => MarketPostForm(want: want)),
    );
    if (!mounted) return;
    await _load();
    if (made != null && mounted) {
      await Navigator.of(context).push(
        MaterialPageRoute<void>(builder: (_) => MarketPostScreen(postId: made)),
      );
      if (mounted) _load();
    }
  }

  void _mine() {
    Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => const MarketMineScreen()))
        .then((_) => mounted ? _load() : null);
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'market-post',
        onPressed: () => _post(want: _tabs.index == 1),
        icon: const Icon(Icons.add_rounded),
        label: Text(_tabs.index == 1 ? 'Post what you need' : 'Sell something'),
      ),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _load,
          child: CustomScrollView(
            slivers: [
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(
                    Space.page, 0, Space.page, Space.sm),
                sliver: SliverList.list(
                  children: [
                    EvabobPageHeader(
                      title: 'Marketplace',
                      onBack: Navigator.of(context).canPop()
                          ? () => Navigator.of(context).maybePop()
                          : null,
                      trailing: IconButton(
                        tooltip: 'Your posts and deals',
                        onPressed: _mine,
                        icon: const Icon(Icons.storefront_rounded),
                      ),
                    ),
                    const SizedBox(height: Space.sm),
                    _AskBox(onAsk: () => _post(want: true)),
                    const SizedBox(height: Space.md),
                    Container(
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
                        tabs: const [Tab(text: 'For sale'), Tab(text: 'Wanted')],
                      ),
                    ),
                    const SizedBox(height: Space.md),
                    TextField(
                      controller: _search,
                      onChanged: _onSearch,
                      textInputAction: TextInputAction.search,
                      onSubmitted: (_) => _load(),
                      decoration: InputDecoration(
                        filled: true,
                        fillColor: EvabobColors.sheet,
                        prefixIcon: const Icon(Icons.search_rounded),
                        hintText: _tabs.index == 0
                            ? 'Cleaner, cake, iPhone, tailor…'
                            : 'What are people looking for?',
                        border: OutlineInputBorder(
                          borderRadius: Radii.all(Radii.pill),
                          borderSide: BorderSide.none,
                        ),
                        enabledBorder: OutlineInputBorder(
                          borderRadius: Radii.all(Radii.pill),
                          borderSide: BorderSide.none,
                        ),
                      ),
                    ),
                    const SizedBox(height: Space.md),
                    SizedBox(
                      height: 40,
                      child: ListView(
                        scrollDirection: Axis.horizontal,
                        children: [
                          _Chip(
                            label: 'All',
                            selected: _category == null,
                            onTap: () {
                              setState(() => _category = null);
                              _load();
                            },
                          ),
                          for (final c in marketCategories)
                            _Chip(
                              label: c.label,
                              icon: marketCategoryIcon(c.id),
                              selected: _category == c.id,
                              onTap: () {
                                setState(() => _category =
                                    _category == c.id ? null : c.id);
                                _load();
                              },
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: Space.sm),
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            items == null
                                ? ''
                                : '${items.length} ${_tabs.index == 0 ? 'for sale' : 'wanted'}',
                            style: Type.label
                                .copyWith(color: EvabobColors.inkMuted),
                          ),
                        ),
                        if (items != null && !_hasPoint)
                          Padding(
                            padding: const EdgeInsets.only(right: 4),
                            child: PressScale(
                              onTap: _useMyLocation,
                              child: Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 10, vertical: 6),
                                decoration: BoxDecoration(
                                  color: EvabobColors.primary
                                      .withValues(alpha: 0.08),
                                  borderRadius: Radii.all(Radii.pill),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Icon(
                                      _locating
                                          ? Icons.hourglass_top_rounded
                                          : Icons.my_location_rounded,
                                      size: 14,
                                      color: EvabobColors.primary,
                                    ),
                                    const SizedBox(width: 6),
                                    Text(
                                      _locating ? 'Finding you…' : 'Near me',
                                      style: Type.label.copyWith(
                                          color: EvabobColors.primary),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        PopupMenuButton<String>(
                          tooltip: 'Sort',
                          initialValue: _sort,
                          onSelected: (v) {
                            setState(() => _sort = v);
                            _load();
                          },
                          itemBuilder: (_) => const [
                            PopupMenuItem(value: 'best', child: Text('Best match')),
                            PopupMenuItem(value: 'nearest', child: Text('Nearest')),
                            PopupMenuItem(value: 'top_rated', child: Text('Best record')),
                            PopupMenuItem(value: 'price_low', child: Text('Lowest price')),
                            PopupMenuItem(value: 'price_high', child: Text('Highest price')),
                            PopupMenuItem(value: 'newest', child: Text('Newest')),
                          ],
                          child: Padding(
                            padding: const EdgeInsets.all(8),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(Icons.sort_rounded,
                                    size: 18, color: EvabobColors.emeraldDeep),
                                const SizedBox(width: 4),
                                Text(
                                  switch (_sort) {
                                    'nearest' => 'Nearest',
                                    'top_rated' => 'Best record',
                                    'price_low' => 'Lowest price',
                                    'price_high' => 'Highest price',
                                    'newest' => 'Newest',
                                    _ => 'Best match',
                                  },
                                  style: Type.label.copyWith(
                                      color: EvabobColors.emeraldDeep),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              if (items == null)
                const SliverFillRemaining(
                  hasScrollBody: false,
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (items.isEmpty)
                SliverFillRemaining(
                  hasScrollBody: false,
                  child: _Empty(
                    error: _error,
                    wanted: _tabs.index == 1,
                    onPost: () => _post(want: _tabs.index == 1),
                  ),
                )
              else
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(
                      Space.page, Space.xs, Space.page, 96),
                  sliver: SliverLayoutBuilder(
                    builder: (context, constraints) {
                      // Two columns where there is room for them (tablets,
                      // the website), one on a phone.
                      final wide = constraints.crossAxisExtent >= 720;
                      if (!wide) {
                        return SliverList.separated(
                          itemCount: items.length,
                          separatorBuilder: (_, __) =>
                              const SizedBox(height: Space.md),
                          itemBuilder: (_, i) => RiseIn(
                            index: i,
                            child: MarketPostTile(
                                post: items[i], onTap: () => _open(items[i])),
                          ),
                        );
                      }
                      return SliverGrid.builder(
                        gridDelegate:
                            const SliverGridDelegateWithMaxCrossAxisExtent(
                          maxCrossAxisExtent: 520,
                          mainAxisExtent: 132,
                          crossAxisSpacing: Space.md,
                          mainAxisSpacing: Space.md,
                        ),
                        itemCount: items.length,
                        itemBuilder: (_, i) => RiseIn(
                          index: i,
                          child: MarketPostTile(
                              post: items[i], onTap: () => _open(items[i])),
                        ),
                      );
                    },
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// "Tell us what you need": the request is the front door, as on Karwan.
class _AskBox extends StatelessWidget {
  const _AskBox({required this.onAsk});

  final VoidCallback onAsk;

  @override
  Widget build(BuildContext context) {
    return PressScale(
      onTap: onAsk,
      scale: 0.98,
      child: Container(
        padding: const EdgeInsets.all(Space.lg),
        decoration: BoxDecoration(
          color: EvabobColors.primary,
          borderRadius: Radii.all(Radii.md),
        ),
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: EvabobColors.white.withValues(alpha: .2),
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.auto_awesome_rounded,
                  color: EvabobColors.white),
            ),
            const SizedBox(width: Space.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Tell us what you need',
                    style: Type.body.copyWith(
                        color: EvabobColors.white, fontSize: 16),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'A cleaner, a cake, a phone repair. We find people near '
                    'you with a good record, and they send you their price.',
                    style: Type.label.copyWith(color: EvabobColors.white),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right_rounded, color: EvabobColors.white),
          ],
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({
    required this.label,
    required this.selected,
    required this.onTap,
    this.icon,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: Space.sm),
      child: ChoiceChip(
        selected: selected,
        onSelected: (_) => onTap(),
        showCheckmark: false,
        avatar: icon == null
            ? null
            : Icon(icon,
                size: 16,
                color:
                    selected ? EvabobColors.onPrimary : EvabobColors.primary),
        label: Text(label),
        labelStyle: Type.label.copyWith(
          color: selected ? EvabobColors.onPrimary : EvabobColors.ink,
          fontFamily: 'Numans',
        ),
        selectedColor: EvabobColors.primary,
        backgroundColor: EvabobColors.sheet,
        side: BorderSide.none,
        shape: const StadiumBorder(),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.wanted, required this.onPost, this.error});

  final bool wanted;
  final VoidCallback onPost;
  final String? error;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.page, Space.xl, Space.page, 96),
      child: Column(
        children: [
          Icon(
            error != null
                ? Icons.cloud_off_rounded
                : wanted
                    ? Icons.campaign_outlined
                    : Icons.storefront_outlined,
            size: 40,
            color: EvabobColors.inkTertiary,
          ),
          const SizedBox(height: Space.md),
          Text(
            error ??
                (wanted
                    ? 'Nobody has asked for this yet.'
                    : 'Nothing like this for sale yet.'),
            textAlign: TextAlign.center,
            style: Type.body.copyWith(color: EvabobColors.inkMuted),
          ),
          if (error == null) ...[
            const SizedBox(height: Space.lg),
            FilledButton(
              onPressed: onPost,
              child: Text(wanted ? 'Post what you need' : 'Sell something'),
            ),
          ],
        ],
      ),
    );
  }
}
