import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/auth/evabob_auth.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/wallet/circle_wallet_service.dart';
import 'package:evabob_mobile/core/utils/amount_input.dart';

/// Starts a money circle. Returns its id once it is on chain.
Future<String?> showCreateCircle(BuildContext context) =>
    Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const _CreateCircleScreen()),
    );

/// Starts a collection. Returns its id once it is on chain.
Future<String?> showCreatePot(BuildContext context) =>
    Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const _CreatePotScreen()),
    );

const _everyOptions = <(String, String)>[
  ('day', 'Daily'),
  ('week', 'Weekly'),
  ('two_weeks', 'Every 2 weeks'),
  ('month', 'Monthly'),
  // Testnet only; the server refuses it in production.
  ('ten_minutes', 'Every 10 min (test)'),
];

class _CreateCircleScreen extends StatefulWidget {
  const _CreateCircleScreen();

  @override
  State<_CreateCircleScreen> createState() => _CreateCircleScreenState();
}

class _CreateCircleScreenState extends State<_CreateCircleScreen> {
  final _name = TextEditingController();
  final _amount = TextEditingController();
  final _add = TextEditingController();
  String _every = 'week';
  late final List<String> _members = [
    // The organizer is in by default, first in line; they can move or remove themselves.
    if (_myHandle != null) '@$_myHandle',
  ];
  bool _busy = false;
  String? _error;

  String? get _myHandle {
    final h = context.read<EvabobAuth>().user?.handle;
    return h == null || h.isEmpty ? null : h;
  }

  @override
  void dispose() {
    _name.dispose();
    _amount.dispose();
    _add.dispose();
    super.dispose();
  }

  void _addMember() {
    var who = _add.text.trim();
    if (who.isEmpty) return;
    if (!who.contains('@')) who = '@$who';
    if (_members.map((m) => m.toLowerCase()).contains(who.toLowerCase())) {
      setState(() => _error = '$who is already in the circle');
      return;
    }
    if (_members.length >= 20) {
      setState(() => _error = 'A circle has at most 20 people');
      return;
    }
    setState(() {
      _members.add(who);
      _add.clear();
      _error = null;
    });
  }

  void _move(int i, int by) {
    final j = i + by;
    if (j < 0 || j >= _members.length) return;
    setState(() {
      final m = _members.removeAt(i);
      _members.insert(j, m);
    });
  }

  Future<void> _create() async {
    final amount = double.tryParse(_amount.text.trim());
    if (_name.text.trim().isEmpty) {
      setState(() => _error = 'Give the circle a name');
      return;
    }
    if (amount == null || amount < 1) {
      setState(() => _error = 'Each person puts in at least \$1 a round');
      return;
    }
    if (_members.length < 2) {
      setState(() => _error = 'Add at least one more person');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final res = await context.read<CircleWalletService>().createCircle(
            context: context,
            name: _name.text.trim(),
            contributionUsdc: amount,
            every: _every,
            members: List.of(_members),
          );
      if (!mounted) return;
      if (res['ok'] == true) {
        Navigator.of(context).pop(res['groupId']?.toString());
      } else {
        setState(() => _error = friendlyError(res['error'],
            fallback: 'The circle was not created.'));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final amount = double.tryParse(_amount.text.trim()) ?? 0;
    final n = _members.length;
    final everyLabel =
        _everyOptions.firstWhere((o) => o.$1 == _every).$2.toLowerCase();
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      appBar: AppBar(title: const Text('New money circle')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(Space.page),
          children: [
            TextField(
              controller: _name,
              maxLength: 60,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                labelText: 'Name',
                hintText: 'Friday ajo',
                counterText: '',
              ),
            ),
            const SizedBox(height: Space.sm),
            TextField(
              controller: _amount,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [
                const AmountInputFormatter(),
              ],
              decoration: const InputDecoration(
                labelText: 'Each person puts in',
                prefixText: r'$ ',
              ),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: Space.md),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final o in _everyOptions)
                  ChoiceChip(
                    label: Text(o.$2),
                    selected: _every == o.$1,
                    onSelected: (_) => setState(() => _every = o.$1),
                  ),
              ],
            ),
            const SizedBox(height: Space.lg),
            Text('Who is in, in payout order',
                style: Type.label.copyWith(color: EvabobColors.nearBlack)),
            const SizedBox(height: Space.sm),
            for (var i = 0; i < _members.length; i++)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: CircleAvatar(
                  radius: 14,
                  child: Text('${i + 1}', style: const TextStyle(fontSize: 12)),
                ),
                title: Text(
                  _members[i].toLowerCase() ==
                          '@${_myHandle ?? ''}'.toLowerCase()
                      ? '${_members[i]} (you)'
                      : _members[i],
                ),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      tooltip: 'Earlier',
                      onPressed: i == 0 ? null : () => _move(i, -1),
                      icon: const Icon(Icons.arrow_upward_rounded),
                    ),
                    IconButton(
                      tooltip: 'Later',
                      onPressed:
                          i == _members.length - 1 ? null : () => _move(i, 1),
                      icon: const Icon(Icons.arrow_downward_rounded),
                    ),
                    IconButton(
                      tooltip: 'Remove',
                      onPressed: () => setState(() => _members.removeAt(i)),
                      icon: const Icon(Icons.close_rounded),
                    ),
                  ],
                ),
              ),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _add,
                    decoration: const InputDecoration(
                      hintText: '@username or email',
                    ),
                    onSubmitted: (_) => _addMember(),
                  ),
                ),
                IconButton(
                  tooltip: 'Add',
                  onPressed: _addMember,
                  icon: const Icon(Icons.person_add_alt_1_rounded),
                ),
              ],
            ),
            const SizedBox(height: Space.lg),
            if (amount > 0 && n >= 2)
              Container(
                padding: const EdgeInsets.all(Space.md),
                decoration: BoxDecoration(
                  color: EvabobColors.sheet,
                  borderRadius: Radii.all(Radii.md),
                ),
                child: Text(
                  'Everyone puts in ${formatMoney(amount)} $everyLabel. Each '
                  'round one person takes ${formatMoney(amount * n)}, in the '
                  'order above — $n rounds in all. Nobody holds the money: the '
                  'circle collects and pays out in the same moment. If someone '
                  'cannot pay, the round still pays out, and their own turn '
                  'moves to the end until they catch up.',
                  style: Type.caption.copyWith(color: EvabobColors.nearBlack),
                ),
              ),
            if (_error != null) ...[
              const SizedBox(height: Space.sm),
              Text(_error!,
                  style: Type.caption.copyWith(color: EvabobColors.alert)),
            ],
            const SizedBox(height: Space.lg),
            SizedBox(
              height: 54,
              child: FilledButton(
                onPressed: _busy ? null : _create,
                child: _busy
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Start the circle'),
              ),
            ),
            const SizedBox(height: Space.sm),
            Text(
              'Everyone else gets an invite to join. It starts when all of '
              'you have joined.',
              textAlign: TextAlign.center,
              style: Type.caption.copyWith(color: EvabobColors.navyMuted),
            ),
          ],
        ),
      ),
    );
  }
}

