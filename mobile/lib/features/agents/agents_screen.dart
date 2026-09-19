import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/agents/agent_service.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/chat/chat_service.dart' show explorerTxHash;
import '../../core/notify/section_notify.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/widgets/glass.dart';
import '../../core/widgets/platform_fee_note.dart';
import 'agent_allowance_widgets.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';
import 'package:evabob_mobile/core/utils/amount_input.dart';

/// Create an agentic wallet, fund it, and copy the x402 API key.
class AgentsScreen extends StatefulWidget {
  const AgentsScreen({super.key, this.onBack, this.initialAgentId});

  final VoidCallback? onBack;

  /// Opens straight onto one agent, e.g. from an approval notification.
  final String? initialAgentId;

  @override
  State<AgentsScreen> createState() => _AgentsScreenState();
}

class _AgentsScreenState extends State<AgentsScreen> {
  late String? _openId = widget.initialAgentId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<AgentService>().refresh();
      try {
        context.read<SectionNotify>().clear('agents');
      } catch (_) {}
    });
  }

  Future<void> _create() async {
    final picked = await showModalBottomSheet<(String, AgentAllowance)>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => const AllowanceSheet(askLabel: true),
    );
    if (picked == null || !mounted) return;
    String? key;
    try {
      key = await context.read<AgentService>().create(
            label: picked.$1,
            allowance: picked.$2,
          );
    } catch (e) {
      if (!mounted) return;
      showTopSnack(
          context,
          SnackBar(
            content: Text(friendlyError(e)),
            behavior: SnackBarBehavior.floating,
          ));
      return;
    }
    if (!mounted) return;
    try {
      context.read<SectionNotify>().bump('agents');
    } catch (_) {}
    final shown = key;
    if (shown != null) {
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('API key'),
          content: SelectableText(
            shown,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 10),
          ),
          actions: [
            TextButton(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: shown));
                if (ctx.mounted) Navigator.pop(ctx);
              },
              child: const Text('Copy'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Done'),
            ),
          ],
        ),
      );
    }
  }

  /// One tap stops every agent. Undo is on the snackbar, not a dialog in
  /// front of it: the moment you need this is not the moment to confirm.
  Future<void> _freezeAll() async {
    final svc = context.read<AgentService>();
    try {
      if (svc.anyFrozen && !svc.anyActive) {
        await svc.unfreezeAll();
        return;
      }
      final n = await svc.freezeAll();
      if (!mounted) return;
      showTopSnack(
          context,
          SnackBar(
            content: Text(n == 0
                ? 'Nothing was spending.'
                : 'Frozen. ${n == 1 ? 'Your agent' : 'All $n agents'} stopped spending.'),
            behavior: SnackBarBehavior.floating,
            action: n == 0
                ? null
                : SnackBarAction(
                    label: 'Undo', onPressed: () => svc.unfreezeAll()),
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
    final agents = context.watch<AgentService>();
    return Scaffold(
      backgroundColor: Colors.transparent,
      floatingActionButtonLocation: FloatingActionButtonLocation.centerFloat,
      floatingActionButton: _openId == null
          ? FloatingActionButton(
              onPressed: _create,
              backgroundColor: EvabobColors.emerald,
              child:
                  const Icon(Icons.add_rounded, color: EvabobColors.onPrimary),
            )
          : null,
      body: SafeArea(
        child: _openId == null
            ? _list(agents)
            : _AgentDetail(
                walletId: _openId!,
                onBack: () => setState(() => _openId = null),
              ),
      ),
    );
  }

  Widget _list(AgentService agents) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 8, 16, 0),
          child: Row(
            children: [
              if (widget.onBack != null)
                IconButton(
                  onPressed: widget.onBack,
                  tooltip: 'Back',
                  icon: const Icon(Icons.chevron_left_rounded),
                ),
              const Expanded(
                child: Text(
                  'Agents',
                  style: TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w400,
                    color: EvabobColors.navy,
                  ),
                ),
              ),
              if (agents.wallets.isNotEmpty)
                agents.anyFrozen && !agents.anyActive
                    ? OutlinedButton.icon(
                        onPressed: _freezeAll,
                        icon: const Icon(Icons.play_arrow_rounded, size: 18),
                        label: const Text('Unfreeze'),
                      )
                    : FilledButton.icon(
                        style: FilledButton.styleFrom(
                            backgroundColor: EvabobColors.alert),
                        onPressed: agents.anyActive ? _freezeAll : null,
                        icon: const Icon(Icons.ac_unit_rounded, size: 18),
                        label: const Text('Freeze all'),
                      ),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 100),
            children: [
              const Text(
                'Set money aside for a piece of software to spend on your '
                'behalf, without giving it your main balance.',
                style: TextStyle(
                  fontSize: 10,
                  color: EvabobColors.navyMuted,
                ),
              ),
              const SizedBox(height: 14),
              const _PayableServices(),
              const SizedBox(height: 14),
              if (agents.loading && agents.wallets.isEmpty)
                const Padding(
                  padding: EdgeInsets.all(24),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (agents.wallets.isEmpty)
                Glass(
                  heavy: true,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Text(
                        'No agent wallet yet',
                        style: TextStyle(
                          fontWeight: FontWeight.w400,
                          fontSize: 14,
                          color: EvabobColors.navy,
                        ),
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'The key is how the software proves it is allowed to '
                        'spend. Put money in the wallet so it has something '
                        'to spend.',
                        style: TextStyle(
                          color: EvabobColors.navyMuted,
                          fontSize: 10,
                        ),
                      ),
                      const SizedBox(height: 12),
                      FilledButton(
                        onPressed: _create,
                        child: const Text('Create agent wallet'),
                      ),
                    ],
                  ),
                )
              else
                for (final w in agents.wallets) ...[
                  PressScale(
                    onTap: () => setState(() => _openId = w.id),
                    child: Glass(
                      heavy: w == agents.wallets.first,
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  w.label,
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w400,
                                    color: EvabobColors.navy,
                                  ),
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  formatMoney(w.balanceUsdc),
                                  style: const TextStyle(
                                    fontSize: 22,
                                    fontWeight: FontWeight.w400,
                                    color: EvabobColors.navy,
                                  ),
                                ),
                                const SizedBox(height: 6),
                                AllowanceMeter(meter: w.meter, compact: true),
                                const SizedBox(height: 4),
                                Text(
                                  w.paused
                                      ? (w.pauseReason == 'loop'
                                          ? 'Paused · it repeated one call too often'
                                          : w.pauseReason == 'freeze'
                                              ? 'Frozen'
                                              : 'Paused')
                                      : w.approvals.isNotEmpty
                                          ? '${w.approvals.length} waiting for your approval'
                                          : [
                                              if (w.handle != null) w.handle!,
                                              w.allowance.summary,
                                            ]
                                              .where((x) => x.isNotEmpty)
                                              .join(' · '),
                                  style: TextStyle(
                                    fontSize: 10,
                                    color: w.paused || w.approvals.isNotEmpty
                                        ? EvabobColors.alert
                                        : EvabobColors.navyMuted,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const Icon(Icons.chevron_right_rounded),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                ],
            ],
          ),
        ),
      ],
    );
  }
}

