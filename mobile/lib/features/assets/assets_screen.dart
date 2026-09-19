import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/wallet/wallet_service.dart';
import '../../core/widgets/asset_thumbnail.dart';
import '../../core/widgets/evabob_ui.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';

/// Figma Wallet · Balances frame (`16:383`).
class AssetsScreen extends StatefulWidget {
  const AssetsScreen({
    super.key,
    this.onBack,
    required this.onSend,
    required this.onReceive,
    required this.onBridge,
  });

  final VoidCallback? onBack;
  final VoidCallback onSend;
  final VoidCallback onReceive;
  final VoidCallback onBridge;

  @override
  State<AssetsScreen> createState() => _AssetsScreenState();
}

class _AssetsScreenState extends State<AssetsScreen> {
  static const _productChains = [
    ('arc', 'Arc', 26, 'ARC-TESTNET'),
    ('ethereum-sepolia', 'Ethereum', 0, 'ETH-SEPOLIA'),
    ('base-sepolia', 'Base', 6, 'BASE-SEPOLIA'),
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  Future<void> _refresh() async {
    final circle = context.read<CircleWalletService>();
    final wallet = context.read<WalletService>();
    await Future.wait([
      wallet.refreshBalances(addressOverride: circle.address),
      wallet.loadDepositAddresses(),
    ]);
  }

  String _addressFor(
    WalletService wallet,
    CircleWalletService circle,
    String circleKey,
  ) {
    final entry = circle.addressesByChain[circleKey];
    if (entry is Map && entry['address'] != null) {
      final value = entry['address'].toString();
      if (value.startsWith('0x') && value.length == 42) return value;
    }
    return wallet.address ?? circle.address ?? '';
  }

  List<Map<String, dynamic>> _networkRows(
    WalletService wallet,
    CircleWalletService circle,
  ) {
    return [
      for (final (id, name, domain, circleKey) in _productChains)
        {
          'id': id,
          'name': name,
          'domain': domain,
          'address': _addressFor(wallet, circle, circleKey),
          'amount': id == 'arc'
              ? wallet.usdcWallet
              : ((wallet.chainRow(id)?['usdc'] as num?)?.toDouble() ?? 0),
          'subtitle': id == 'arc' ? 'Main account' : 'Testnet',
        },
    ];
  }

  Future<void> _copy(String value, String label) async {
    if (value.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: value));
    if (!mounted) return;
    showTopSnack(
      context,
      SnackBar(content: Text('$label copied')),
    );
  }