class _CreatePotScreen extends StatefulWidget {
  const _CreatePotScreen();

  @override
  State<_CreatePotScreen> createState() => _CreatePotScreenState();
}

class _CreatePotScreenState extends State<_CreatePotScreen> {
  final _title = TextEditingController();
  final _details = TextEditingController();
  final _target = TextEditingController();
  final _for = TextEditingController();
  DateTime _deadline = DateTime.now().add(const Duration(days: 14));
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _title.dispose();
    _details.dispose();
    _target.dispose();
    _for.dispose();
    super.dispose();
  }

  Future<void> _pickDeadline() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _deadline,
      firstDate: now,
      lastDate: now.add(const Duration(days: 364)),
      helpText: 'Deadline',
    );
    if (picked != null && mounted) {
      setState(() =>
          _deadline = DateTime(picked.year, picked.month, picked.day, 23, 59));
    }
  }

  Future<void> _create() async {
    final target = double.tryParse(_target.text.trim());
    if (_title.text.trim().isEmpty) {
      setState(() => _error = 'Say what the collection is for');
      return;
    }
    if (target == null || target < 1) {
      setState(() => _error = 'Set a target of at least \$1');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final who = _for.text.trim();
      final res = await context.read<CircleWalletService>().createPot(
            context: context,
            title: _title.text.trim(),
            description: _details.text.trim(),
            targetUsdc: target,
            deadline: _deadline,
            beneficiary:
                who.isEmpty ? null : (who.contains('@') ? who : '@$who'),
          );
      if (!mounted) return;
      if (res['ok'] == true) {
        Navigator.of(context).pop(res['groupId']?.toString());
      } else {
        setState(() => _error = friendlyError(res['error'],
            fallback: 'The collection was not created.'));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      appBar: AppBar(title: const Text('New collection')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(Space.page),
          children: [
            TextField(
              controller: _title,
              maxLength: 80,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                labelText: 'What is it for?',
                hintText: "Mama Titi's hospital bill",
                counterText: '',
              ),
            ),
            TextField(
              controller: _details,
              maxLength: 400,
              maxLines: 3,
              minLines: 1,
              decoration: const InputDecoration(
                labelText: 'Details (optional)',
                counterText: '',
              ),
            ),
            const SizedBox(height: Space.sm),
            TextField(
              controller: _target,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [
                const AmountInputFormatter(),
              ],
              decoration: const InputDecoration(
                labelText: 'Target',
                prefixText: r'$ ',
              ),
            ),
            const SizedBox(height: Space.sm),
            TextField(
              controller: _for,
              decoration: const InputDecoration(
                labelText: 'Who receives it (optional)',
                hintText: '@username — leave empty for you',
              ),
            ),
            const SizedBox(height: Space.sm),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.event_outlined),
              title: Text(
                  'Deadline ${DateFormat('EEE d MMM yyyy').format(_deadline)}'),
              onTap: _pickDeadline,
            ),
            const SizedBox(height: Space.md),
            Container(
              padding: const EdgeInsets.all(Space.md),
              decoration: BoxDecoration(
                color: EvabobColors.sheet,
                borderRadius: Radii.all(Radii.md),
              ),
              child: Text(
                'Nobody holds the money, not even you. It goes to whoever '
                'receives it the moment the target is reached. If the deadline '
                'passes first, everyone gets back exactly what they put in, '
                'automatically. Anyone with the link can see the progress.',
                style: Type.caption.copyWith(color: EvabobColors.nearBlack),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: Space.sm),
              Text(_error!,
                  style: Type.caption.copyWith(color: EvabobColors.alert)),
            ],
            const SizedBox(height: Space.lg),
            SizedBox(
              height: 54,
              child: FilledButton(
                onPressed: _busy ? null : _create,
                child: _busy
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Start the collection'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
