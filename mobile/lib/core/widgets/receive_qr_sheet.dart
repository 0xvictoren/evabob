import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../theme/evabob_colors.dart';
import '../theme/evabob_tokens.dart';
import 'top_snack.dart';

/// Get paid by scanning: a QR code of your wallet address on one network,
/// with Copy and Share underneath.
///
/// The code is a standard `ethereum:<address>@<chain>` link, so Evabob's own
/// scanner and ordinary wallets (MetaMask and the like) both land on the
/// right network instead of guessing.
Future<void> showReceiveQr(
  BuildContext context, {
  required String address,
  required String network,
  String? handle,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: EvabobColors.white,
    showDragHandle: true,
    builder: (_) => _ReceiveQrSheet(address: address, network: network, handle: handle),
  );
}

/// Chain ids for the networks Evabob pays on (testnet).
const _chainIds = {
  'arc': 5042002,
  'ethereum': 11155111,
  'base': 84532,
};

int? _chainIdFor(String network) {
  final n = network.toLowerCase();
  for (final e in _chainIds.entries) {
    if (n.contains(e.key)) return e.value;
  }
  return null;
}

class _ReceiveQrSheet extends StatelessWidget {
  const _ReceiveQrSheet({required this.address, required this.network, this.handle});

  final String address;
  final String network;
  final String? handle;

  @override
  Widget build(BuildContext context) {
    final chainId = _chainIdFor(network);
    final data = chainId == null ? address : 'ethereum:$address@$chainId';
    final hasHandle = handle != null && handle!.trim().isNotEmpty;
    return SafeArea(
      top: false,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(Space.page, 0, Space.page, Space.page),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Get paid on $network', style: Type.title, textAlign: TextAlign.center),
            const SizedBox(height: Space.xs),
            Text(
              'Let them scan this to send you USDC on $network.',
              textAlign: TextAlign.center,
              style: Type.body.copyWith(color: EvabobColors.navyMuted),
            ),
            const SizedBox(height: Space.lg),
            Container(
              padding: const EdgeInsets.all(Space.md),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: Radii.all(Radii.md),
                border: Border.all(color: EvabobColors.hairline),
              ),
              child: SizedBox(
                width: 220,
                height: 220,
                child: QrImageView(
                  data: data,
                  backgroundColor: Colors.white,
                  semanticsLabel: 'QR code of your wallet address on $network',
                ),
              ),
            ),
            const SizedBox(height: Space.md),
            SelectableText(
              address,
              textAlign: TextAlign.center,
              style: Type.label.copyWith(color: EvabobColors.nearBlack),
            ),
            if (hasHandle) ...[
              const SizedBox(height: Space.xs),
              Text(
                'On Evabob, they can just send to @${handle!.replaceFirst('@', '')}.',
                textAlign: TextAlign.center,
                style: Type.caption.copyWith(color: EvabobColors.navyMuted),
              ),
            ],
            const SizedBox(height: Space.lg),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () async {
                      await Clipboard.setData(ClipboardData(text: address));
                      if (!context.mounted) return;
                      showTopSnack(context, const SnackBar(content: Text('Address copied')));
                    },
                    icon: const Icon(Icons.copy_rounded, size: 18),
                    label: const Text('Copy'),
                  ),
                ),
                const SizedBox(width: Space.sm),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: () => SharePlus.instance.share(
                      ShareParams(
                        text: 'My $network address for USDC:\n$address',
                        subject: 'My wallet address',
                      ),
                    ),
                    icon: const Icon(Icons.ios_share_rounded, size: 18),
                    label: const Text('Share'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