  Future<void> _networkActions(Map<String, dynamic> network) async {
    final name = network['name']?.toString() ?? 'Network';
    final address = network['address']?.toString() ?? '';
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: EvabobColors.white,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  AssetThumbnail(asset: name, size: 44),
                  const SizedBox(width: 12),
                  Text(name, style: Type.title),
                ],
              ),
              const SizedBox(height: 16),
              _SheetAction(
                icon: Icons.north_east_rounded,
                label: 'Send',
                onTap: () {
                  Navigator.pop(sheetContext);
                  widget.onSend();
                },
              ),
              _SheetAction(
                icon: Icons.qr_code_2_rounded,
                label: 'Get paid',
                onTap: () {
                  Navigator.pop(sheetContext);
                  _copy(address, '$name address');
                  widget.onReceive();
                },
              ),
              _SheetAction(
                icon: Icons.swap_horiz_rounded,
                label: 'Move money',
                onTap: () {
                  Navigator.pop(sheetContext);
                  widget.onBridge();
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final wallet = context.watch<WalletService>();
    final circle = context.watch<CircleWalletService>();
    final networks = _networkRows(wallet, circle);
    // Dollars only. Euros are a different currency and are listed on their
    // own under Currencies; adding them 1:1 overstated the total.
    final total = wallet.totalUsdc;

    return ColoredBox(
      color: EvabobColors.pageBg,
      child: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          color: EvabobColors.blue,
          onRefresh: _refresh,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 124),
            children: [
              EvabobPageHeader(
                title: 'Wallet',
                root: widget.onBack == null,
                onBack: widget.onBack,
              ),
              _TotalCard(total: total),
              const SizedBox(height: 20),
              const EvabobSectionLabel('Networks'),
              const SizedBox(height: 8),
              _RowCard(
                children: [
                  for (var i = 0; i < networks.length; i++) ...[
                    _BalanceRow(
                      thumbnail: networks[i]['name'].toString(),
                      name: networks[i]['name'].toString(),
                      subtitle: networks[i]['subtitle'].toString(),
                      amount: formatMoney(networks[i]['amount'] as double),
                      onTap: () => _networkActions(networks[i]),
                    ),
                    if (i != networks.length - 1) const _InsetDivider(),
                  ],
                ],
              ),
              const SizedBox(height: 20),
              const EvabobSectionLabel('Currencies'),
              const SizedBox(height: 8),
              _RowCard(
                rows: [
                  _CurrencyData('USDC', 'Dollars'),
                  _CurrencyData('EURC', 'Euros'),
                ],
                amounts: [
                  formatMoney(wallet.totalUsdc),
                  formatMoney(wallet.eurcWallet, 'EURC'),
                ],
                children: const [],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TotalCard extends StatelessWidget {
  const _TotalCard({required this.total});

  final double total;

  @override
  Widget build(BuildContext context) {
    final amount = formatMoney(total);
    final dot = amount.lastIndexOf('.');
    return Container(
      height: 140,
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
      decoration: const BoxDecoration(
        color: EvabobColors.blue,
        borderRadius: BorderRadius.all(Radius.circular(12)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Your dollars',
            style: Type.label.copyWith(color: EvabobColors.lightDark),
          ),
          Text.rich(
            TextSpan(
              style: Type.hero.copyWith(color: EvabobColors.white),
              children: [
                TextSpan(text: dot < 0 ? amount : amount.substring(0, dot)),
                if (dot >= 0)
                  TextSpan(
                    text: amount.substring(dot),
                    style: Type.hero.copyWith(color: EvabobColors.lightDark),
                  ),
              ],
            ),
            maxLines: 1,
          ),
          Text(
            'Spendable, Gateway Account and on hold',
            style: Type.label.copyWith(color: EvabobColors.lightDark),
          ),
        ],
      ),
    );
  }
}

class _RowCard extends StatelessWidget {
  const _RowCard({
    required this.children,
    this.rows = const [],
    this.amounts = const [],
  });

  final List<Widget> children;
  final List<_CurrencyData> rows;
  final List<String> amounts;

  @override
  Widget build(BuildContext context) {
    final built = children.isNotEmpty
        ? children
        : <Widget>[
            for (var i = 0; i < rows.length; i++) ...[
              _BalanceRow(
                thumbnail: rows[i].asset,
                name: rows[i].label,
                amount: amounts[i],
              ),
              if (i != rows.length - 1) const _InsetDivider(),
            ],
          ];
    return Container(
      decoration: const BoxDecoration(
        color: EvabobColors.white,
        borderRadius: BorderRadius.all(Radius.circular(12)),
        boxShadow: Shadows.card,
      ),
      child: Column(children: built),
    );
  }
}

class _BalanceRow extends StatelessWidget {
  const _BalanceRow({
    required this.thumbnail,
    required this.name,
    required this.amount,
    this.subtitle,
    this.onTap,
  });

  final String thumbnail;
  final String name;
  final String amount;
  final String? subtitle;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: SizedBox(
        height: 72,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            children: [
              AssetThumbnail(asset: thumbnail, size: 40),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name, style: Type.body),
                    if (subtitle != null)
                      Text(
                        subtitle!,
                        style:
                            Type.label.copyWith(color: EvabobColors.inkMuted),
                      ),
                  ],
                ),
              ),
              Text(amount, style: Type.amount),
            ],
          ),
        ),
      ),
    );
  }
}

class _InsetDivider extends StatelessWidget {
  const _InsetDivider();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.only(left: 68),
      child: Divider(),
    );
  }
}

class _CurrencyData {
  const _CurrencyData(this.asset, this.label);

  final String asset;
  final String label;
}

class _SheetAction extends StatelessWidget {
  const _SheetAction({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      minTileHeight: 56,
      contentPadding: EdgeInsets.zero,
      leading: Icon(icon, color: EvabobColors.blue),
      title: Text(label, style: Type.body),
      trailing: const Icon(Icons.chevron_right_rounded, size: 20),
      onTap: onTap,
    );
  }
}
