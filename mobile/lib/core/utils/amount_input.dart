import 'package:flutter/services.dart';

/// Only a number goes into an amount: digits and one decimal point.
///
/// Letters, spaces, symbols and a second point are simply not typed, and a
/// comma — the decimal key on many phone keyboards — becomes a point, so
/// "1,50" is 1.50 rather than being silently cut to 150.
class AmountInputFormatter extends TextInputFormatter {
  const AmountInputFormatter({this.decimals = 6});

  /// Digits allowed after the point (USDC and EURC have 6).
  final int decimals;

  String _clean(String text) {
    final out = StringBuffer();
    var seenPoint = false;
    var afterPoint = 0;
    for (final ch in text.replaceAll(',', '.').split('')) {
      if (ch == '.') {
        if (seenPoint) continue;
        seenPoint = true;
        out.write(ch);
        continue;
      }
      final code = ch.codeUnitAt(0);
      if (code < 48 || code > 57) continue;
      if (seenPoint) {
        if (afterPoint >= decimals) continue;
        afterPoint++;
      }
      out.write(ch);
    }
    return out.toString();
  }

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final cleaned = _clean(newValue.text);
    if (cleaned == newValue.text) return newValue;
    // The cleaning reads left to right, so the text before the cursor cleans
    // to the start of the result: the cursor stays where the person put it.
    final at = newValue.selection.baseOffset.clamp(0, newValue.text.length);
    final cursor = _clean(newValue.text.substring(0, at)).length;
    return TextEditingValue(
      text: cleaned,
      selection: TextSelection.collapsed(offset: cursor),
    );
  }
}
