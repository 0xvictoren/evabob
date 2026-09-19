import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/activity/activity_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/glass.dart';
import 'payment_proof_card.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';

/// Full-screen receipt for a history item — download + share.
class ReceiptSheet extends StatefulWidget {
  const ReceiptSheet({super.key, required this.entry});

  final ActivityEntry entry;

  static Future<void> open(BuildContext context, ActivityEntry entry) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => ReceiptSheet(entry: entry),
    );
  }

  @override
  State<ReceiptSheet> createState() => _ReceiptSheetState();
}

class _ReceiptSheetState extends State<ReceiptSheet> {
  bool _busy = false;
  String? _savedPath;
  String? _actionHint;

  ActivityEntry get e => widget.entry;

  String get _fileName {
    final safeId = e.id.replaceAll(RegExp(r'[^a-zA-Z0-9_-]'), '_');
    final day = DateFormat('yyyyMMdd').format(e.createdAt.toLocal());
    return 'evabob_receipt_${day}_$safeId.txt';
  }

  Future<File> _writeReceiptFile({Directory? preferred}) async {
    final dir = preferred ?? await getApplicationDocumentsDirectory();
    if (!await dir.exists()) {
      await dir.create(recursive: true);
    }
    final file = File(p.join(dir.path, _fileName));
    await file.writeAsString(e.receiptText(), flush: true);
    return file;
  }

  /// Prefer a user-visible Downloads folder when the platform exposes one.
  Future<Directory?> _downloadsDir() async {
    try {
      final d = await getDownloadsDirectory();
      if (d != null) return d;
    } catch (_) {}
    try {
      final ext = await getExternalStorageDirectory();
      if (ext == null) return null;
      // app-specific external: .../Android/data/<pkg>/files
      // Walk up to public Download when possible is not reliable without SAF.
      // Fall back to app files/Download for a stable local copy.
      final local = Directory(p.join(ext.path, 'Download'));
      if (!await local.exists()) {
        await local.create(recursive: true);
      }
      return local;
    } catch (_) {
      return null;
    }
  }

