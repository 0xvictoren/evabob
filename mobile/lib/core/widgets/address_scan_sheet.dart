import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../theme/evabob_colors.dart';
import 'glass.dart';

class ScannedPayee {
  const ScannedPayee({
    required this.address,
    required this.kind,
    this.domain,
    this.chainName,
  });

  final String address;

  /// Always `evm` for product networks.
  final String kind;
  final int? domain;
  final String? chainName;
}

/// Scan a QR / URI. EVM addresses can pick Arc / Ethereum Sepolia / Base Sepolia.
class AddressScanSheet extends StatefulWidget {
  const AddressScanSheet({super.key, this.title = 'Scan address'});

  final String title;

  static Future<ScannedPayee?> open(BuildContext context, {String? title}) {
    return showModalBottomSheet<ScannedPayee>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => AddressScanSheet(title: title ?? 'Scan address'),
    );
  }

  @override
  State<AddressScanSheet> createState() => _AddressScanSheetState();
}

class _AddressScanSheetState extends State<AddressScanSheet> {
  final _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
    facing: CameraFacing.back,
  );
  bool _handled = false;
  String? _error;

  static const _evmNets = <({int domain, String name, int chainId})>[
    (domain: 26, name: 'Arc Testnet', chainId: 5042002),
    (domain: 0, name: 'Ethereum Sepolia', chainId: 11155111),
    (domain: 6, name: 'Base Sepolia', chainId: 84532),
  ];

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  ScannedPayee? _parse(String raw) {
    var s = raw.trim();
    if (s.isEmpty) return null;
    int? chainId;
    final eip155 = RegExp(
      r'^eip155:(\d+):(0x[a-fA-F0-9]{40})$',
      caseSensitive: false,
    ).firstMatch(s);
    if (eip155 != null) {
      chainId = int.tryParse(eip155.group(1)!);
      s = eip155.group(2)!;
    }
    final ethUri = RegExp(
      r'^ethereum:(0x[a-fA-F0-9]{40})(?:@(\d+))?',
      caseSensitive: false,
    ).firstMatch(s);
    if (ethUri != null) {
      s = ethUri.group(1)!;
      chainId ??= int.tryParse(ethUri.group(2) ?? '');
    }
    if (RegExp(r'^0x[a-fA-F0-9]{40}$').hasMatch(s)) {
      final net = _evmNets.where((n) => n.chainId == chainId).firstOrNull;
      return ScannedPayee(
        address: s,
        kind: 'evm',
        domain: net?.domain,
        chainName: net?.name,
      );
    }
    return null;
  }

  Future<void> _onDetect(BarcodeCapture cap) async {
    if (_handled) return;
    final raw = cap.barcodes
        .map((b) => b.rawValue)
        .whereType<String>()
        .firstWhere((v) => v.trim().isNotEmpty, orElse: () => '');
    if (raw.isEmpty) return;
    final parsed = _parse(raw);
    if (parsed == null) {
      setState(() => _error = 'No wallet address in that code');
      return;
    }
    _handled = true;
    await _controller.stop();
    if (!mounted) return;
    if (parsed.kind != 'evm') {
      setState(() {
        _handled = false;
        _error = 'That code does not contain an account address';
      });
      return;
    }
    final chosen = await _pickEvmNetwork(parsed);
    if (mounted) Navigator.pop(context, chosen ?? parsed);
  }

  Future<ScannedPayee?> _pickEvmNetwork(ScannedPayee parsed) async {
    return showModalBottomSheet<ScannedPayee>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (ctx) {
        return Padding(
          padding: const EdgeInsets.all(16),
          child: Glass(
            heavy: true,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'Choose network',
                  style: TextStyle(
                    fontWeight: FontWeight.w400,
                    fontSize: 14,
                    color: EvabobColors.navy,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  parsed.address,
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 10,
                    color: EvabobColors.navyMuted,
                  ),
                ),
                const SizedBox(height: 12),
                for (final n in _evmNets)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(n.name),
                    selected: parsed.domain == n.domain,
                    onTap: () => Navigator.pop(
                      ctx,
                      ScannedPayee(
                        address: parsed.address,
                        kind: 'evm',
                        domain: n.domain,
                        chainName: n.name,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final h = MediaQuery.sizeOf(context).height * 0.72;
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Glass(
        heavy: true,
        child: SizedBox(
          height: h,
          child: Column(
            children: [
              Text(
                widget.title,
                style: const TextStyle(
                  fontWeight: FontWeight.w400,
                  fontSize: 14,
                  color: EvabobColors.navy,
                ),
              ),
              const SizedBox(height: 8),
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(16),
                  child: MobileScanner(
                    controller: _controller,
                    onDetect: _onDetect,
                  ),
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 8),
                Text(
                  _error!,
                  style: TextStyle(color: Colors.orange.shade800, fontSize: 10),
                ),
              ],
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('Cancel'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
