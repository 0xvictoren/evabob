import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/api/api_client.dart';
import '../../core/paywalls/paywalls_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';
import 'package:evabob_mobile/core/utils/amount_input.dart';

/// Get paid by agents: charge software for something you made.
///
/// A dataset, a photo set, a small API, an hour of your time. Evabob hosts
/// the paywall, takes the payment and pays it out to you. Software is only
/// charged if what it gets back is usable, and a booking of your time is only
/// charged once you accept it.
class PaywallsScreen extends StatefulWidget {
  const PaywallsScreen({super.key});

  @override
  State<PaywallsScreen> createState() => _PaywallsScreenState();
}

class _PaywallsScreenState extends State<PaywallsScreen> {
  late final PaywallsApi _api = PaywallsApi(context.read<ApiClient>());
  List<Paywall>? _items;
  PaywallRecord _record = const PaywallRecord();
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final (items, record) = await _api.mine();
      if (!mounted) return;
      setState(() {
        _items = items;
        _record = record;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    }
  }

  void _toast(String text) {
    showTopSnack(
      context,
      SnackBar(content: Text(text), behavior: SnackBarBehavior.floating),
    );
  }

  Future<void> _create() async {
    final made = await showModalBottomSheet<Paywall>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _NewPaywallSheet(api: _api),
    );
    if (made == null || !mounted) return;
    await _load();
    if (mounted) _share(made);
  }

  Future<void> _share(Paywall p) async {
    final box = context.findRenderObject() as RenderBox?;
    await SharePlus.instance.share(ShareParams(
      text: '${p.title} — ${formatMoney(p.priceUsdc)} for software and AI '
          'agents. Pay with x402: ${p.url}',
      sharePositionOrigin:
          box != null ? box.localToGlobal(Offset.zero) & box.size : null,
    ));
  }

  Future<void> _answer(PaywallBooking b, bool accept) async {
    String? details;
    if (accept) {
      final ctrl = TextEditingController();
      details = await showDialog<String>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Accept the booking'),
          content: TextField(
            controller: ctrl,
            autofocus: true,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'When and where',
              hintText: 'Tuesday 10:00 WAT, meet.example/ada',
            ),
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(ctx),
                child: const Text('Cancel')),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
              child: const Text('Accept and get paid'),
            ),
          ],
        ),
      );
      if (details == null || details.isEmpty) return;
    }
    try {
      await _api.answerBooking(b.id, accept: accept, details: details);
      await _load();
      if (mounted) {
        _toast(accept
            ? 'Accepted. The payment is taken now and reaches you with your next payout.'
            : 'Declined. Nothing was charged.');
      }
    } catch (e) {
      if (mounted) _toast(friendlyError(e));
    }
  }

  Future<void> _setOpen(Paywall p, bool open) async {
    try {
      await _api.setOpen(p.id, open);
      await _load();
    } catch (e) {
      if (mounted) _toast(friendlyError(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _create,
        icon: const Icon(Icons.add_rounded),
        label: const Text('New paywall'),
      ),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: EvabobPageHeader(
                title: 'Get paid by agents',
                onBack: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: ListView(
                  padding:
                      const EdgeInsets.fromLTRB(Space.page, 0, Space.page, 96),
                  children: [
                    Text(
                      'Charge software for something you made: a dataset, a '
                      'photo set, a small API, an hour of your time. Evabob '
                      'hosts the paywall, takes the payment and pays it to '
                      'you. Software is only charged when what it gets back '
                      'is usable.',
                      style:
                          Type.caption.copyWith(color: EvabobColors.navyMuted),
                    ),
                    const SizedBox(height: Space.md),
                    Glass(
                      child: Row(
                        children: [
                          const Icon(Icons.verified_outlined,
                              color: EvabobColors.emeraldDeep),
                          const SizedBox(width: Space.md),
                          Expanded(
                            child: Text(
                              _record.delivered +
                                          _record.notCharged +
                                          _record.declined ==
                                      0
                                  ? 'No sales yet'
                                  : '${_record.delivered} delivered · '
                                      '${_record.notCharged} not charged · '
                                      '${_record.declined} bookings declined',
                              style: Type.caption
                                  .copyWith(color: EvabobColors.navyMuted),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: Space.md),
                    if (items == null && _error == null)
                      const Padding(
                        padding: EdgeInsets.only(top: 60),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 40),
                        child: Text(_error!, textAlign: TextAlign.center),
                      ),
                    if (items != null && items.isEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 40),
                        child: Text(
                          'Nothing for sale yet.',
                          textAlign: TextAlign.center,
                          style:
                              Type.body.copyWith(color: EvabobColors.navyMuted),
                        ),
                      ),
                    for (final p in items ?? const <Paywall>[]) ...[
                      Glass(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(p.title,
                                      style: Type.body.copyWith(
                                          color: p.active
                                              ? EvabobColors.nearBlack
                                              : EvabobColors.navyMuted)),
                                ),
                                Text(formatMoney(p.priceUsdc),
                                    style: Type.body.copyWith(
                                        color: EvabobColors.nearBlack)),
                              ],
                            ),
                            Text(
                              [
                                p.kindWord,
                                p.sales == 0
                                    ? 'no sales yet'
                                    : '${p.sales} sold · ${formatMoney(p.earnedUsdc)} earned',
                                if (p.paidOutUsdc > 0)
                                  '${formatMoney(p.paidOutUsdc)} paid out',
                                if (!p.active) 'closed',
                              ].join(' · '),
                              style: Type.caption
                                  .copyWith(color: EvabobColors.navyMuted),
                            ),
                            for (final b in p.bookings) ...[
                              const SizedBox(height: Space.sm),
                              Container(
                                padding: const EdgeInsets.all(Space.sm),
                                decoration: BoxDecoration(
                                  color:
                                      EvabobColors.blue.withValues(alpha: 0.06),
                                  borderRadius: Radii.all(Radii.md),
                                ),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                        '${b.buyer} wants to book you · ${formatMoney(b.amountUsdc)}',
                                        style: Type.caption.copyWith(
                                            color: EvabobColors.nearBlack)),
                                    if (b.message.isNotEmpty)
                                      Text('“${b.message}”',
                                          style: Type.caption.copyWith(
                                              color: EvabobColors.navyMuted)),
                                    Text('Nothing is charged until you accept.',
                                        style: Type.caption.copyWith(
                                            color: EvabobColors.navyMuted)),
                                    Row(
                                      children: [
                                        TextButton(
                                            onPressed: () => _answer(b, true),
                                            child: const Text('Accept')),
                                        TextButton(
                                            onPressed: () => _answer(b, false),
                                            child: const Text('Decline')),
                                      ],
                                    ),
                                  ],
                                ),
                              ),
                            ],
                            Row(
                              children: [
                                if (p.active) ...[
                                  IconButton(
                                    tooltip: 'Copy link',
                                    onPressed: () async {
                                      await Clipboard.setData(
                                          ClipboardData(text: p.url));
                                      if (mounted) {
                                        _toast(
                                            'Link copied. Give it to any software that pays with x402.');
                                      }
                                    },
                                    icon: const Icon(Icons.link_rounded),
                                  ),
                                  IconButton(
                                    tooltip: 'Share',
                                    onPressed: () => _share(p),
                                    icon: const Icon(Icons.ios_share_rounded),
                                  ),
                                ],
                                const Spacer(),
                                TextButton(
                                  onPressed: () => _setOpen(p, !p.active),
                                  child: Text(p.active ? 'Close' : 'Reopen'),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: Space.sm),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _NewPaywallSheet extends StatefulWidget {
  const _NewPaywallSheet({required this.api});

  final PaywallsApi api;

  @override
  State<_NewPaywallSheet> createState() => _NewPaywallSheetState();
}

class _NewPaywallSheetState extends State<_NewPaywallSheet> {
  String _kind = 'file';
  final _title = TextEditingController();
  final _price = TextEditingController();
  final _details = TextEditingController();
  final _text = TextEditingController();
  final _apiUrl = TextEditingController();
  final _headerName = TextEditingController();
  final _headerValue = TextEditingController();
  final _note = TextEditingController();
  int _minutes = 60;
  final List<NewPaywallFile> _files = [];
  int _fileBytes = 0;
  bool _busy = false;
  String? _error;

  static const _maxBytes = 10 * 1024 * 1024;

  @override
  void dispose() {
    for (final c in [
      _title,
      _price,
      _details,
      _text,
      _apiUrl,
      _headerName,
      _headerValue,
      _note
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _pickFiles() async {
    final picked = await FilePicker.platform
        .pickFiles(allowMultiple: true, withData: true);
    if (picked == null) return;
    _addFiles([
      for (final f in picked.files)
        if (f.bytes != null) (f.name, f.bytes!, null),
    ]);
  }

  Future<void> _pickPhotos() async {
    final photos = await ImagePicker().pickMultiImage();
    final list = <(String, List<int>, String?)>[];
    for (final x in photos) {
      list.add((x.name, await x.readAsBytes(), x.mimeType ?? 'image/jpeg'));
    }
    _addFiles(list);
  }

  void _addFiles(List<(String, List<int>, String?)> picked) {
    setState(() {
      for (final (name, bytes, mime) in picked) {
        if (_files.length >= 5) {
          _error = 'Up to 5 files per paywall.';
          break;
        }
        if (_fileBytes + bytes.length > _maxBytes) {
          _error = 'Up to 10 MB of files per paywall.';
          break;
        }
        _fileBytes += bytes.length;
        _files.add(NewPaywallFile(
            name: name, base64: base64Encode(bytes), mime: mime));
      }
    });
  }

  Future<void> _save() async {
    final price = double.tryParse(_price.text.trim());
    if (_title.text.trim().isEmpty) {
      return setState(() => _error = 'Say what you are selling.');
    }
    if (price == null || price <= 0) {
      return setState(() => _error = 'Enter a price.');
    }
    if (_kind == 'file' && _files.isEmpty) {
      return setState(() => _error = 'Add at least one file.');
    }
    if (_kind == 'text' && _text.text.trim().isEmpty) {
      return setState(() => _error = 'Write what the buyer gets.');
    }
    if (_kind == 'api' && !_apiUrl.text.trim().startsWith('https://')) {
      return setState(
          () => _error = 'Your API address must start with https://');
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final made = await widget.api.create(
        kind: _kind,
        title: _title.text.trim(),
        priceUsdc: price,
        description: _details.text.trim(),
        files: _files,
        text: _text.text.trim(),
        apiUrl: _apiUrl.text.trim(),
        headerName: _headerName.text.trim(),
        headerValue: _headerValue.text.trim(),
        minutes: _minutes,
        note: _note.text.trim(),
      );
      if (mounted) Navigator.pop(context, made);
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _kindChip(String kind, String label, IconData icon) => ChoiceChip(
        avatar: Icon(icon, size: 16),
        label: Text(label),
        selected: _kind == kind,
        onSelected: (_) => setState(() {
          _kind = kind;
          _error = null;
        }),
      );

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        top: false,
        child: Container(
          margin: const EdgeInsets.all(Space.md),
          padding: const EdgeInsets.all(Space.lg),
          decoration: BoxDecoration(
            color: EvabobColors.sheet,
            borderRadius: Radii.all(Radii.lg),
            boxShadow: Shadows.raised,
          ),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('New paywall',
                    style: Type.title.copyWith(color: EvabobColors.nearBlack)),
                const SizedBox(height: Space.md),
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    _kindChip('file', 'Files', Icons.dataset_outlined),
                    _kindChip('text', 'Text', Icons.notes_rounded),
                    _kindChip('api', 'Your API', Icons.api_rounded),
                    _kindChip('time', 'Your time', Icons.schedule_rounded),
                  ],
                ),
                const SizedBox(height: Space.sm),
                TextField(
                  controller: _title,
                  maxLength: 80,
                  textCapitalization: TextCapitalization.sentences,
                  decoration: InputDecoration(
                    labelText: 'What is it?',
                    hintText: switch (_kind) {
                      'file' => 'Lagos rainfall, 2015–2025',
                      'api' => 'Nigerian fuel prices, live',
                      'time' => 'An hour of logistics advice',
                      _ => 'My notes on Yaba rent prices',
                    },
                    counterText: '',
                  ),
                ),
                TextField(
                  controller: _price,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  inputFormatters: [const AmountInputFormatter()],
                  decoration: InputDecoration(
                    labelText: _kind == 'api' ? 'Price per call' : 'Price',
                    prefixText: r'$ ',
                    helperText: _kind == 'api'
                        ? 'Small amounts are fine, e.g. 0.01'
                        : null,
                  ),
                ),
                TextField(
                  controller: _details,
                  maxLength: 500,
                  maxLines: 2,
                  minLines: 1,
                  decoration: const InputDecoration(
                    labelText: 'Description (optional)',
                    counterText: '',
                  ),
                ),
                const SizedBox(height: Space.sm),
                if (_kind == 'file') ...[
                  Row(
                    children: [
                      OutlinedButton.icon(
                        onPressed: _pickFiles,
                        icon: const Icon(Icons.attach_file_rounded, size: 18),
                        label: const Text('Files'),
                      ),
                      const SizedBox(width: Space.sm),
                      OutlinedButton.icon(
                        onPressed: _pickPhotos,
                        icon:
                            const Icon(Icons.photo_library_outlined, size: 18),
                        label: const Text('Photos'),
                      ),
                    ],
                  ),
                  for (final f in _files)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text('• ${f.name}',
                          style: Type.caption
                              .copyWith(color: EvabobColors.navyMuted)),
                    ),
                ],
                if (_kind == 'text')
                  TextField(
                    controller: _text,
                    maxLines: 6,
                    minLines: 3,
                    decoration:
                        const InputDecoration(labelText: 'What the buyer gets'),
                  ),
                if (_kind == 'api') ...[
                  TextField(
                    controller: _apiUrl,
                    keyboardType: TextInputType.url,
                    decoration: const InputDecoration(
                      labelText: 'Your API address',
                      hintText: 'https://api.example.com/prices',
                    ),
                  ),
                  TextField(
                    controller: _headerName,
                    decoration: const InputDecoration(
                        labelText: 'Secret header name (optional)'),
                  ),
                  TextField(
                    controller: _headerValue,
                    obscureText: true,
                    decoration: const InputDecoration(
                      labelText: 'Secret header value (optional)',
                      helperText: 'Kept on Evabob. Buyers never see it.',
                    ),
                  ),
                ],
                if (_kind == 'time') ...[
                  Wrap(
                    spacing: 8,
                    children: [
                      for (final m in const [15, 30, 60, 120])
                        ChoiceChip(
                          label: Text(m < 60 ? '$m min' : '${m ~/ 60} h'),
                          selected: _minutes == m,
                          onSelected: (_) => setState(() => _minutes = m),
                        ),
                    ],
                  ),
                  TextField(
                    controller: _note,
                    maxLength: 300,
                    decoration: const InputDecoration(
                      labelText: 'Anything the buyer should know (optional)',
                      counterText: '',
                    ),
                  ),
                  Text(
                    'You accept or decline each booking. Nothing is charged '
                    'until you accept; unanswered bookings drop after 48 hours.',
                    style: Type.caption.copyWith(color: EvabobColors.navyMuted),
                  ),
                ],
                const SizedBox(height: Space.sm),
                Text(
                  'Payouts reach your balance in batches, less the 0.05% '
                  'Evabob fee and the network cost of sending them.',
                  style: Type.caption.copyWith(color: EvabobColors.navyMuted),
                ),
                if (_error != null) ...[
                  const SizedBox(height: Space.sm),
                  Text(_error!,
                      style: Type.caption.copyWith(color: EvabobColors.alert)),
                ],
                const SizedBox(height: Space.lg),
                SizedBox(
                  width: double.infinity,
                  height: 52,
                  child: FilledButton(
                    onPressed: _busy ? null : _save,
                    child: _busy
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Make paywall'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
