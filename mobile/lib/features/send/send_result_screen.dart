import 'dart:async';
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/activity/activity_service.dart';
import '../../core/fx/fx_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/bundle_avatar.dart';

/// What a finished send shows: who, how much, and the proof.
class SendResult {
  const SendResult({
    required this.amount,
    required this.token,
    required this.fee,
    required this.recipientName,
    this.recipientAvatarUrl,
    this.recipientAvatarBundle,
    this.activityId,
    this.txHash,
    DateTime? at,
  }) : _at = at;

  final double amount;
  final String token;
  final double fee;
  final String recipientName;
  final String? recipientAvatarUrl;
  final int? recipientAvatarBundle;
  final String? activityId;
  final String? txHash;
  final DateTime? _at;

  DateTime get at => _at ?? DateTime.now();

  /// A short, quotable reference for the payment ("EVB-9F42C1").
  String get reference {
    final seed = (activityId ?? txHash ?? '').replaceAll(RegExp(r'[^A-Za-z0-9]'), '');
    if (seed.isEmpty) return '—';
    final tail = seed.length > 6 ? seed.substring(0, 6) : seed;
    return 'EVB-${tail.toUpperCase()}';
  }

  SendResult withTx(String? hash) => SendResult(
        amount: amount,
        token: token,
        fee: fee,
        recipientName: recipientName,
        recipientAvatarUrl: recipientAvatarUrl,
        recipientAvatarBundle: recipientAvatarBundle,
        activityId: activityId,
        txHash: hash ?? txHash,
        at: _at,
      );
}

/// Figma "Send · On the way" (17:609) until the payment lands, then
/// "Send · Sent" (2:121). A payment already landed opens straight on Sent.
Future<void> showSendResult(
  BuildContext context,
  SendResult result, {
  bool onTheWay = false,
}) {
  return Navigator.of(context, rootNavigator: true).push(
    MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => onTheWay
          ? SendOnTheWayScreen(result: result)
          : SendSentScreen(result: result),
    ),
  );
}

String _money(BuildContext context, double v, String token) =>
    context.watch<FxService>().primaryToken(v, token);

/// Figma 2:121 — the receipt the moment money lands.
class SendSentScreen extends StatelessWidget {
  const SendSentScreen({super.key, required this.result});

  final SendResult result;

  String _when(DateTime at) {
    final now = DateTime.now();
    final sameDay =
        at.year == now.year && at.month == now.month && at.day == now.day;
    final time = DateFormat('HH:mm').format(at);
    return sameDay ? 'Today, $time' : '${DateFormat('d MMM').format(at)}, $time';
  }

  Future<void> _share(BuildContext context) async {
    final activity = context.read<ActivityService>();
    final entry = activity.items.where((e) => e.id == result.activityId).firstOrNull;
    final fx = context.read<FxService>();
    final text = entry?.receiptText() ??
        'Evabob receipt\n'
            'Sent ${fx.primaryToken(result.amount, result.token)} to ${result.recipientName}\n'
            'When: ${_when(result.at)}\n'
            'Reference: ${result.reference}'
            '${result.txHash != null ? '\nTransaction: ${result.txHash}' : ''}';
    await SharePlus.instance.share(
      ShareParams(text: text, subject: 'Evabob receipt'),
    );
  }

