import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/api/api_client.dart';
import '../../core/fx/fx_service.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/widgets/glass.dart';
import '../../core/widgets/motion.dart';

/// Invoices this user has raised, and whether anyone has paid them.
///
/// Generating an invoice used to be the end of the story — the link went out
/// and nothing ever came back. Someone who raised three of them had no way to
/// tell which had been settled short of watching their balance and guessing.
class InvoiceHistory extends StatefulWidget {
  const InvoiceHistory({super.key, this.refreshToken = 0});

  /// Bumped by the parent after a new invoice is created, so the list reloads
  /// without needing a shared controller between the two.
  final int refreshToken;

  @override
  State<InvoiceHistory> createState() => InvoiceHistoryState();
}

class InvoiceHistoryState extends State<InvoiceHistory> {
  List<Map<String, dynamic>> _rows = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    load();
  }

  @override
  void didUpdateWidget(InvoiceHistory oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.refreshToken != widget.refreshToken) load();
  }

  Future<void> load() async {
    if (mounted) setState(() => _error = null);
    try {
      final data = await context.read<ApiClient>().get('/v1/payment-requests');
      final items = (data['items'] as List?) ?? const [];
      if (!mounted) return;
      setState(() {
        _rows = items.map((e) => Map<String, dynamic>.from(e as Map)).toList();
        _loading = false;
      });
    } catch (e) {
      // Swallowing this made a failed fetch read as "you have no invoices",
      // which is a worrying thing to tell someone who has raised several.
      if (mounted) {
        setState(() {
          _loading = false;
          _error = friendlyError(e, fallback: 'Could not load your invoices.');
        });
      }
    }
  }

  /// Settled or still waiting.
  ///
  /// "escrow" counts as settled from the issuer's side — the payer has
  /// committed the money even though it has not been released yet — so it gets
  /// its own wording rather than being lumped in with either.
  static (String, Color) _state(String status) => switch (status) {
        'paid' || 'released' => ('Paid', EvabobColors.success),
        'escrow' => ('Held for you', EvabobColors.danger),
        'partial' => ('Part paid', EvabobColors.danger),
        'cancelled' => ('Cancelled', EvabobColors.navyMuted),
        'expired' => ('Expired', EvabobColors.navyMuted),
        _ => ('Not paid yet', EvabobColors.navyMuted),
      };

  @override
  Widget build(BuildContext context) {
    if (_loading) return const SizedBox.shrink();
    if (_error != null) {
      return Padding(
        padding: const EdgeInsets.only(top: Space.xl),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              _error!,
              style: Type.caption.copyWith(color: EvabobColors.navyMuted),
            ),
            TextButton(
              onPressed: load,
              style: TextButton.styleFrom(
                padding: EdgeInsets.zero,
                minimumSize: const Size(0, 44),
              ),
              child: Text(
                'Try again',
                style: Type.label.copyWith(color: EvabobColors.forest),
              ),
            ),
          ],
        ),
      );
    }
    if (_rows.isEmpty) {
      return Padding(
        padding: const EdgeInsets.only(top: Space.xl),
        child: Text(
          'Invoices you create will show up here, with whether they have been '
          'paid.',
          style: Type.caption.copyWith(color: EvabobColors.navyMuted),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: Space.xl),
        Text(
          'Your invoices',
          style: Type.section.copyWith(color: EvabobColors.nearBlack),
        ),
        const SizedBox(height: Space.md),
        for (var i = 0; i < _rows.length; i++)
          RiseIn(
            index: i,
            child: Padding(
              padding: const EdgeInsets.only(bottom: Space.sm),
              child: _Row(
                invoice: _rows[i],
                onTap: () => _openDetail(_rows[i]),
              ),
            ),
          ),
      ],
    );
  }

  Future<void> _openDetail(Map<String, dynamic> inv) async {
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (ctx) => _Detail(invoice: inv),
    );
    if (mounted) load();
  }
}

/// Opens one of your requests: its lines, who paid, and the link to share.
Future<void> openInvoiceDetail(
  BuildContext context,
  Map<String, dynamic> invoice,
) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    isScrollControlled: true,
    builder: (ctx) => _Detail(invoice: invoice),
  );
}

class _Row extends StatelessWidget {
  const _Row({required this.invoice, required this.onTap});

  final Map<String, dynamic> invoice;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final token = invoice['token']?.toString() ?? 'USDC';
    final total = (invoice['total'] as num?)?.toDouble() ??
        (invoice['amount'] as num?)?.toDouble() ??
        0;
    final status = invoice['status']?.toString() ?? 'open';
    final (label, colour) = InvoiceHistoryState._state(status);
    final description = invoice['description']?.toString() ?? '';

    return PressScale(
      scale: Motion.pressScale,
      onTap: onTap,
      child: Container(
        decoration: BoxDecoration(
          color: EvabobColors.sheet,
          borderRadius: Radii.all(Radii.md),
          border: Border.all(color: EvabobColors.hairline),
          boxShadow: Shadows.subtle,
        ),
        padding: const EdgeInsets.all(Space.lg),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    description.isEmpty ? 'Invoice' : description,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Type.label.copyWith(color: EvabobColors.nearBlack),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    label,
                    style: Type.micro.copyWith(
                      color: colour,
                      fontWeight: FontWeight.w400,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: Space.sm),
            Text(
              context.watch<FxService>().requestPrimary(
                usd: total,
                token: token,
                displayCurrency: (invoice['display'] as Map?)?['currency']
                    ?.toString(),
                displayAmount:
                    ((invoice['display'] as Map?)?['amount'] as num?)
                        ?.toDouble(),
              ),
              style: Type.amount.copyWith(color: EvabobColors.nearBlack),
            ),
            const SizedBox(width: Space.xs),
            const Icon(Icons.chevron_right_rounded,
                size: 18, color: EvabobColors.navyMuted),
          ],
        ),
      ),
    );
  }
}

