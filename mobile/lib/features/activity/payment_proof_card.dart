import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/activity/activity_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/utils/text_safe.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';

/// Proof a seller can check without trusting a screenshot.
///
/// Fake "I've sent it" screenshots are the commonest small-seller scam, and
/// the seller's only defence has been opening their own bank app. This makes
/// a link (and a QR code for someone standing at the counter) that opens a
/// page re-checking the payment on the Arc network each time, so the seller
/// can see it themselves. While the money is still moving the same link shows
/// where it is.
class PaymentProofCard extends StatefulWidget {
  const PaymentProofCard({super.key, required this.entry});

  final ActivityEntry entry;

  @override
  State<PaymentProofCard> createState() => _PaymentProofCardState();
}

class _PaymentProofCardState extends State<PaymentProofCard> {
  SharedPaymentLink? _link;
  bool _busy = false;
  String? _error;

  Future<void> _make() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final link =
          await context.read<ActivityService>().shareLink(widget.entry.id);
      if (!mounted) return;
      setState(() => _link = link);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _share() async {
    final link = _link;
    if (link == null) return;
    final box = context.findRenderObject() as RenderBox?;
    await SharePlus.instance.share(
      ShareParams(
        text: widget.entry.isPending
            ? 'Follow my payment here: ${link.url}'
            : 'Here is my payment. You can check it yourself: ${link.url}',
        sharePositionOrigin:
            box != null ? box.localToGlobal(Offset.zero) & box.size : null,
      ),
    );
  }

  Future<void> _copy() async {
    final link = _link;
    if (link == null) return;
    await Clipboard.setData(ClipboardData(text: link.url));
    if (!mounted) return;
    showTopSnack(
      context,
      const SnackBar(
        content: Text('Link copied'),
        behavior: SnackBarBehavior.floating,
        duration: Duration(seconds: 2),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final pending = widget.entry.isPending;
    final link = _link;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: EvabobColors.sheet,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: EvabobColors.hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            pending ? 'Where is it?' : 'Paid ✓',
            style: const TextStyle(fontSize: 16, color: EvabobColors.navy),
          ),
          const SizedBox(height: 4),
          Text(
            pending
                ? 'Share a link that shows Sending → On the way → Done, '
                    'so they can follow it without asking.'
                : 'Show this to the seller — they can check it themselves.',
            style: const TextStyle(
              fontSize: 12,
              height: 1.35,
              color: EvabobColors.navyMuted,
            ),
          ),
          const SizedBox(height: 12),
          if (link == null)
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: _busy ? null : _make,
                icon: _busy
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.qr_code_2_rounded),
                label: Text(pending ? 'Get a tracking link' : 'Get proof link'),
              ),
            )
          else ...[
            Center(
              child: Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: EvabobColors.hairline),
                ),
                child: QrImageView(
                  data: link.url,
                  size: 180,
                  backgroundColor: Colors.white,
                  semanticsLabel: 'QR code for the payment link',
                ),
              ),
            ),
            const SizedBox(height: 10),
            SelectableText(
              link.url,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 11,
                color: EvabobColors.emeraldDeep,
              ),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _copy,
                    icon: const Icon(Icons.link_rounded),
                    label: const Text('Copy link'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: _share,
                    icon: const Icon(Icons.ios_share_rounded),
                    label: const Text('Send link'),
                  ),
                ),
              ],
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(
              _error!,
              style: const TextStyle(fontSize: 11, color: EvabobColors.alert),
            ),
          ],
        ],
      ),
    );
  }
}
