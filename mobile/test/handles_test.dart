import 'package:evabob_mobile/core/utils/handles.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a handle is the same with or without @, in any case', () {
    expect(normalizePayee('ekuma'), '@ekuma');
    expect(normalizePayee('@ekuma'), '@ekuma');
    expect(normalizePayee('@EKUMA'), '@ekuma');
    expect(normalizePayee('  Ekuma '), '@ekuma');
  });

  test('addresses, emails and phones are not handles', () {
    const addr = '0x1111111111111111111111111111111111111111';
    expect(normalizePayee(addr), addr);
    expect(normalizePayee('Ada@Example.com'), 'ada@example.com');
    expect(normalizePayee('+234 801 234 5678'), '+234 801 234 5678');
    expect(asHandle('John Doe'), isNull);
  });

  test('bareHandle drops the @ and lowercases', () {
    expect(bareHandle('@Ekuma'), 'ekuma');
    expect(bareHandle('ekuma'), 'ekuma');
  });
}
