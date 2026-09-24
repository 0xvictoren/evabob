import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/agents/agent_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/glass.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';
import 'package:evabob_mobile/core/utils/amount_input.dart';

/// Sets an agent's allowance in the shape people already use for pocket
/// money: an amount, a window, what it may be spent on, and the point above
/// which the owner wants to be asked.
///
/// Pops `(label, allowance)`. The label is only asked for on create.
class AllowanceSheet extends StatefulWidget {
  const AllowanceSheet({super.key, this.initial, this.askLabel = false});

  final AgentAllowance? initial;
  final bool askLabel;

  @override
  State<AllowanceSheet> createState() => _AllowanceSheetState();
}

class _AllowanceSheetState extends State<AllowanceSheet> {
  late final _label = TextEditingController(text: 'Research agent');
  late final _amount =
      TextEditingController(text: _plain(widget.initial?.amountUsdc ?? 20));
  late final _askAbove =
      TextEditingController(text: _plain(widget.initial?.askAboveUsdc ?? 2));
  late String _window = widget.initial?.window ?? 'week';
  late final Set<String> _categories = {...?widget.initial?.categories};
  late bool _proofOnly = widget.initial?.proofOnly ?? true;
  String? _error;

  static String _plain(double v) =>
      v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(2);

  @override
  void dispose() {
    _label.dispose();
    _amount.dispose();
    _askAbove.dispose();
    super.dispose();
  }

  String get _preview {
    final amount = double.tryParse(_amount.text) ?? 0;
    final what = _categories.isEmpty
        ? 'anything on the approved list'
        : '${_categories.map((c) => AgentAllowance.categoryLabels[c]!.toLowerCase()).join(', ')} only';
    final when = switch (_window) {
      'day' => 'today',
      'month' => 'this month',
      _ => 'this week',
    };
    return '${formatTokenAmount(amount)} $when, $what';
  }