  Future<void> _share() async {
    setState(() {
      _busy = true;
      _actionHint = null;
    });
    try {
      final tmp = await getTemporaryDirectory();
      final file = await _writeReceiptFile(preferred: tmp);
      _savedPath = file.path;

      if (!mounted) return;
      final box = context.findRenderObject() as RenderBox?;
      final origin =
          box != null ? box.localToGlobal(Offset.zero) & box.size : null;

      await SharePlus.instance.share(
        ShareParams(
          files: [
            XFile(
              file.path,
              mimeType: 'text/plain',
              name: _fileName,
            ),
          ],
          subject: 'Evabob receipt · ${e.title}',
          text: e.receiptText(),
          sharePositionOrigin: origin,
        ),
      );
      if (mounted) {
        setState(() => _actionHint = 'Share sheet opened');
      }
    } catch (err) {
      if (mounted) {
        showTopSnack(
          context,
          SnackBar(
              content: Text(friendlyError(err)),
              behavior: SnackBarBehavior.floating),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _download() async {
    setState(() {
      _busy = true;
      _actionHint = null;
    });
    try {
      final downloads = await _downloadsDir();
      final file = await _writeReceiptFile(
        preferred: downloads ?? await getApplicationDocumentsDirectory(),
      );
      // Always keep a docs copy for reliability.
      if (downloads != null) {
        await _writeReceiptFile(
          preferred: await getApplicationDocumentsDirectory(),
        );
      }
      _savedPath = file.path;

      if (!mounted) return;
      setState(() {
        _actionHint = 'Saved to device';
      });
      showTopSnack(
        context,
        SnackBar(
          content: Text('Receipt saved · $_fileName'),
          behavior: SnackBarBehavior.floating,
          duration: const Duration(seconds: 4),
          action: SnackBarAction(
            label: 'Share',
            onPressed: _share,
          ),
        ),
      );
    } catch (err) {
      if (mounted) {
        showTopSnack(
          context,
          SnackBar(
              content: Text(friendlyError(err)),
              behavior: SnackBarBehavior.floating),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: e.receiptText()));
    if (!mounted) return;
    setState(() => _actionHint = 'Receipt text copied');
    showTopSnack(
      context,
      const SnackBar(
        content: Text('Receipt copied to clipboard'),
        behavior: SnackBarBehavior.floating,
        duration: Duration(seconds: 2),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final df = DateFormat('EEE, MMM d, yyyy · HH:mm');
    final positive = e.amountUsdc > 0;
    final zero = e.amountUsdc == 0;
    final failed = e.didNotLand;
    final h = MediaQuery.sizeOf(context).height * 0.88;

    return Container(
      height: h,
      decoration: const BoxDecoration(
        color: EvabobColors.cream,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          children: [
            const SizedBox(height: 10),
            Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: EvabobColors.sand,
                borderRadius: BorderRadius.circular(99),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 8, 0),
              child: Row(
                children: [
                  const Expanded(
                    child: Text(
                      'Receipt',
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w400,
                        color: EvabobColors.navy,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Copy',
                    onPressed: _copy,
                    icon: const Icon(Icons.copy_rounded),
                  ),
                  IconButton(
                    tooltip: 'Close',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                children: [
                  Glass(
                    heavy: true,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 10,
                                vertical: 4,
                              ),
                              decoration: BoxDecoration(
                                color: (failed
                                        ? EvabobColors.alert
                                        : EvabobColors.emerald)
                                    .withValues(alpha: 0.14),
                                borderRadius: BorderRadius.circular(99),
                              ),
                              child: Text(
                                failed ? "Didn't land" : kindLabel(e.kind),
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w400,
                                  color: failed
                                      ? EvabobColors.alert
                                      : EvabobColors.emeraldDeep,
                                  letterSpacing: 0.6,
                                ),
                              ),
                            ),
                            const Spacer(),
                            const Text(
                              'Evabob',
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.w400,
                                color: EvabobColors.navyMuted,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        Text(
                          failed ? "Didn't land" : e.title,
                          style: const TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.w400,
                            color: EvabobColors.navy,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          df.format(e.createdAt.toLocal()),
                          style: const TextStyle(
                            color: EvabobColors.navyMuted,
                            fontSize: 10,
                          ),
                        ),
                        if (!zero || (e.amountToken ?? 0) > 0) ...[
                          const SizedBox(height: 18),
                          Text(
                            e.amountLine,
                            style: TextStyle(
                              fontSize: 48,
                              fontWeight: FontWeight.w400,
                              color: failed
                                  ? EvabobColors.alert
                                  : positive
                                      ? EvabobColors.emeraldDeep
                                      : EvabobColors.navy,
                            ),
                          ),
                        ],
                        const SizedBox(height: 14),
                        const Divider(),
                        const SizedBox(height: 8),
                        _row('Date', df.format(e.createdAt.toLocal())),
                        _row('Amount', e.amountLine),
                        if (failed) _row('Status', "Didn't land"),
                        if ((e.platformFee ?? 0) > 0)
                          _row(
                            'Evabob fee',
                            formatMoney(
                              e.platformFee!,
                              e.platformFeeToken ?? e.displayToken,
                            ),
                          ),
                        if (e.sender != null && e.sender!.isNotEmpty)
                          _row('Sender', e.sender!),
                        if (e.receiver != null && e.receiver!.isNotEmpty)
                          _row('Receiver', e.receiver!),
                        if ((e.sender == null || e.sender!.isEmpty) &&
                            (e.receiver == null || e.receiver!.isEmpty) &&
                            e.counterparty != null &&
                            e.counterparty!.isNotEmpty)
                          _row('Party', e.counterparty!),
                        _row('Details', e.description),
                        _row('Receipt ID', e.id),
                        if (e.mode != null && e.mode!.isNotEmpty)
                          _row('How', modeLabel(e.mode!)),
                        _row(
                          'Reference',
                          (e.txHash != null && e.txHash!.isNotEmpty)
                              ? displayData(e.txHash)
                              : failed
                                  ? 'No transaction'
                                  : 'Confirmed',
                          fullValue: e.txHash,
                        ),
                        const SizedBox(height: 12),
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            color: EvabobColors.sand.withValues(alpha: 0.5),
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Text(
                            failed
                                ? 'This payment did not land. Nothing was recorded as delivered; check Activity before trying again.'
                                : 'This is your official Evabob payment receipt. Download or share it anytime from history.',
                            style: const TextStyle(
                              fontSize: 10,
                              color: EvabobColors.navyMuted,
                              height: 1.35,
                            ),
                          ),
                        ),
                        const SizedBox(height: 10),
                        const Text(
                          'Built on Arc',
                          style: TextStyle(
                            fontSize: 10,
                            color: EvabobColors.chalk,
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (e.shareable) ...[
                    const SizedBox(height: 12),
                    PaymentProofCard(entry: e),
                  ],
                  if (_savedPath != null) ...[
                    const SizedBox(height: 12),
                    Text(
                      'File: $_savedPath',
                      style: const TextStyle(
                        fontSize: 10,
                        color: EvabobColors.navyMuted,
                      ),
                    ),
                  ],
                  if (_actionHint != null) ...[
                    const SizedBox(height: 6),
                    Text(
                      _actionHint!,
                      style: const TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w400,
                        color: EvabobColors.emeraldDeep,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _busy ? null : _download,
                      icon: const Icon(Icons.download_rounded),
                      label: const Text('Download'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: _busy ? null : _share,
                      icon: _busy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.ios_share_rounded),
                      label: const Text('Share'),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _row(String k, String v, {String? fullValue}) {
    final display = shortUiText(v, max: 140);
    final copy = (fullValue != null && fullValue.isNotEmpty) ? fullValue : v;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            k,
            style: const TextStyle(
              fontSize: 10,
              color: EvabobColors.chalk,
              fontWeight: FontWeight.w400,
            ),
          ),
          SelectableText(
            display,
            maxLines: 3,
            style: const TextStyle(
              fontSize: 10,
              color: EvabobColors.navy,
              fontWeight: FontWeight.w400,
              fontFamily: 'monospace',
            ),
            onTap: () {
              if (copy.isEmpty) return;
              Clipboard.setData(ClipboardData(text: copy));
              setState(() => _actionHint = 'Copied $k');
            },
          ),
        ],
      ),
    );
  }
}
