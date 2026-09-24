import 'package:flutter/material.dart';

import '../../core/widgets/done_receipt.dart';

/// Figma "Request · Pay" (52:2381): the receipt once a request is paid.
class RequestPaidScreen extends StatelessWidget {
  const RequestPaidScreen({
    super.key,
    required this.payee,
    required this.amount,
    required this.fee,
    this.forWhat,
    DateTime? paidAt,
  }) : _paidAt = paidAt;

  /// Who was paid, as a first name or handle.
  final String payee;

  /// The amount already formatted in the payer's own currency.
  final String amount;

  /// The fee, formatted; empty or zero reads "Free".
  final String? fee;
  final String? forWhat;
  final DateTime? _paidAt;

  static Future<void> open(
    BuildContext context, {
    required String payee,
    required String amount,
    String? fee,
    String? forWhat,
  }) {
    return Navigator.of(context).push(
      MaterialPageRoute<void>(
        fullscreenDialog: true,
        builder: (_) => RequestPaidScreen(
          payee: payee,
          amount: amount,
          fee: fee,
          forWhat: forWhat,
          paidAt: DateTime.now(),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final what = forWhat?.trim() ?? '';
    return DoneReceiptScreen(
      title: 'Paid $payee',
      amount: amount,
      sub: what.isEmpty
          ? null
          : what.toLowerCase().startsWith('for ')
              ? what
              : 'For $what',
      rows: [
        ('Paid from', 'Spendable balance'),
        ('Fee', (fee == null || fee!.isEmpty) ? 'Free' : fee!),
        ('Paid at', DoneReceiptScreen.when(_paidAt ?? DateTime.now())),
      ],
    );
  }
}