  void _save() {
    final amount = double.tryParse(_amount.text.trim());
    final ask = double.tryParse(_askAbove.text.trim());
    if (amount == null || amount <= 0) {
      setState(() => _error = 'Enter how much it may spend.');
      return;
    }
    if (ask == null || ask < 0 || ask > amount) {
      setState(() =>
          _error = 'The ask-me limit must be between \$0 and the allowance.');
      return;
    }
    Navigator.pop(
      context,
      (
        _label.text.trim().isEmpty ? 'Agent wallet' : _label.text.trim(),
        AgentAllowance(
          amountUsdc: amount,
          window: _window,
          categories: _categories.toList(),
          askAboveUsdc: ask,
          proofOnly: _proofOnly,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final money = [const AmountInputFormatter()];
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        top: false,
        child: Container(
          margin: const EdgeInsets.all(Space.md),
          padding: const EdgeInsets.all(Space.lg),
          decoration: BoxDecoration(
            color: EvabobColors.sheet,
            borderRadius: Radii.all(Radii.lg),
            boxShadow: Shadows.raised,
          ),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(widget.askLabel ? 'New agent allowance' : 'Allowance',
                    style: Type.title.copyWith(color: EvabobColors.nearBlack)),
                const SizedBox(height: 4),
                Text(
                  'Like pocket money: an amount, how often it refills, and '
                  'what it may be spent on.',
                  style: Type.caption.copyWith(color: EvabobColors.navyMuted),
                ),
                const SizedBox(height: Space.md),
                if (widget.askLabel)
                  TextField(
                    controller: _label,
                    maxLength: 40,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: const InputDecoration(
                      labelText: 'What is it for?',
                      counterText: '',
                    ),
                  ),
                TextField(
                  controller: _amount,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  inputFormatters: money,
                  onChanged: (_) => setState(() {}),
                  decoration: const InputDecoration(
                    labelText: 'It may spend',
                    prefixText: r'$ ',
                  ),
                ),
                const SizedBox(height: Space.sm),
                Wrap(
                  spacing: 8,
                  children: [
                    for (final w in const ['day', 'week', 'month'])
                      ChoiceChip(
                        label: Text(AgentAllowance.windowWords[w]!),
                        selected: _window == w,
                        onSelected: (_) => setState(() => _window = w),
                      ),
                  ],
                ),
                const SizedBox(height: Space.md),
                Text('On',
                    style: Type.label.copyWith(color: EvabobColors.nearBlack)),
                const SizedBox(height: Space.xs),
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    FilterChip(
                      label: const Text('Anything on the list'),
                      selected: _categories.isEmpty,
                      onSelected: (_) => setState(_categories.clear),
                    ),
                    for (final e in AgentAllowance.categoryLabels.entries)
                      FilterChip(
                        label: Text(e.value),
                        selected: _categories.contains(e.key),
                        onSelected: (on) => setState(() => on
                            ? _categories.add(e.key)
                            : _categories.remove(e.key)),
                      ),
                  ],
                ),
                const SizedBox(height: Space.md),
                TextField(
                  controller: _askAbove,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  inputFormatters: money,
                  decoration: const InputDecoration(
                    labelText: 'Ask me first for anything over',
                    prefixText: r'$ ',
                    helperText:
                        'Below this it just pays. Above it you get a push to '
                        'approve. It never goes past the allowance.',
                    helperMaxLines: 3,
                  ),
                ),
                const SizedBox(height: Space.sm),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _proofOnly,
                  onChanged: (v) => setState(() => _proofOnly = v),
                  title: const Text('Only pay after proof'),
                  subtitle: const Text(
                    'Pay only sellers who take the money after checking what '
                    'they sent back. Nothing usable, nothing paid.',
                  ),
                ),
                const SizedBox(height: Space.sm),
                Glass(
                  child: Text(
                    _preview,
                    style: Type.body.copyWith(color: EvabobColors.nearBlack),
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: Space.sm),
                  Text(_error!,
                      style: Type.caption.copyWith(color: EvabobColors.alert)),
                ],
                const SizedBox(height: Space.lg),
                SizedBox(
                  width: double.infinity,
                  height: 52,
                  child: FilledButton(
                    onPressed: _save,
                    child: Text(widget.askLabel ? 'Create' : 'Save'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The live meter: spent, waiting on a check, left, and when it refills.
class AllowanceMeter extends StatelessWidget {
  const AllowanceMeter({super.key, required this.meter, this.compact = false});

  final AgentMeter meter;
  final bool compact;

  static const _days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  String get _resets {
    final at = meter.resetsAt?.toLocal();
    if (at == null) return '';
    final now = DateTime.now();
    if (at.difference(now).inHours < 24 && at.day != now.day) {
      return 'refills tomorrow';
    }
    if (at.difference(now).inHours < 24) {
      return 'refills at ${at.hour.toString().padLeft(2, '0')}:00';
    }
    if (at.difference(now).inDays < 7) {
      return 'refills ${_days[at.weekday - 1]}';
    }
    return 'refills ${at.day}/${at.month}';
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(6),
          child: SizedBox(
            height: compact ? 6 : 10,
            child: LayoutBuilder(
              builder: (context, box) => Stack(
                children: [
                  Container(color: EvabobColors.hairline),
                  Container(
                    width: box.maxWidth *
                        (meter.spentFraction + meter.heldFraction).clamp(0, 1),
                    color: EvabobColors.blue.withValues(alpha: 0.35),
                  ),
                  Container(
                    width: box.maxWidth * meter.spentFraction,
                    color: EvabobColors.blue,
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: 4),
        Text(
          [
            '${formatTokenAmount(meter.spentUsdc)} spent',
            if (meter.heldUsdc > 0) '${formatTokenAmount(meter.heldUsdc)} waiting',
            '${formatTokenAmount(meter.remainingUsdc)} left',
            if (!compact && _resets.isNotEmpty) _resets,
          ].join(' · '),
          style: Type.caption.copyWith(color: EvabobColors.navyMuted),
        ),
      ],
    );
  }
}

/// A payment above the owner's limit: approve or decline, right here.
class ApprovalTile extends StatefulWidget {
  const ApprovalTile(
      {super.key, required this.agentId, required this.approval});

  final String agentId;
  final AgentApproval approval;

  @override
  State<ApprovalTile> createState() => _ApprovalTileState();
}

class _ApprovalTileState extends State<ApprovalTile> {
  bool _busy = false;

  Future<void> _answer(bool approve) async {
    setState(() => _busy = true);
    try {
      await context
          .read<AgentService>()
          .answerApproval(widget.agentId, widget.approval.id, approve);
      if (!mounted) return;
      showTopSnack(
          context,
          SnackBar(
            content: Text(approve
                ? 'Approved. It goes through when the agent tries again.'
                : 'Declined. The agent has been told no.'),
            behavior: SnackBarBehavior.floating,
          ));
    } catch (e) {
      if (!mounted) return;
      showTopSnack(
          context,
          SnackBar(
            content: Text(friendlyError(e)),
            behavior: SnackBarBehavior.floating,
          ));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final a = widget.approval;
    return Glass(
      heavy: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            a.isTask
                ? 'Wants to hire someone for ${formatTokenAmount(a.amountUsdc)}'
                : 'Wants to spend ${formatTokenAmount(a.amountUsdc)}',
            style: Type.body.copyWith(color: EvabobColors.nearBlack),
          ),
          Text(
            [
              a.seller,
              AgentAllowance.categoryLabels[a.category] ?? a.category,
              'above your limit',
            ].where((s) => s.isNotEmpty).join(' · '),
            style: Type.caption.copyWith(color: EvabobColors.navyMuted),
          ),
          const SizedBox(height: Space.sm),
          Row(
            children: [
              FilledButton(
                onPressed: _busy ? null : () => _answer(true),
                child: const Text('Approve'),
              ),
              const SizedBox(width: Space.sm),
              OutlinedButton(
                onPressed: _busy ? null : () => _answer(false),
                child: const Text('Decline'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// The agent's payable name: "@name · owned by you".
class AgentNameCard extends StatelessWidget {
  const AgentNameCard({super.key, required this.wallet});

  final AgentWalletModel wallet;

  Future<void> _claim(BuildContext context) async {
    final ctrl = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Give it a name'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: ctrl,
              autofocus: true,
              decoration: const InputDecoration(
                prefixText: '@',
                hintText: 'ada_research',
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'People and software can pay it by this name, and wherever it '
              'appears you are shown as its owner. Names are permanent.',
              style: TextStyle(fontSize: 10, color: EvabobColors.navyMuted),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
            child: const Text('Use this name'),
          ),
        ],
      ),
    );
    if (name == null || name.isEmpty || !context.mounted) return;
    try {
      await context.read<AgentService>().claimName(wallet.id, name);
    } catch (e) {
      if (!context.mounted) return;
      showTopSnack(
          context,
          SnackBar(
            content: Text(friendlyError(e)),
            behavior: SnackBarBehavior.floating,
          ));
    }
  }

  @override
  Widget build(BuildContext context) {
    final handle = wallet.handle;
    return Glass(
      child: Row(
        children: [
          const Icon(Icons.badge_outlined, color: EvabobColors.navy),
          const SizedBox(width: Space.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  handle ?? 'No name yet',
                  style: Type.body.copyWith(color: EvabobColors.nearBlack),
                ),
                Text(
                  handle == null
                      ? 'Name it so people and software can pay it.'
                      : '${wallet.label} · owned by you'
                          '${wallet.handleOnChain ? '' : ' · registering'}',
                  style: Type.caption.copyWith(color: EvabobColors.navyMuted),
                ),
              ],
            ),
          ),
          if (handle == null)
            TextButton(
                onPressed: () => _claim(context), child: const Text('Name it'))
          else
            IconButton(
              tooltip: 'Copy name',
              icon: const Icon(Icons.copy_rounded, size: 18),
              onPressed: () => Clipboard.setData(ClipboardData(text: handle)),
            ),
        ],
      ),
    );
  }
}

/// People the agent hired, and whether the money reached them.
class AgentHires extends StatefulWidget {
  const AgentHires({super.key, required this.agentId});

  final String agentId;

  @override
  State<AgentHires> createState() => _AgentHiresState();
}

class _AgentHiresState extends State<AgentHires> {
  List<AgentTaskView>? _items;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final items = await context.read<AgentService>().tasks(widget.agentId);
      if (mounted) setState(() => _items = items);
    } catch (_) {
      if (mounted) setState(() => _items = const []);
    }
  }

  Future<void> _cancel(AgentTaskView t) async {
    try {
      await context.read<AgentService>().cancelTask(widget.agentId, t.id);
      await _load();
    } catch (e) {
      if (!mounted) return;
      showTopSnack(
          context,
          SnackBar(
            content: Text(friendlyError(e)),
            behavior: SnackBarBehavior.floating,
          ));
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    if (items == null || items.isEmpty) return const SizedBox.shrink();
    return Glass(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('People it hired',
              style: Type.body.copyWith(color: EvabobColors.nearBlack)),
          const SizedBox(height: 2),
          Text(
            'The money is set aside before anyone starts. Delivery releases '
            'it; nothing delivered sends it back.',
            style: Type.caption.copyWith(color: EvabobColors.navyMuted),
          ),
          for (final t in items.take(10))
            Padding(
              padding: const EdgeInsets.only(top: Space.sm),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(t.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Type.caption
                                .copyWith(color: EvabobColors.nearBlack)),
                        Text(
                          '${t.person ?? 'Open to anyone'} · ${t.statusText}',
                          style: Type.caption
                              .copyWith(color: EvabobColors.navyMuted),
                        ),
                      ],
                    ),
                  ),
                  Text(formatTokenAmount(t.amountUsdc),
                      style:
                          Type.caption.copyWith(color: EvabobColors.nearBlack)),
                  if (t.status == 'open' || t.status == 'awaiting_approval')
                    IconButton(
                      tooltip: 'Cancel',
                      icon: const Icon(Icons.close_rounded, size: 18),
                      onPressed: () => _cancel(t),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// Recent paid calls, each with its evidence bundle to export.
class AgentPayments extends StatefulWidget {
  const AgentPayments({super.key, required this.agentId});

  final String agentId;

  @override
  State<AgentPayments> createState() => _AgentPaymentsState();
}

class _AgentPaymentsState extends State<AgentPayments> {
  List<AgentPayment>? _items;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final items = await context.read<AgentService>().payments(widget.agentId);
      if (mounted) {
        setState(() => _items = items.where((p) => !p.isHire).toList());
      }
    } catch (_) {
      if (mounted) setState(() => _items = const []);
    }
  }

  /// Shares the bundle as a JSON file: what the owner authorised, what was
  /// asked, what came back, hashed and timestamped.
  Future<void> _export(AgentPayment p) async {
    try {
      final bundle =
          await context.read<AgentService>().evidence(widget.agentId, p.key);
      if (!mounted) return;
      final bytes =
          utf8.encode(const JsonEncoder.withIndent('  ').convert(bundle));
      final box = context.findRenderObject() as RenderBox?;
      await SharePlus.instance.share(ShareParams(
        files: [
          XFile.fromData(
            bytes,
            mimeType: 'application/json',
            name:
                'evabob-evidence-${p.key.substring(0, p.key.length.clamp(0, 16))}.json',
          ),
        ],
        text: 'Evidence for a ${formatTokenAmount(p.amountUsdc)} payment by my agent',
        sharePositionOrigin:
            box != null ? box.localToGlobal(Offset.zero) & box.size : null,
      ));
    } catch (e) {
      if (!mounted) return;
      showTopSnack(
          context,
          SnackBar(
            content: Text(friendlyError(e)),
            behavior: SnackBarBehavior.floating,
          ));
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    if (items == null || items.isEmpty) return const SizedBox.shrink();
    return Glass(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('What it paid for',
              style: Type.body.copyWith(color: EvabobColors.nearBlack)),
          const SizedBox(height: 2),
          Text(
            'Each payment keeps its evidence: what you allowed, what was '
            'asked, and what came back. Share it if a seller argues.',
            style: Type.caption.copyWith(color: EvabobColors.navyMuted),
          ),
          for (final p in items.take(15))
            Padding(
              padding: const EdgeInsets.only(top: Space.sm),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(p.seller ?? Uri.tryParse(p.url)?.host ?? p.url,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Type.caption
                                .copyWith(color: EvabobColors.nearBlack)),
                        Text(
                          [
                            p.statusWord,
                            if (p.settlement == 'proof') 'paid after proof',
                          ].join(' · '),
                          style: Type.caption.copyWith(
                            color: p.status == 'disputed'
                                ? EvabobColors.alert
                                : EvabobColors.navyMuted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Text(formatTokenAmount(p.amountUsdc),
                      style: Type.caption.copyWith(
                        color: EvabobColors.nearBlack,
                        decoration:
                            p.status == 'refunded' || p.status == 'released'
                                ? TextDecoration.lineThrough
                                : null,
                      )),
                  if (p.evidenceId != null)
                    IconButton(
                      tooltip: 'Share evidence',
                      icon: const Icon(Icons.receipt_long_outlined, size: 18),
                      onPressed: () => _export(p),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