/// The invoice itself: what was billed, what it came to, and how it settled.
class _Detail extends StatelessWidget {
  const _Detail({required this.invoice});

  final Map<String, dynamic> invoice;

  @override
  Widget build(BuildContext context) {
    final token = invoice['token']?.toString() ?? 'USDC';
    String money(num? v) => formatMoney((v ?? 0).toDouble(), token);

    final items = (invoice['items'] as List?) ?? const [];
    final status = invoice['status']?.toString() ?? 'open';
    final (label, colour) = InvoiceHistoryState._state(status);
    final link = invoice['link']?.toString() ??
        invoice['shareUrl']?.toString() ??
        'evabob://pay/${invoice['id']}';

    final paidBy =
        invoice['paidByLabel']?.toString() ?? invoice['paidBy']?.toString();
    final paidAt = invoice['paidAt']?.toString();
    final txHash = invoice['paidTxHash']?.toString();

    return SafeArea(
      top: false,
      child: Container(
        margin: const EdgeInsets.all(Space.md),
        decoration: BoxDecoration(
          color: EvabobColors.sheet,
          borderRadius: Radii.all(Radii.lg),
          border: Border.all(color: EvabobColors.hairline),
          boxShadow: Shadows.raised,
        ),
        padding: const EdgeInsets.all(Space.lg),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(
                    'Invoice',
                    style: Type.title.copyWith(color: EvabobColors.nearBlack),
                  ),
                  const Spacer(),
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: Space.md, vertical: Space.xs),
                    decoration: BoxDecoration(
                      color: colour.withValues(alpha: 0.12),
                      borderRadius: Radii.all(Radii.pill),
                    ),
                    child: Text(
                      label,
                      style: Type.micro.copyWith(
                        color: colour,
                        fontWeight: FontWeight.w400,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: Space.lg),

              for (final raw in items)
                if (raw is Map)
                  Padding(
                    padding: const EdgeInsets.only(bottom: Space.sm),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            raw['description']?.toString().isNotEmpty == true
                                ? raw['description'].toString()
                                : 'Item',
                            style: Type.body
                                .copyWith(color: EvabobColors.navyMuted),
                          ),
                        ),
                        Text(
                          money(raw['amount'] as num?),
                          style: Type.amountSmall
                              .copyWith(color: EvabobColors.nearBlack),
                        ),
                      ],
                    ),
                  ),

              const Divider(height: Space.xl),
              Row(
                children: [
                  Text('Total',
                      style:
                          Type.section.copyWith(color: EvabobColors.nearBlack)),
                  const Spacer(),
                  Text(
                    money(
                        invoice['total'] as num? ?? invoice['amount'] as num?),
                    style: Type.title.copyWith(color: EvabobColors.nearBlack),
                  ),
                ],
              ),

              // Only shown once there is something to show. An unpaid invoice
              // with an empty "Paid by —" reads as a fault rather than as a
              // thing that has not happened yet.
              if (paidBy != null || paidAt != null || txHash != null) ...[
                const SizedBox(height: Space.lg),
                Container(
                  width: double.infinity,
                  decoration: BoxDecoration(
                    color: EvabobColors.mint,
                    borderRadius: Radii.all(Radii.md),
                  ),
                  padding: const EdgeInsets.all(Space.lg),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (paidBy != null)
                        _Fact(label: 'Paid by', value: paidBy),
                      if (paidAt != null)
                        _Fact(label: 'Paid on', value: _when(paidAt)),
                      if (txHash != null && txHash.startsWith('0x'))
                        _Fact(
                          label: 'Reference',
                          value:
                              '${txHash.substring(0, 10)}…${txHash.substring(txHash.length - 6)}',
                        ),
                    ],
                  ),
                ),
              ],

              const SizedBox(height: Space.lg),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: () async {
                        await Clipboard.setData(ClipboardData(text: link));
                        if (!context.mounted) return;
                        Navigator.pop(context);
                      },
                      icon: const Icon(Icons.copy_rounded, size: 16),
                      label: const Text('Copy link'),
                    ),
                  ),
                  const SizedBox(width: Space.sm),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: () => SharePlus.instance.share(
                        ShareParams(text: link, subject: 'Evabob invoice'),
                      ),
                      icon: const Icon(Icons.ios_share_rounded, size: 16),
                      label: const Text('Share'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  static String _when(String iso) {
    final at = DateTime.tryParse(iso);
    if (at == null) return iso;
    final local = at.toLocal();
    return '${local.day}/${local.month}/${local.year} '
        '${local.hour.toString().padLeft(2, '0')}:'
        '${local.minute.toString().padLeft(2, '0')}';
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Space.xs),
      child: Row(
        children: [
          Text(label,
              style: Type.caption.copyWith(color: EvabobColors.navyMuted)),
          const Spacer(),
          Text(
            value,
            style: Type.caption.copyWith(
              color: EvabobColors.nearBlack,
              fontWeight: FontWeight.w400,
            ),
          ),
        ],
      ),
    );
  }
}
