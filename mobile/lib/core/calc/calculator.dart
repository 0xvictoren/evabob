/// Soft arithmetic for amount keypads: "120+35" → 155 when resolved.
class CalcState {
  const CalcState({
    this.expression = '',
    this.display = '0',
    this.value = 0,
  });

  final String expression;
  final String display;
  final double? value;

  static const empty = CalcState();
}

const _ops = {'+', '-', '*', '/', '×', '÷', '−'};

String _norm(String ch) {
  if (ch == '×') return '*';
  if (ch == '÷') return '/';
  if (ch == '−') return '-';
  return ch;
}

List<String> _tokenize(String expr) {
  final tokens = <String>[];
  var num = '';
  for (final raw in expr.split('')) {
    final ch = _norm(raw);
    if (RegExp(r'[0-9.]').hasMatch(ch)) {
      num += ch;
    } else if (_ops.contains(ch) || _ops.contains(raw)) {
      if (num.isNotEmpty) {
        tokens.add(num);
        num = '';
      }
      if ((ch == '-' || ch == '−') &&
          (tokens.isEmpty || _ops.contains(_norm(tokens.last)))) {
        num = '-';
      } else {
        tokens.add(ch == '−' ? '-' : ch);
      }
    }
  }
  if (num.isNotEmpty) tokens.add(num);
  return tokens;
}

double? _eval(List<String> tokens) {
  if (tokens.isEmpty) return null;
  final nums = <double>[];
  final ops = <String>[];
  for (final t in tokens) {
    if (_ops.contains(t) || t == '*' || t == '/') {
      ops.add(t);
    } else {
      final n = double.tryParse(t);
      if (n == null) return null;
      nums.add(n);
    }
  }
  if (ops.length >= nums.length) return null;
  if (nums.isEmpty) return null;
  if (nums.length == 1 && ops.isEmpty) return nums.first;

  final values = List<double>.from(nums);
  final operators = List<String>.from(ops);

  var i = 0;
  while (i < operators.length) {
    if (operators[i] == '*' || operators[i] == '/') {
      final a = values[i];
      final b = values[i + 1];
      if (operators[i] == '/' && b == 0) return null;
      final r = operators[i] == '*' ? a * b : a / b;
      values
        ..removeAt(i)
        ..removeAt(i)
        ..insert(i, r);
      operators.removeAt(i);
    } else {
      i++;
    }
  }

  var result = values[0];
  for (var j = 0; j < operators.length; j++) {
    final op = operators[j];
    final b = values[j + 1];
    if (op == '+') result += b;
    if (op == '-') result -= b;
  }
  return result;
}

String _fmt(double n) {
  if (n == n.roundToDouble()) return n.toStringAsFixed(0);
  return n.toStringAsFixed(2);
}

CalcState applyKey(CalcState state, String key) {
  var expr = state.expression;

  if (key == 'C') return CalcState.empty;

  if (key == '⌫') {
    if (expr.isEmpty) return CalcState.empty;
    expr = expr.substring(0, expr.length - 1);
  } else if (key == '=') {
    final v = _eval(_tokenize(expr));
    if (v == null) return state;
    final r = (v * 100).round() / 100;
    return CalcState(expression: r.toString(), display: _fmt(r), value: r);
  } else if (key == '.') {
    final parts = expr.split(RegExp(r'[+\-*/×÷−]'));
    final last = parts.isEmpty ? '' : parts.last;
    if (last.contains('.')) return state;
    if (expr.isEmpty || _ops.contains(_norm(expr[expr.length - 1]))) {
      expr += '0.';
    } else {
      expr += '.';
    }
  } else {
    final isOp = _ops.contains(key);
    if (isOp) {
      if (expr.isEmpty) return state;
      final last = expr[expr.length - 1];
      if (_ops.contains(_norm(last))) {
        expr = expr.substring(0, expr.length - 1) + key;
      } else {
        expr += key;
      }
    } else {
      if (expr == '0') {
        expr = key;
      } else {
        expr += key;
      }
    }
  }

  final tokens = _tokenize(expr);
  final value = _eval(tokens);
  final lastIsOp =
      expr.isNotEmpty && _ops.contains(_norm(expr[expr.length - 1]));

  String display;
  if (value != null && !lastIsOp) {
    display = _fmt(value);
  } else if (expr.isEmpty) {
    display = '0';
  } else {
    display = expr.replaceAll('*', '×').replaceAll('/', '÷');
  }

  return CalcState(
    expression: expr,
    display: display,
    value: value != null && !lastIsOp ? (value * 100).round() / 100 : null,
  );
}
