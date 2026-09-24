import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/fx/fx_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/bundle_avatar.dart';
import 'invoice_history.dart';
import 'payment_link_screen.dart';

/// Figma "Request · history" (21:1333): what you asked for, and what was
/// asked of you — waiting first, then done.
class RequestHistoryScreen extends StatefulWidget {
  const RequestHistoryScreen({super.key, this.onAsk});

  /// "Ask for money": back to the request form.
  final VoidCallback? onAsk;

  static Future<void> open(BuildContext context, {VoidCallback? onAsk}) {
    return Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => RequestHistoryScreen(onAsk: onAsk),
      ),
    );
  }

  @override
  State<RequestHistoryScreen> createState() => _RequestHistoryScreenState();
}

class _RequestHistoryScreenState extends State<RequestHistoryScreen> {
  bool _received = false;
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _rows = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await context.read<ApiClient>().get(
        '/v1/payment-requests',
        query: {'role': _received ? 'received' : 'sent'},
      );
      final items = (data['items'] as List?) ?? const [];
      if (!mounted) return;
      setState(() {
        _rows = items.map((e) => Map<String, dynamic>.from(e as Map)).toList();
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = friendlyError(e, fallback: 'Could not load your requests.');
      });
    }
  }

  static bool _waiting(Map<String, dynamic> r) =>
      const {'open', 'partial'}.contains(r['status']?.toString());

  static String _ago(DateTime at) {
    final now = DateTime.now();
    final days = DateTime(now.year, now.month, now.day)
        .difference(DateTime(at.year, at.month, at.day))
        .inDays;
    if (days <= 0) return 'today';
    if (days == 1) return 'yesterday';
    return '$days days ago';
  }

  static String _on(DateTime at) {
    final now = DateTime.now();
    final days = DateTime(now.year, now.month, now.day)
        .difference(DateTime(at.year, at.month, at.day))
        .inDays;
    if (days <= 0) return 'today';
    if (days == 1) return 'yesterday';
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    return 'on ${at.day} ${months[at.month - 1]}';
  }

  String _status(Map<String, dynamic> r) {
    final created =
        DateTime.tryParse(r['createdAt']?.toString() ?? '')?.toLocal() ??
            DateTime.now();
    final paidAt = DateTime.tryParse(r['paidAt']?.toString() ?? '')?.toLocal();
    switch (r['status']?.toString()) {
      case 'open':
      case 'partial':
        return 'Asked ${_ago(created)}';
      case 'paid':
      case 'released':
      case 'escrow':
        return 'Paid ${_on(paidAt ?? created)}';
      case 'cancelled':
        return _received ? 'They cancelled' : 'You cancelled';
      case 'declined':
        return _received ? 'You declined' : 'They declined';
      case 'expired':
        return 'Expired';
      case 'refunded':
        return 'Refunded';
      default:
        return r['status']?.toString() ?? '';
    }
  }

  Future<void> _open(Map<String, dynamic> r) async {
    final id = r['id']?.toString();
    if (id == null) return;
    if (_received && _waiting(r)) {
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (ctx) => PaymentLinkScreen(
            requestId: id,
            onBack: () => Navigator.of(ctx).pop(),
          ),
        ),
      );
    } else {
      await openInvoiceDetail(context, r);
    }
    if (mounted) _load();
  }

  @override
  Widget build(BuildContext context) {
    final waiting = _rows.where(_waiting).toList();
    final done = _rows.where((r) => !_waiting(r)).toList();
    const section = TextStyle(
      fontSize: 10,
      height: 14 / 10,
      letterSpacing: .8,
      color: EvabobColors.inkTertiary,
    );

    Widget seg(String label, bool on, VoidCallback tap) => Expanded(
          child: GestureDetector(
            onTap: tap,
            child: Container(
              height: 40,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: on ? EvabobColors.blue : EvabobColors.white,
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(
                label,
                style: Type.body.copyWith(
                  color: on ? EvabobColors.white : EvabobColors.slate,
                ),
              ),
            ),
          ),
        );

    Widget card(List<Map<String, dynamic>> list) => Container(
          decoration: const BoxDecoration(
            color: EvabobColors.white,
            borderRadius: BorderRadius.all(Radius.circular(12)),
            boxShadow: Shadows.card,
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(
            children: [
              for (var i = 0; i < list.length; i++) ...[
                _Row(
                  row: list[i],
                  status: _status(list[i]),
                  muted: const {'cancelled', 'declined', 'expired'}
                      .contains(list[i]['status']?.toString()),
                  onTap: () => _open(list[i]),
                ),
                if (i < list.length - 1)
                  const Padding(
                    padding: EdgeInsets.only(left: 68, right: 20),
                    child: Divider(height: 1, color: EvabobColors.hairline),
                  ),
              ],
            ],
          ),
        );

    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 10, 20, 0),
              child: SizedBox(
                height: 44,
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    Align(
                      alignment: Alignment.centerLeft,
                      child: Semantics(
                        button: true,
                        label: 'Back',
                        child: GestureDetector(
                          onTap: () => Navigator.of(context).maybePop(),
                          child: SizedBox.square(
                            dimension: 44,
                            child: Stack(
                              alignment: Alignment.center,
                              children: [
                                SvgPicture.asset('assets/figma/btn_back.svg',
                                    width: 44, height: 44),
                                const Text(
                                  '‹',
                                  style: TextStyle(
                                    fontFamily: 'Inter',
                                    fontWeight: FontWeight.w900,
                                    fontSize: 22,
                                    height: 28 / 22,
                                    color: EvabobColors.ink,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                    Text(
                      'Requests',
                      style: Type.title.copyWith(
                        fontSize: 24,
                        height: 32 / 24,
                        letterSpacing: -0.4,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 0),
              child: Row(
                children: [
                  seg('You asked', !_received, () {
                    if (_received) {
                      setState(() => _received = false);
                      _load();
                    }
                  }),
                  const SizedBox(width: 8),
                  seg('Asked of you', _received, () {
                    if (!_received) {
                      setState(() => _received = true);
                      _load();
                    }
                  }),
                ],
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                color: EvabobColors.blue,
                onRefresh: _load,
                child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
                  children: [
                    if (_loading && _rows.isEmpty)
                      const Padding(
                        padding: EdgeInsets.all(40),
                        child: Center(
                          child: CircularProgressIndicator(
                              color: EvabobColors.blue),
                        ),
                      )
                    else if (_error != null)
                      Text(_error!,
                          style: Type.body.copyWith(color: EvabobColors.slate))
                    else if (_rows.isEmpty)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 48),
                        child: Text(
                          _received
                              ? 'No one has asked you for money yet.'
                              : 'You have not asked anyone for money yet.',
                          textAlign: TextAlign.center,
                          style:
                              Type.body.copyWith(color: EvabobColors.slate),
                        ),
                      )
                    else ...[
                      if (waiting.isNotEmpty) ...[
                        const Text('WAITING', style: section),
                        const SizedBox(height: 10),
                        card(waiting),
                        const SizedBox(height: 32),
                      ],
                      if (done.isNotEmpty) ...[
                        const Text('DONE', style: section),
                        const SizedBox(height: 10),
                        card(done),
                      ],
                    ],
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
              child: DecoratedBox(
                decoration: const BoxDecoration(
                  borderRadius: BorderRadius.all(Radius.circular(999)),
                  boxShadow: [
                    BoxShadow(
                      color: Color(0x4700B5FF),
                      blurRadius: 24,
                      spreadRadius: -6,
                      offset: Offset(0, 10),
                    ),
                  ],
                ),
                child: SizedBox(
                  width: double.infinity,
                  height: 56,
                  child: FilledButton(
                    onPressed: () {
                      Navigator.of(context).maybePop();
                      widget.onAsk?.call();
                    },
                    style: FilledButton.styleFrom(
                      backgroundColor: EvabobColors.blue,
                      shape: const StadiumBorder(),
                    ),
                    child: Text(
                      'Ask for money',
                      style: Type.body.copyWith(color: EvabobColors.white),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({
    required this.row,
    required this.status,
    required this.muted,
    required this.onTap,
  });

  final Map<String, dynamic> row;
  final String status;
  final bool muted;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final person = row['person'] is Map
        ? Map<String, dynamic>.from(row['person'] as Map)
        : const <String, dynamic>{};
    final name = person['name']?.toString() ??
        row['receiverHandle']?.toString() ??
        (row['description']?.toString().isNotEmpty == true
            ? row['description'].toString()
            : 'Anyone with the link');
    final total = (row['total'] as num?)?.toDouble() ??
        (row['amount'] as num?)?.toDouble() ??
        0;
    final display = row['display'] is Map
        ? Map<String, dynamic>.from(row['display'] as Map)
        : const <String, dynamic>{};
    final amount = context.watch<FxService>().requestPrimary(
          usd: total,
          token: row['token']?.toString() ?? 'USDC',
          displayCurrency: display['currency']?.toString(),
          displayAmount: (display['amount'] as num?)?.toDouble(),
        );
    return InkWell(
      onTap: onTap,
      child: SizedBox(
        height: 72,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 20, 0),
          child: Row(
            children: [
              PeerAvatar(
                name: name,
                avatarUrl: person['avatarUrl']?.toString(),
                bundleIndex: (person['avatarBundle'] as num?)?.toInt(),
                size: 40,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name.split(' ').first,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Type.body,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      status,
                      style: Type.label.copyWith(color: EvabobColors.slate),
                    ),
                  ],
                ),
              ),
              Text(
                amount,
                style: Type.body.copyWith(
                  color: muted ? EvabobColors.slate : EvabobColors.ink,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