class _AgentDetail extends StatefulWidget {
  const _AgentDetail({required this.walletId, required this.onBack});

  final String walletId;
  final VoidCallback onBack;

  @override
  State<_AgentDetail> createState() => _AgentDetailState();
}

class _AgentDetailState extends State<_AgentDetail> {
  /// True while a key is being issued. The key itself is never stored in
  /// state — it is shown once in a dialog and then gone.
  bool _revealing = false;

  /// Shows a key exactly once, since the server does not keep a readable copy.
  /// It is never held in widget state — the dialog is the only place it
  /// appears, so it cannot be re-rendered after the user dismisses it.
  Future<void> _showKeyOnce(String key, {required String title}) async {
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SelectableText(
              key,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 10),
            ),
            const SizedBox(height: 10),
            const Text(
              'Copy this now. It is not stored and cannot be shown again — '
              'if you lose it, rotate to issue a new one.',
              style: TextStyle(fontSize: 10, color: EvabobColors.navyMuted),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: key));
              if (ctx.mounted) Navigator.pop(ctx);
            },
            child: const Text('Copy'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  /// Issues a replacement key. This is the recovery path for a key that was
  /// lost or leaked: the previous one stops working immediately, while the
  /// balance and history stay with the wallet.
  Future<void> _rotateKey() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Rotate API key?'),
        content: const Text(
          'The current key stops working straight away. Any agent still using '
          'it will stop being able to spend until you give it the new key.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Rotate'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() => _revealing = true);
    try {
      final key = await context.read<AgentService>().rotateKey(widget.walletId);
      if (!mounted) return;
      setState(() => _revealing = false);
      if (key != null) {
        await _showKeyOnce(key, title: 'New API key');
      }
    } catch (e) {
      if (mounted) {
        setState(() => _revealing = false);
        showTopSnack(
          context,
          SnackBar(
              content: Text(friendlyError(e)),
              behavior: SnackBarBehavior.floating),
        );
      }
    }
  }

  /// Kills the key. Deliberately separate from rotate: revoke is what you
  /// reach for when an agent is misbehaving and you want spending stopped now.
  Future<void> _revokeKey() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Stop this agent?'),
        content: const Text(
          'Stops this agent spending immediately. The remaining balance stays '
          'here and can still be withdrawn. Rotate later to issue a new key.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: EvabobColors.alert),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Stop agent'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await context.read<AgentService>().revoke(widget.walletId);
      if (!mounted) return;
      showTopSnack(
        context,
        const SnackBar(
          content: Text('Key revoked — that software can no longer spend'),
          behavior: SnackBarBehavior.floating,
        ),
      );
    } catch (e) {
      if (mounted) {
        showTopSnack(
          context,
          SnackBar(
              content: Text(friendlyError(e)),
              behavior: SnackBarBehavior.floating),
        );
      }
    }
  }

  /// Returns USDC from the agent wallet to the owner's own wallet.
  Future<void> _withdraw(double balanceUsdc) async {
    final amount = TextEditingController(text: balanceUsdc.toStringAsFixed(2));
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Take money out'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: amount,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
                  inputFormatters: const [AmountInputFormatter()],
              decoration: const InputDecoration(labelText: 'Amount in dollars'),
            ),
            const SizedBox(height: 8),
            Text(
              'Available ${formatMoney(balanceUsdc)}. '
              'Goes back to your own wallet.',
              style: const TextStyle(
                fontSize: 10,
                color: EvabobColors.navyMuted,
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
            child: const Text('Take money out'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;

    final amt = double.tryParse(amount.text.trim());
    if (amt == null || amt <= 0) return;
    try {
      await context.read<AgentService>().withdraw(widget.walletId, amt);
      if (!mounted) return;
      showTopSnack(
        context,
        SnackBar(
          content: Text('Withdrew ${formatMoney(amt)}'),
          behavior: SnackBarBehavior.floating,
        ),
      );
    } catch (e) {
      if (mounted) {
        showTopSnack(
          context,
          SnackBar(
              content: Text(friendlyError(e)),
              behavior: SnackBarBehavior.floating),
        );
      }
    }
  }

  Future<void> _fund() async {
    final amount = TextEditingController(text: '10');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Add money'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: amount,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
                  inputFormatters: const [AmountInputFormatter()],
              decoration: const InputDecoration(labelText: 'Amount in dollars'),
            ),
            const SizedBox(height: 8),
            const Text(
              'Moves money from your balance into this agent wallet.',
              style: TextStyle(fontSize: 10, color: EvabobColors.navyMuted),
            ),
            ValueListenableBuilder<TextEditingValue>(
              valueListenable: amount,
              builder: (_, value, __) => PlatformFeeNote(
                amount: double.tryParse(value.text) ?? 0,
                padding: const EdgeInsets.only(top: 12),
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
            child: const Text('Fund with PIN'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final v = double.tryParse(amount.text) ?? 0;
    if (v <= 0) return;
    final svc = context.read<AgentService>();
    final circle = context.read<CircleWalletService>();
    try {
      final custody = await svc.custodyAddress(widget.walletId);
      final addr = custody['address']?.toString();
      if (addr == null || !addr.startsWith('0x')) {
        throw Exception('Agent custody address unavailable');
      }
      if (!mounted) return;
      final fund = await circle.send(
        context: context,
        to: addr,
        amountUsdc: v,
        token: 'USDC',
        memo: 'Fund agent',
      );
      if (fund['ok'] != true) {
        throw Exception(fund['error']?.toString() ?? 'Fund transfer cancelled');
      }
      // The server verifies this transaction on chain before crediting, so the
      // hash has to be found before asking it to.
      //
      // A UCW send settles after the PIN, not with it, so the hash is rarely
      // at the top level of the response — it arrives inside the job's result
      // or meta. Reading only `fund['txHash']` meant every funding attempt
      // failed with "no transaction hash" even though the money had moved.
      var txHash = explorerTxHash(fund);
      if (txHash == null) {
        final ids = <String>[
          for (final c in (fund['challenges'] as List? ?? const []))
            if (c is Map && c['challengeId'] != null)
              c['challengeId'].toString(),
        ];
        if (ids.isNotEmpty) {
          final verified = await circle.verifyChallengesAndHash(
            challengeIds: ids,
            resolveTxHash: true,
          );
          txHash = explorerTxHash(verified);
        }
      }
      if (txHash == null || txHash.isEmpty) {
        throw Exception(
          'The transfer went through but has not settled yet. Your money is '
          'safe — try funding again in a moment.',
        );
      }
      await svc.deposit(widget.walletId, v, fundTxHash: txHash);
      if (!mounted) return;
      try {
        context.read<SectionNotify>().bump('agents');
        context.read<SectionNotify>().bump('activity');
      } catch (_) {}
      if (mounted) {
        showTopSnack(
          context,
          const SnackBar(
            content: Text('Agent funded'),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        showTopSnack(
          context,
          SnackBar(
              content: Text(friendlyError(e)),
              behavior: SnackBarBehavior.floating),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final agents = context.watch<AgentService>();
    final w = agents.wallets.cast<AgentWalletModel?>().firstWhere(
          (x) => x?.id == widget.walletId,
          orElse: () => null,
        );
    if (w == null) {
      return Center(
        child: TextButton(
          onPressed: widget.onBack,
          child: const Text('Back'),
        ),
      );
    }

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: [
        Row(
          children: [
            IconButton(
              onPressed: widget.onBack,
              tooltip: 'Back',
              icon: const Icon(Icons.chevron_left_rounded),
            ),
            Expanded(
              child: Text(
                w.label,
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w400,
                  color: EvabobColors.navy,
                ),
              ),
            ),
          ],
        ),
        Glass(
          heavy: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                formatMoney(w.balanceUsdc),
                style: const TextStyle(
                  fontSize: 48,
                  fontWeight: FontWeight.w400,
                  color: EvabobColors.navy,
                ),
              ),
              const SizedBox(height: 12),
              const Text(
                'Its key',
                style: TextStyle(
                  fontWeight: FontWeight.w400,
                  fontSize: 10,
                  color: EvabobColors.navy,
                ),
              ),
              const SizedBox(height: 4),
              Row(
                children: [
                  Expanded(
                    child: SelectableText(
                      // Only ever the prefix: the server keeps no readable
                      // copy, so a key is visible once at issue time.
                      '${w.apiKeyPrefix}••••••••',
                      style: TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 10,
                        color: w.active
                            ? EvabobColors.navy
                            : EvabobColors.navyMuted,
                        decoration:
                            w.active ? null : TextDecoration.lineThrough,
                      ),
                    ),
                  ),
                  if (!w.active)
                    const Padding(
                      padding: EdgeInsets.only(left: 6),
                      child: Text(
                        'REVOKED',
                        style: TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w400,
                          color: EvabobColors.alert,
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  FilledButton(
                    onPressed: _fund,
                    child: const Text('Add money'),
                  ),
                  OutlinedButton(
                    onPressed: w.balanceUsdc > 0
                        ? () => _withdraw(w.balanceUsdc)
                        : null,
                    child: const Text('Take money out'),
                  ),
                  OutlinedButton(
                    onPressed: _revealing ? null : _rotateKey,
                    child: Text(w.active ? 'Rotate key' : 'New key'),
                  ),
                  if (w.active)
                    TextButton(
                      onPressed: _revokeKey,
                      style: TextButton.styleFrom(
                        foregroundColor: EvabobColors.alert,
                      ),
                      child: const Text('Stop this agent'),
                    ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        _AllowanceCard(wallet: w),
        for (final a in w.approvals) ...[
          const SizedBox(height: 10),
          ApprovalTile(agentId: w.id, approval: a),
        ],
        const SizedBox(height: 14),
        AgentNameCard(wallet: w),
        const SizedBox(height: 14),
        AgentHires(agentId: w.id),
        const SizedBox(height: 14),
        AgentPayments(agentId: w.id),
        const SizedBox(height: 14),
        Glass(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Give this key to your software',
                style: TextStyle(
                  fontWeight: FontWeight.w400,
                  fontSize: 10,
                  color: EvabobColors.navy,
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'It can spend from this wallet only — never your main '
                'balance — and stops at its allowance. Pause it, freeze '
                'everything, or revoke the key any time.',
                style: TextStyle(fontSize: 10, color: EvabobColors.navyMuted),
              ),
              const SizedBox(height: 8),
              // The one genuinely developer-facing line on this screen. Kept,
              // because whoever wires up an agent needs it — but below the
              // explanation rather than instead of it.
              const Text(
                'For whoever sets it up: POST /v1/x402/pay with',
                style: TextStyle(fontSize: 10, color: EvabobColors.chalk),
              ),
              const Text(
                'Authorization: Bearer <key>',
                style: TextStyle(
                  fontSize: 10,
                  fontFamily: 'monospace',
                  color: EvabobColors.chalk,
                ),
              ),
              const Text(
                'Hire a person: POST /v1/agent-api/tasks · '
                'status: GET /v1/agent-api/me',
                style: TextStyle(fontSize: 10, color: EvabobColors.chalk),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// What an agent wallet can actually spend on, said before anyone funds one.
///
/// The catalog of paid services has sellers on Arc's main network and none on
/// its test network, so on testnet this says nothing is payable yet rather
/// than letting someone fund a wallet for spending that cannot happen.
class _PayableServices extends StatefulWidget {
  const _PayableServices();

  @override
  State<_PayableServices> createState() => _PayableServicesState();
}

class _PayableServicesState extends State<_PayableServices> {
  AgentServices? _services;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    context.read<AgentService>().services().then((s) {
      if (mounted) setState(() => _services = s);
    }).catchError((Object _) {
      if (mounted) setState(() => _failed = true);
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = _services;
    if (s == null && !_failed) return const SizedBox.shrink();
    final payable = s != null && s.items.isNotEmpty;
    return Glass(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'What an agent can pay for here',
            style: TextStyle(
              fontWeight: FontWeight.w400,
              fontSize: 14,
              color: EvabobColors.navy,
            ),
          ),
          const SizedBox(height: 6),
          if (!payable)
            Text(
              _failed
                  ? 'We could not load the list right now.'
                  : '${s?.note ?? 'Nothing yet.'} People here can sell to '
                      'agents from Get paid by agents. An agent wallet can '
                      'still hold money, and you can take it out any time.',
              style: const TextStyle(
                fontSize: 10,
                color: EvabobColors.navyMuted,
              ),
            )
          else
            for (final item in s.items.take(8))
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        [
                          item.provider,
                          if (item.description.isNotEmpty) item.description,
                          if (item.waitsForProof) 'paid after proof',
                        ].join(' · '),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 10,
                          color: EvabobColors.navyMuted,
                        ),
                      ),
                    ),
                    Text(
                      formatMoney(item.priceUsdc),
                      style: const TextStyle(
                        fontSize: 10,
                        color: EvabobColors.navy,
                      ),
                    ),
                  ],
                ),
              ),
        ],
      ),
    );
  }
}

/// The allowance, its live meter, and the controls that stop spending.
class _AllowanceCard extends StatelessWidget {
  const _AllowanceCard({required this.wallet});

  final AgentWalletModel wallet;

  Future<void> _edit(BuildContext context) async {
    final picked = await showModalBottomSheet<(String, AgentAllowance)>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => AllowanceSheet(initial: wallet.allowance),
    );
    if (picked == null || !context.mounted) return;
    await _run(context,
        () => context.read<AgentService>().setAllowance(wallet.id, picked.$2));
  }

  Future<void> _run(
      BuildContext context, Future<void> Function() action) async {
    try {
      await action();
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
    final w = wallet;
    final svc = context.read<AgentService>();
    return Glass(
      heavy: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  w.allowance.summary.isEmpty
                      ? 'Allowance'
                      : w.allowance.summary,
                  style:
                      const TextStyle(fontSize: 14, color: EvabobColors.navy),
                ),
              ),
              TextButton(
                  onPressed: () => _edit(context), child: const Text('Change')),
            ],
          ),
          Text(
            [
              'Asks you above ${formatMoney(w.allowance.askAboveUsdc)}',
              if (w.allowance.proofOnly) 'pays only after proof',
            ].join(' · '),
            style: const TextStyle(fontSize: 10, color: EvabobColors.navyMuted),
          ),
          const SizedBox(height: 10),
          AllowanceMeter(meter: w.meter),
          if (w.paused) ...[
            const SizedBox(height: 10),
            Text(
              w.pauseReason == 'loop'
                  ? 'Paused by the loop breaker: '
                      '${w.pauseDetail ?? 'it repeated one call too often'}. '
                      'That is how runaway bills start.'
                  : w.pauseReason == 'freeze'
                      ? 'Frozen with everything else.'
                      : 'Paused by you.',
              style: const TextStyle(fontSize: 10, color: EvabobColors.alert),
            ),
          ],
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: w.paused
                ? FilledButton.icon(
                    onPressed: () => _run(context, () => svc.resume(w.id)),
                    icon: const Icon(Icons.play_arrow_rounded, size: 18),
                    label: const Text('Resume'),
                  )
                : OutlinedButton.icon(
                    onPressed: () => _run(context, () => svc.pause(w.id)),
                    icon: const Icon(Icons.pause_rounded, size: 18),
                    label: const Text('Pause'),
                  ),
          ),
        ],
      ),
    );
  }
}
