import 'dart:typed_data';

import 'package:intl/intl.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

import '../../core/theme/evabob_colors.dart';

/// The account export as a PDF someone can read: who the account is, every
/// payment, and saved contacts. Built from the same export the JSON file is,
/// so the two never disagree; the JSON stays the complete copy.
Future<Uint8List> buildAccountStatementPdf(Map<String, dynamic> export) async {
  final profile = _map(export['profile']);
  final activity = _list(export['activity'])
    ..sort((a, b) => _date(b['createdAt']).compareTo(_date(a['createdAt'])));
  final contacts = _list(export['contacts']);
  final chats = _map(export['chats']);
  final exportedAt = _date(export['exportedAt']);
  final limitations = _strings(export['limitations']);

  final blue = PdfColor.fromInt(EvabobColors.blue.toARGB32());
  final ink = PdfColor.fromInt(EvabobColors.black.toARGB32());
  const muted = PdfColor.fromInt(0xFF6B7785);
  final day = DateFormat('d MMM yyyy, HH:mm');

  final doc = pw.Document(
    title: 'Evabob account statement',
    author: 'Evabob',
  );

  pw.Widget heading(String text) => pw.Padding(
        padding: const pw.EdgeInsets.only(top: 18, bottom: 8),
        child: pw.Text(
          text,
          style: pw.TextStyle(
            fontSize: 13,
            fontWeight: pw.FontWeight.bold,
            color: ink,
          ),
        ),
      );

  pw.Widget line(String label, String? value) => (value ?? '').isEmpty
      ? pw.SizedBox()
      : pw.Padding(
          padding: const pw.EdgeInsets.only(bottom: 3),
          child: pw.Row(
            crossAxisAlignment: pw.CrossAxisAlignment.start,
            children: [
              pw.SizedBox(
                width: 110,
                child: pw.Text(_safe(label),
                    style: const pw.TextStyle(fontSize: 9, color: muted)),
              ),
              pw.Expanded(
                child: pw.Text(_safe(value),
                    style: pw.TextStyle(fontSize: 9, color: ink)),
              ),
            ],
          ),
        );

  final handle = _str(profile['handle']);
  final threads = _list(chats['threads']).length;
  final messages = _list(chats['messages']).length;

  doc.addPage(
    pw.MultiPage(
      pageFormat: PdfPageFormat.a4,
      margin: const pw.EdgeInsets.fromLTRB(36, 36, 36, 40),
      header: (context) => context.pageNumber == 1
          ? pw.SizedBox()
          : pw.Padding(
              padding: const pw.EdgeInsets.only(bottom: 10),
              child: pw.Text('Evabob account statement',
                  style: const pw.TextStyle(fontSize: 8, color: muted)),
            ),
      footer: (context) => pw.Align(
        alignment: pw.Alignment.centerRight,
        child: pw.Text(
          'Page ${context.pageNumber} of ${context.pagesCount}',
          style: const pw.TextStyle(fontSize: 8, color: muted),
        ),
      ),
      build: (context) => [
        pw.Text(
          'Evabob',
          style: pw.TextStyle(
            fontSize: 22,
            fontWeight: pw.FontWeight.bold,
            color: blue,
          ),
        ),
        pw.SizedBox(height: 2),
        pw.Text(
          'Account statement - exported ${day.format(exportedAt.toLocal())}',
          style: const pw.TextStyle(fontSize: 9, color: muted),
        ),
        heading('Account'),
        line('Name', _str(profile['displayName'])),
        line('Handle', handle.isEmpty ? null : '@$handle'),
        line('Email', _str(profile['email'])),
        line('Phone', _str(profile['phone'])),
        line('Wallet address', _str(profile['evmAddress'])),
        line('Joined', _dayOrNull(profile['createdAt'], day)),
        heading('Activity (${activity.length})'),
        if (activity.isEmpty)
          pw.Text('No payments yet.',
              style: const pw.TextStyle(fontSize: 9, color: muted))
        else
          pw.TableHelper.fromTextArray(
            headers: const ['Date', 'What', 'With', 'Amount', 'Status'],
            data: [
              for (final a in activity)
                [
                  day.format(_date(a['createdAt']).toLocal()),
                  _safe(_what(a)),
                  _safe(_str(a['counterparty']).isNotEmpty
                      ? _str(a['counterparty'])
                      : (_str(a['receiver']).isNotEmpty
                          ? _str(a['receiver'])
                          : _str(a['sender']))),
                  _amount(a),
                  _safe(_str(a['status']).isEmpty ? 'completed' : _str(a['status'])),
                ],
            ],
            headerStyle: pw.TextStyle(
              fontSize: 8,
              fontWeight: pw.FontWeight.bold,
              color: PdfColors.white,
            ),
            headerDecoration: pw.BoxDecoration(color: ink),
            cellStyle: pw.TextStyle(fontSize: 8, color: ink),
            cellAlignments: const {3: pw.Alignment.centerRight},
            columnWidths: const {
              0: pw.FixedColumnWidth(78),
              1: pw.FlexColumnWidth(3),
              2: pw.FlexColumnWidth(2),
              3: pw.FixedColumnWidth(72),
              4: pw.FixedColumnWidth(56),
            },
            oddRowDecoration: const pw.BoxDecoration(color: PdfColor.fromInt(0xFFF3F5F8)),
            border: null,
            cellPadding: const pw.EdgeInsets.symmetric(horizontal: 4, vertical: 4),
          ),
        heading('Contacts (${contacts.length})'),
        if (contacts.isEmpty)
          pw.Text('No saved contacts.',
              style: const pw.TextStyle(fontSize: 9, color: muted))
        else
          for (final c in contacts)
            line(
              _str(c['name']).isNotEmpty ? _str(c['name']) : 'Contact',
              [
                if (_str(c['handle']).isNotEmpty)
                  '@${_str(c['handle']).replaceFirst('@', '')}',
                _str(c['email']),
                _str(c['address']),
              ].where((s) => s.isNotEmpty).join('  '),
            ),
        heading('Chats'),
        line('Conversations', '$threads'),
        line('Messages', '$messages'),
        pw.Text(
          'Message text is in the JSON export.',
          style: const pw.TextStyle(fontSize: 8, color: muted),
        ),
        if (limitations.isNotEmpty) ...[
          heading('Good to know'),
          for (final l in limitations)
            pw.Padding(
              padding: const pw.EdgeInsets.only(bottom: 3),
              child: pw.Text('- ${_safe(l)}',
                  style: const pw.TextStyle(fontSize: 8, color: muted)),
            ),
        ],
      ],
    ),
  );
  return doc.save();
}

