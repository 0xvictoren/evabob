import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/agents/agent_tasks_api.dart';
import '../../core/api/api_client.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import '../held/held_payment_screen.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';

/// Work from agents: tasks software will pay a person for, with the money
/// set aside before anyone starts.
class AgentTasksScreen extends StatefulWidget {
  const AgentTasksScreen({super.key});

  @override
  State<AgentTasksScreen> createState() => _AgentTasksScreenState();
}

class _AgentTasksScreenState extends State<AgentTasksScreen> {
  late final AgentTasksApi _api = AgentTasksApi(context.read<ApiClient>());
  List<AgentTask>? _open;
  List<AgentTask>? _mine;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([_api.open(), _api.mine()]);
      if (!mounted) return;
      setState(() {
        _open = results[0];
        _mine = results[1];
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    }
  }

  Future<void> _openTask(AgentTask t) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => AgentTaskScreen(taskId: t.id),
    ));
    if (mounted) _load();
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
                title: 'Work from agents',
                onBack: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: ListView(
                  padding:
                      const EdgeInsets.fromLTRB(Space.page, 0, Space.page, 40),
                  children: [
                    Text(
                      'Software that needs a person. When you take a task, '
                      'the money is set aside for you before you start: '
                      'deliver and it is yours; nothing delivered, it goes '
                      'back.',
                      style:
                          Type.caption.copyWith(color: EvabobColors.navyMuted),
                    ),
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 40),
                        child: Text(_error!, textAlign: TextAlign.center),
                      ),
                    if (_mine != null && _mine!.isNotEmpty) ...[
                      const SizedBox(height: Space.md),
                      Text('Yours',
                          style: Type.label
                              .copyWith(color: EvabobColors.nearBlack)),
                      for (final t in _mine!)
                        _TaskTile(task: t, onTap: () => _openTask(t)),
                    ],
                    const SizedBox(height: Space.md),
                    Text('Open',
                        style:
                            Type.label.copyWith(color: EvabobColors.nearBlack)),
                    if (_open == null && _error == null)
                      const Padding(
                        padding: EdgeInsets.only(top: 40),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                    if (_open != null && _open!.isEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: Space.md),
                        child: Text('No open tasks right now.',
                            style: Type.caption
                                .copyWith(color: EvabobColors.navyMuted)),
                      ),
                    for (final t in _open ?? const <AgentTask>[])
                      _TaskTile(task: t, onTap: () => _openTask(t)),
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

class _TaskTile extends StatelessWidget {
  const _TaskTile({required this.task, required this.onTap});

  final AgentTask task;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: Space.sm),
      child: PressScale(
        onTap: onTap,
        child: Glass(
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(task.title,
                        style:
                            Type.body.copyWith(color: EvabobColors.nearBlack)),
                    Text(task.agentByline,
                        style: Type.caption
                            .copyWith(color: EvabobColors.navyMuted)),
                    Text(task.statusText,
                        style: Type.caption.copyWith(
                            color: task.moneySetAside
                                ? EvabobColors.emeraldDeep
                                : EvabobColors.navyMuted)),
                  ],
                ),
              ),
              Text(formatMoney(task.amountUsdc),
                  style: Type.body.copyWith(color: EvabobColors.nearBlack)),
            ],
          ),
        ),
      ),
    );
  }
}

/// One task: who is paying, their record, and "the money is set aside
/// before you start".
class AgentTaskScreen extends StatefulWidget {
  const AgentTaskScreen({super.key, required this.taskId});

  final String taskId;

  @override
  State<AgentTaskScreen> createState() => _AgentTaskScreenState();
}

class _AgentTaskScreenState extends State<AgentTaskScreen> {
  late final AgentTasksApi _api = AgentTasksApi(context.read<ApiClient>());
  AgentTask? _task;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final t = await _api.view(widget.taskId);
      if (mounted) setState(() => _task = t);
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    }
  }

  Future<void> _take() async {
    setState(() => _busy = true);
    try {
      await _api.take(widget.taskId);
      await _load();
      if (!mounted) return;
      showTopSnack(
          context,
          const SnackBar(
            content:
                Text('Taken. The money is being set aside for you — wait for '
                    '"Money set aside" before you start.'),
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
    final t = _task;
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: EvabobPageHeader(
                title: 'Task',
                onBack: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: ListView(
                  padding:
                      const EdgeInsets.fromLTRB(Space.page, 0, Space.page, 40),
                  children: [
                    if (t == null && _error == null)
                      const Padding(
                        padding: EdgeInsets.only(top: 80),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                    if (_error != null && t == null)
                      Padding(
                        padding: const EdgeInsets.only(top: 80),
                        child: Text(_error!, textAlign: TextAlign.center),
                      ),
                    if (t != null) ...[
                      Glass(
                        padding: const EdgeInsets.all(Space.lg),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(formatMoney(t.amountUsdc),
                                style: Type.hero.copyWith(
                                    fontSize: 40,
                                    color: EvabobColors.nearBlack)),
                            Text(t.title,
                                style: Type.title
                                    .copyWith(color: EvabobColors.nearBlack)),
                            if (t.description.isNotEmpty) ...[
                              const SizedBox(height: Space.sm),
                              Text(t.description,
                                  style: Type.body
                                      .copyWith(color: EvabobColors.navyMuted)),
                            ],
                            const SizedBox(height: Space.sm),
                            Text('Deliver within ${t.deliveryDays} days',
                                style: Type.caption
                                    .copyWith(color: EvabobColors.navyMuted)),
                          ],
                        ),
                      ),
                      const SizedBox(height: Space.md),
                      Glass(
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Icon(Icons.lock_clock_outlined,
                                color: EvabobColors.emeraldDeep),
                            const SizedBox(width: Space.md),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                      'The money is set aside before you start',
                                      style: Type.body.copyWith(
                                          color: EvabobColors.nearBlack)),
                                  Text(
                                    'When you take it, ${formatMoney(t.amountUsdc)} is locked '
                                    'for you. Deliver and mark it delivered: it is yours '
                                    'within 7 days. Nothing delivered in time, and it '
                                    'goes back to the agent.',
                                    style: Type.caption.copyWith(
                                        color: EvabobColors.navyMuted),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: Space.md),
                      Glass(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('Who is paying',
                                style: Type.label
                                    .copyWith(color: EvabobColors.nearBlack)),
                            Text(t.agentByline,
                                style: Type.body
                                    .copyWith(color: EvabobColors.nearBlack)),
                            Text(t.agentRecord,
                                style: Type.caption
                                    .copyWith(color: EvabobColors.navyMuted)),
                          ],
                        ),
                      ),
                      const SizedBox(height: Space.md),
                      Text(t.statusText,
                          style: Type.caption.copyWith(
                              color: t.moneySetAside
                                  ? EvabobColors.emeraldDeep
                                  : EvabobColors.navyMuted)),
                      const SizedBox(height: Space.md),
                      if (t.takeable)
                        SizedBox(
                          height: 52,
                          child: FilledButton(
                            onPressed: _busy ? null : _take,
                            child: const Text('Take this task'),
                          ),
                        ),
                      if (t.transferId != null)
                        SizedBox(
                          height: 52,
                          child: OutlinedButton(
                            onPressed: () => Navigator.of(context)
                                .push(MaterialPageRoute<void>(
                              builder: (_) =>
                                  HeldPaymentScreen(transferId: t.transferId!),
                            )),
                            child: const Text(
                                'Open the held payment · mark delivered'),
                          ),
                        ),
                    ],
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
