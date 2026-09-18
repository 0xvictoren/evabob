import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/groups/groups_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import 'circle_screen.dart';
import 'group_forms.dart';
import 'pot_screen.dart';

/// Saving and collecting together, without anyone holding the money.
///
/// Money circles (ajo, esusu, chama): everyone puts in the same amount each
/// round and one person takes the pot, in turn. Collections: a target, a
/// deadline, and everyone refunded automatically if it falls short.
class GroupsScreen extends StatefulWidget {
  const GroupsScreen({super.key});

  @override
  State<GroupsScreen> createState() => _GroupsScreenState();
}

class _GroupsScreenState extends State<GroupsScreen> {
  late final GroupsApi _api = GroupsApi(context.read<ApiClient>());
  List<Group>? _items;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final items = await _api.list();
      if (mounted) setState(() => (_items = items, _error = null));
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    }
  }

  Future<void> _open(String id) async {
    await openGroup(context, id);
    if (mounted) await _load();
  }

  Future<void> _newCircle() async {
    final id = await showCreateCircle(context);
    if (id != null && mounted) await _open(id);
  }

  Future<void> _newPot() async {
    final id = await showCreatePot(context);
    if (id != null && mounted) await _open(id);
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: EvabobPageHeader(
                title: 'Circles and collections',
                onBack: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(
                      Space.page, 0, Space.page, Space.xl),
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: _StartCard(
                            icon: Icons.autorenew_rounded,
                            title: 'Money circle',
                            text: 'Save together. Each round, one person '
                                'takes the pot.',
                            onTap: _newCircle,
                          ),
                        ),
                        const SizedBox(width: Space.md),
                        Expanded(
                          child: _StartCard(
                            icon: Icons.volunteer_activism_outlined,
                            title: 'Collection',
                            text: 'Raise money for something, refunded if '
                                'it falls short.',
                            onTap: _newPot,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: Space.lg),
                    if (items == null && _error == null)
                      const Padding(
                        padding: EdgeInsets.only(top: 40),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 40),
                        child: Text(_error!, textAlign: TextAlign.center),
                      ),
                    if (items != null && items.isEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 24),
                        child: Text(
                          'Nothing yet. Nobody ever holds the money: the '
                          'circle or collection does, and it can only go '
                          'where the rules say.',
                          textAlign: TextAlign.center,
                          style: Type.body
                              .copyWith(color: EvabobColors.navyMuted),
                        ),
                      ),
                    for (final g in items ?? const <Group>[])
                      Padding(
                        padding: const EdgeInsets.only(bottom: Space.sm),
                        child: switch (g) {
                          CircleGroup(:final circle) => _CircleRow(
                              circle: circle, onTap: () => _open(circle.id)),
                          PotGroup(:final pot) =>
                            _PotRow(pot: pot, onTap: () => _open(pot.id)),
                        },
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Opens a circle or collection by id, whichever it is.
Future<void> openGroup(BuildContext context, String id) {
  return Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => id.startsWith('p_')
          ? PotScreen(potId: id)
          : CircleScreen(circleId: id),
    ),
  );
}

class _StartCard extends StatelessWidget {
  const _StartCard({
    required this.icon,
    required this.title,
    required this.text,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String text;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: onTap,
      child: Glass(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: EvabobColors.emeraldDeep),
            const SizedBox(height: Space.sm),
            Text(title,
                style: Type.body.copyWith(color: EvabobColors.nearBlack)),
            const SizedBox(height: 2),
            Text(text,
                style: Type.caption.copyWith(color: EvabobColors.navyMuted)),
          ],
        ),
      ),
    );
  }
}

class _CircleRow extends StatelessWidget {
  const _CircleRow({required this.circle, required this.onTap});

  final MoneyCircle circle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = circle;
    final status = switch (c.state) {
      'forming' when c.needsMyJoin => 'Waiting for you to join',
      'forming' => 'Waiting for everyone to join',
      'running' => 'Round ${c.roundsCollected + 1} of ${c.rounds}',
      'finished' => 'Finished',
      _ => 'Cancelled',
    };
    return InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: onTap,
      child: Glass(
        child: Row(
          children: [
            const Icon(Icons.autorenew_rounded,
                color: EvabobColors.emeraldDeep),
            const SizedBox(width: Space.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(c.name,
                      style:
                          Type.body.copyWith(color: EvabobColors.nearBlack)),
                  Text(
                    '${formatMoney(c.contributionUsdc)} ${c.everyWords} · $status',
                    style: Type.caption.copyWith(
                      color: c.needsMyJoin || (c.me?.behind ?? false)
                          ? EvabobColors.danger
                          : EvabobColors.navyMuted,
                    ),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right_rounded,
                color: EvabobColors.inkTertiary),
          ],
        ),
      ),
    );
  }
}

class _PotRow extends StatelessWidget {
  const _PotRow({required this.pot, required this.onTap});

  final GroupPot pot;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: onTap,
      child: Glass(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.volunteer_activism_outlined,
                    color: EvabobColors.emeraldDeep),
                const SizedBox(width: Space.md),
                Expanded(
                  child: Text(pot.title,
                      style:
                          Type.body.copyWith(color: EvabobColors.nearBlack)),
                ),
                Text(
                  '${formatMoney(pot.raisedUsdc)} / ${formatMoney(pot.targetUsdc)}',
                  style: Type.caption.copyWith(color: EvabobColors.navyMuted),
                ),
              ],
            ),
            const SizedBox(height: Space.sm),
            LinearProgressIndicator(
              value: pot.progress,
              minHeight: 6,
              borderRadius: BorderRadius.circular(99),
              backgroundColor: EvabobColors.sand,
            ),
          ],
        ),
      ),
    );
  }
}