/// A person's words for a row, not the ledger's.
String _what(Map<String, dynamic> a) {
  final title = _str(a['title']);
  final memo = _str(a['memo']);
  final description = _str(a['description']);
  final extra = memo.isNotEmpty ? memo : description;
  if (title.isEmpty) return extra;
  return extra.isEmpty || extra == title ? title : '$title - $extra';
}

/// Signed and in its own token: "-12.50 USDC", "+3.00 EURC".
String _amount(Map<String, dynamic> a) {
  final token = _str(a['token']).isEmpty ? 'USDC' : _str(a['token']).toUpperCase();
  final signed = (a['amountUsdc'] as num?)?.toDouble() ?? 0;
  final value =
      (a['amountToken'] as num?)?.toDouble().abs() ?? signed.abs();
  final kind = _str(a['kind']);
  final out = kind == 'send' || kind == 'withdraw' || signed < 0;
  final places = token == 'CIRBTC' ? 8 : 2;
  return '${out ? '-' : '+'}${value.toStringAsFixed(places)} $token';
}

String? _dayOrNull(Object? v, DateFormat f) {
  final d = DateTime.tryParse(v?.toString() ?? '');
  return d == null ? null : f.format(d.toLocal());
}

DateTime _date(Object? v) =>
    DateTime.tryParse(v?.toString() ?? '') ??
    DateTime.fromMillisecondsSinceEpoch(0);

String _str(Object? v) => v == null ? '' : v.toString().trim();

Map<String, dynamic> _map(Object? v) =>
    v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};

List<Map<String, dynamic>> _list(Object? v) => v is List
    ? v.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
    : <Map<String, dynamic>>[];

List<String> _strings(Object? v) =>
    v is List ? v.map((e) => e.toString()).toList() : const <String>[];

/// The PDF's built-in font only has Latin characters. Naira and other signs
/// are spelled out, and anything else it cannot draw (emoji) is dropped.
String _safe(String? s) {
  final text = (s ?? '')
      .replaceAll('₦', 'NGN ')
      .replaceAll('€', 'EUR ')
      .replaceAll(RegExp('[‘’]'), "'")
      .replaceAll(RegExp('[“”]'), '"')
      .replaceAll(RegExp('[–—·•]'), '-');
  return String.fromCharCodes(
    text.runes.where((r) => r == 0x0A || (r >= 0x20 && r <= 0x7E) || (r >= 0xA0 && r <= 0xFF)),
  ).replaceAll(RegExp(r' {2,}'), ' ').trim();
}