  @override
  Widget build(BuildContext context) {
    final r = result;
    final amount = _money(context, r.amount, r.token);
    final total = _money(context, r.amount + r.fee, r.token);
    final hash = r.txHash;

    Widget row(String label, String value) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Text(label, style: Type.label.copyWith(color: EvabobColors.slate, height: 16 / 10)),
              const SizedBox(width: 16),
              Expanded(
                child: Text(
                  value,
                  textAlign: TextAlign.right,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Type.body.copyWith(color: EvabobColors.ink),
                ),
              ),
            ],
          ),
        );

    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, box) => SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: box.maxHeight),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SizedBox(height: 20),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Image.asset('assets/logo.png', width: 24, height: 24),
                  ),
                  const SizedBox(height: 3),
                  const Center(child: _SuccessMark()),
                  const SizedBox(height: 8),
                  Text(
                    'Bobbed!',
                    textAlign: TextAlign.center,
                    style: Type.title.copyWith(
                      fontSize: 24,
                      height: 32 / 24,
                      letterSpacing: -0.4,
                      color: EvabobColors.blue,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'You sent $amount to ${r.recipientName}',
                    textAlign: TextAlign.center,
                    style: Type.body.copyWith(color: EvabobColors.slate),
                  ),
                  const SizedBox(height: 28),
                  Container(
                    padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
                    decoration: BoxDecoration(
                      color: EvabobColors.white,
                      borderRadius: BorderRadius.circular(12),
                      boxShadow: Shadows.card,
                    ),
                    child: Column(
                      children: [
                        row('Status', 'Landed ✓'),
                        row('To', r.recipientName),
                        row('When', _when(r.at)),
                        row('Reference', r.reference),
                        // Kept on purpose: the proof someone can look up.
                        row('Trx Hash', hash == null || hash.isEmpty ? '—' : shortHash(hash, head: 5, tail: 4)),
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 4),
                          child: Divider(height: 1, color: EvabobColors.hairline),
                        ),
                        row('Amount', amount),
                        row('Fee', _money(context, r.fee, r.token)),
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Row(
                            children: [
                              Text('Total', style: Type.body.copyWith(height: 20 / 14)),
                              const Spacer(),
                              Text(total, style: Type.title),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 22),
                  Center(
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () => _share(context),
                      child: Text('Share receipt', style: Type.body.copyWith(color: EvabobColors.blue)),
                    ),
                  ),
                  const SizedBox(height: 24),
                  DecoratedBox(
                    decoration: const BoxDecoration(
                      borderRadius: BorderRadius.all(Radius.circular(999)),
                      boxShadow: [
                        BoxShadow(
                          color: Color(0x4D0077A8),
                          blurRadius: 24,
                          spreadRadius: -6,
                          offset: Offset(0, 10),
                        ),
                      ],
                    ),
                    child: SizedBox(
                      height: 56,
                      child: FilledButton(
                        onPressed: () => Navigator.of(context).pop(),
                        style: FilledButton.styleFrom(
                          backgroundColor: EvabobColors.blue,
                          shape: const StadiumBorder(),
                        ),
                        child: Text('Done', style: Type.body.copyWith(color: EvabobColors.white)),
                      ),
                    ),
                  ),
                  const SizedBox(height: 24),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The glowing disc with the check (Figma "success / glow", "disc",
/// "checkmark 1"). The glow is the design's own asset; flutter_svg drops SVG
/// filters, so its Gaussian blur (stdDeviation 22) is applied here.
class _SuccessMark extends StatelessWidget {
  const _SuccessMark();

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 218,
      height: 218,
      child: Stack(
        alignment: Alignment.center,
        children: [
          ImageFiltered(
            imageFilter: ImageFilter.blur(sigmaX: 22, sigmaY: 22),
            child: SvgPicture.asset('assets/figma/success_glow.svg', width: 218, height: 218),
          ),
          SvgPicture.asset('assets/figma/success_disc.svg', width: 65, height: 65),
          SvgPicture.asset('assets/figma/success_check.svg', width: 23, height: 23),
        ],
      ),
    );
  }
}

/// Figma 17:609 — shown while the payment is still moving. Watches the
/// activity row and moves on to the Sent receipt as soon as it lands.
class SendOnTheWayScreen extends StatefulWidget {
  const SendOnTheWayScreen({super.key, required this.result});

  final SendResult result;

  @override
  State<SendOnTheWayScreen> createState() => _SendOnTheWayScreenState();
}

class _SendOnTheWayScreenState extends State<SendOnTheWayScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _spin =
      AnimationController(vsync: this, duration: const Duration(seconds: 2))..repeat();
  Timer? _poll;
  int _tries = 0;

  @override
  void initState() {
    super.initState();
    _poll = Timer.periodic(const Duration(seconds: 3), (_) => _check());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _spin.dispose();
    super.dispose();
  }

  Future<void> _check() async {
    final id = widget.result.activityId;
    if (id == null || ++_tries > 40) {
      _poll?.cancel();
      return;
    }
    final activity = context.read<ActivityService>();
    await activity.refresh();
    if (!mounted) return;
    final entry = activity.items.where((e) => e.id == id).firstOrNull;
    if (entry == null || entry.isPending) return;
    _poll?.cancel();
    if (entry.didNotLand) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        fullscreenDialog: true,
        builder: (_) => SendSentScreen(result: widget.result.withTx(entry.txHash)),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.result;
    final first = r.recipientName.split(' ').first.replaceFirst('@', '');

    Widget step({
      required String badge,
      required String glyph,
      required Color glyphColor,
      required String title,
      required Color titleColor,
      required String subtitle,
      required Color subtitleColor,
    }) {
      return SizedBox(
        height: 72,
        child: Row(
          children: [
            SizedBox(
              width: 40,
              height: 40,
              child: Stack(
                alignment: Alignment.center,
                children: [
                  SvgPicture.asset(badge, width: 40, height: 40),
                  Text(
                    glyph,
                    style: TextStyle(
                      fontFamily: 'Inter',
                      fontWeight: FontWeight.w900,
                      fontSize: 14,
                      height: 18 / 14,
                      color: glyphColor,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Type.body.copyWith(color: titleColor)),
                  const SizedBox(height: 2),
                  Text(subtitle, style: Type.label.copyWith(color: subtitleColor)),
                ],
              ),
            ),
          ],
        ),
      );
    }

    const sep = Padding(
      padding: EdgeInsets.only(left: 52),
      child: Divider(height: 1, color: EvabobColors.hairline),
    );

    return Scaffold(
      backgroundColor: EvabobColors.white,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, box) => SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: box.maxHeight),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SizedBox(height: 106),
                  Center(
                    child: SizedBox(
                      width: 160,
                      height: 160,
                      child: Stack(
                        alignment: Alignment.center,
                        children: [
                          SvgPicture.asset('assets/figma/ring_track.svg', width: 160, height: 160),
                          RotationTransition(
                            turns: _spin,
                            child: SizedBox(
                              width: 160,
                              height: 160,
                              child: Align(
                                alignment: Alignment.centerRight,
                                child: SvgPicture.asset(
                                  'assets/figma/ring_progress.svg',
                                  width: 107.362,
                                  height: 160,
                                ),
                              ),
                            ),
                          ),
                          PeerAvatar(
                            name: r.recipientName,
                            avatarUrl: r.recipientAvatarUrl,
                            bundleIndex: r.recipientAvatarBundle,
                            size: 88,
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 42),
                  Text(
                    'On the way',
                    textAlign: TextAlign.center,
                    style: Type.title.copyWith(fontSize: 24, height: 32 / 24, letterSpacing: -0.4),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${_money(context, r.amount, r.token)} to ${r.recipientName}',
                    textAlign: TextAlign.center,
                    style: Type.body.copyWith(color: EvabobColors.slate),
                  ),
                  const SizedBox(height: 36),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    decoration: BoxDecoration(
                      color: EvabobColors.white,
                      borderRadius: BorderRadius.circular(12),
                      boxShadow: Shadows.card,
                    ),
                    child: Column(
                      children: [
                        step(
                          badge: 'assets/figma/step_done_badge.svg',
                          glyph: '✓',
                          glyphColor: EvabobColors.blue,
                          title: 'Left your balance',
                          titleColor: EvabobColors.ink,
                          subtitle: 'Just now',
                          subtitleColor: EvabobColors.slate,
                        ),
                        sep,
                        step(
                          badge: 'assets/figma/step_done_badge.svg',
                          glyph: '→',
                          glyphColor: EvabobColors.blue,
                          title: 'On its way',
                          titleColor: EvabobColors.ink,
                          subtitle: 'Usually a few seconds',
                          subtitleColor: EvabobColors.blue,
                        ),
                        sep,
                        step(
                          badge: 'assets/figma/step_todo_badge.svg',
                          glyph: '○',
                          glyphColor: EvabobColors.inkTertiary,
                          title: 'Landed',
                          titleColor: EvabobColors.inkTertiary,
                          subtitle: '$first will see it right away',
                          subtitleColor: EvabobColors.inkTertiary,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 28),
                  Text(
                    "You can close this. We'll tell you the second it lands.",
                    textAlign: TextAlign.center,
                    style: Type.label.copyWith(color: EvabobColors.inkTertiary),
                  ),
                  const SizedBox(height: 26),
                  SizedBox(
                    height: 56,
                    child: TextButton(
                      onPressed: () => Navigator.of(context).pop(),
                      style: TextButton.styleFrom(
                        backgroundColor: EvabobColors.white,
                        shape: const StadiumBorder(),
                      ),
                      child: Text('Done', style: Type.body),
                    ),
                  ),
                  const SizedBox(height: 24),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
