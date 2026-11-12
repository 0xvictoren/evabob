import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/fx/fx_service.dart';
import '../../core/market/market_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/amount_input.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import 'market_widgets.dart';
import '../../core/platform/locator.dart';

/// Posting to the market: something to sell, or something needed.
///
/// It starts with one sentence ("I need someone to clean my flat in Lekki on
/// Saturday"). The server's assistant turns it into the fields below, which
/// the person checks before anything is posted. Pops with the new post's id.
class MarketPostForm extends StatefulWidget {
  const MarketPostForm({super.key, this.want = false});

  final bool want;

  @override
  State<MarketPostForm> createState() => _MarketPostFormState();
}

class _MarketPostFormState extends State<MarketPostForm> {
  late final MarketApi _api = MarketApi(context.read<ApiClient>());
  late bool _want = widget.want;
  String _type = 'service';
  String? _category;
  final _sentence = TextEditingController();
  final _title = TextEditingController();
  final _description = TextEditingController();
  final _price = TextEditingController();
  final _area = TextEditingController();
  String? _state;
  MapPoint? _point;
  bool _remote = false;
  int _days = 7;
  final List<String> _photos = [];
  bool _busy = false;
  bool _assisting = false;
  bool _photoBusy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadPlace();
  }

  @override
  void dispose() {
    for (final c in [_sentence, _title, _description, _price, _area]) {
      c.dispose();
    }
    super.dispose();
  }

  /// Where the person said they are last time, so they say it once.
  Future<void> _loadPlace() async {
    try {
      final me = await _api.me();
      final place = me['place'];
      if (place is Map && mounted) {
        setState(() {
          _state = place['state']?.toString();
          _area.text = place['area']?.toString() ?? '';
          _point = DeviceLocation.fromPlace(place);
        });
      }
    } catch (_) {
      /* the fields stay empty; they can type it */
    }
  }

  Future<void> _assist() async {
    final text = _sentence.text.trim();
    if (text.length < 3) return;
    setState(() => _assisting = true);
    try {
      final r = await _api.assist(text);
      if (!mounted) return;
      setState(() {
        _want = r['kind'] == 'want';
        _type = r['type'] == 'goods' ? 'goods' : 'service';
        _category = r['category']?.toString();
        _title.text = r['title']?.toString() ?? text;
        final d = r['description']?.toString() ?? '';
        if (d.isNotEmpty && _description.text.isEmpty) _description.text = d;
      });
    } catch (e) {
      if (mounted) setState(() => _title.text = text);
    } finally {
      if (mounted) setState(() => _assisting = false);
    }
  }

  Future<void> _addPhoto() async {
    if (_photos.length >= 4 || _photoBusy) return;
    setState(() => _photoBusy = true);
    try {
      final file = await ImagePicker().pickImage(
        source: ImageSource.gallery,
        maxWidth: 1080,
        maxHeight: 1080,
        imageQuality: 65,
      );
      if (file == null) return;
      final bytes = await file.readAsBytes();
      if (bytes.length > 250 * 1024) {
        setState(() => _error = 'That photo is too large. Try a smaller one or a screenshot.');
        return;
      }
      final lower = file.name.toLowerCase();
      final mime = lower.endsWith('.png')
          ? 'image/png'
          : lower.endsWith('.webp')
              ? 'image/webp'
              : 'image/jpeg';
      final path = await _api.uploadPhoto(base64Encode(bytes), mime);
      if (path.isNotEmpty && mounted) setState(() => _photos.add(path));
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _photoBusy = false);
    }
  }

  Future<void> _submit() async {
    final fx = context.read<FxService>();
    final typed = double.tryParse(_price.text.replaceAll(',', ''));
    String? problem;
    if (_title.text.trim().length < 3) {
      problem = _want ? 'Say what you need.' : 'Say what you are selling.';
    } else if (typed == null || typed <= 0) {
      problem = _want ? 'Say how much you will pay.' : 'Set a price.';
    } else if ((_state ?? '').isEmpty && _area.text.trim().isEmpty) {
      problem = 'Say where you are, so people near you find this.';
    }
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final made = await _api.create(
        kind: _want ? 'want' : 'offer',
        type: _type,
        category: _category,
        title: _title.text.trim(),
        description: _description.text.trim(),
        priceUsd: fx.toUsd(typed!),
        display: {'currency': fx.isNaira ? 'NGN' : 'USD', 'amount': typed},
        photos: _photos,
        place: DeviceLocation.place(state: _state, area: _area.text, point: _point),
        remote: _remote,
        deliveryDays: _days,
      );
      if (mounted) Navigator.of(context).pop(made.post.id);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = friendlyError(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final fx = context.watch<FxService>();
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: GestureDetector(
          onTap: () => FocusScope.of(context).unfocus(),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(
                Space.page, 0, Space.page, Space.xxl),
            children: [
              EvabobPageHeader(
                title: _want ? 'Post what you need' : 'Sell something',
                onBack: () => Navigator.of(context).maybePop(),
              ),
              SegmentedButton<bool>(
                segments: const [
                  ButtonSegment(
                    value: false,
                    label: Text('I sell this'),
                    icon: Icon(Icons.sell_outlined),
                  ),
                  ButtonSegment(
                    value: true,
                    label: Text('I need this'),
                    icon: Icon(Icons.campaign_outlined),
                  ),
                ],
                selected: {_want},
                showSelectedIcon: false,
                onSelectionChanged: (s) => setState(() => _want = s.first),
              ),
              const SizedBox(height: Space.lg),
              Glass(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        Icon(Icons.auto_awesome_rounded,
                            size: 18, color: EvabobColors.emeraldDeep),
                        const SizedBox(width: 6),
                        Text('Say it in one sentence',
                            style: Type.body.copyWith(color: EvabobColors.ink)),
                      ],
                    ),
                    const SizedBox(height: Space.sm),
                    TextField(
                      controller: _sentence,
                      maxLines: 2,
                      textInputAction: TextInputAction.done,
                      onSubmitted: (_) => _assist(),
                      decoration: InputDecoration(
                        hintText: _want
                            ? 'I need someone to deep-clean my 3-bedroom flat in Lekki this Saturday'
                            : 'I bake custom birthday cakes in Ikeja, delivered in 2 days',
                      ),
                    ),
                    const SizedBox(height: Space.sm),
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton.icon(
                        onPressed: _assisting ? null : _assist,
                        icon: _assisting
                            ? const SizedBox.square(
                                dimension: 16,
                                child: CircularProgressIndicator(strokeWidth: 2))
                            : const Icon(Icons.edit_note_rounded),
                        label: const Text('Fill it in for me'),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: Space.lg),
              Glass(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Wrap(
                      spacing: Space.sm,
                      children: [
                        for (final t in const [('service', 'A service'), ('goods', 'Goods')])
                          ChoiceChip(
                            label: Text(t.$2),
                            selected: _type == t.$1,
                            onSelected: (_) => setState(() => _type = t.$1),
                          ),
                      ],
                    ),
                    const SizedBox(height: Space.md),
                    TextField(
                      controller: _title,
                      maxLength: 90,
                      textCapitalization: TextCapitalization.sentences,
                      decoration: InputDecoration(
                        labelText: _want ? 'What you need' : 'What you sell',
                      ),
                    ),
                    TextField(
                      controller: _description,
                      maxLines: 4,
                      maxLength: 1500,
                      textCapitalization: TextCapitalization.sentences,
                      decoration: const InputDecoration(
                        labelText: 'Details (optional)',
                        hintText: 'Size, quantity, when, anything that helps',
                      ),
                    ),
                    DropdownButtonFormField<String?>(
                      // ignore: deprecated_member_use
                      value: _category,
                      isExpanded: true,
                      decoration: const InputDecoration(labelText: 'Category'),
                      items: [
                        const DropdownMenuItem<String?>(
                            value: null, child: Text('Choose for me')),
                        for (final c in marketCategories)
                          DropdownMenuItem<String?>(
                            value: c.id,
                            child: Row(
                              children: [
                                Icon(marketCategoryIcon(c.id),
                                    size: 18, color: EvabobColors.primary),
                                const SizedBox(width: 8),
                                Flexible(
                                    child: Text(c.label,
                                        overflow: TextOverflow.ellipsis)),
                              ],
                            ),
                          ),
                      ],
                      onChanged: (v) => setState(() => _category = v),
                    ),
                    const SizedBox(height: Space.md),
                    TextField(
                      controller: _price,
                      keyboardType:
                          const TextInputType.numberWithOptions(decimal: true),
                      inputFormatters: const [AmountInputFormatter()],
                      decoration: InputDecoration(
                        labelText: _want
                            ? 'The most you will pay (${fx.isNaira ? 'naira' : 'dollars'})'
                            : 'Price (${fx.isNaira ? 'naira' : 'dollars'})',
                        prefixText: fx.isNaira ? '₦ ' : '\$ ',
                      ),
                    ),
                    const SizedBox(height: Space.md),
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            _want ? 'Needed within' : 'Delivered within',
                            style: Type.body.copyWith(color: EvabobColors.ink),
                          ),
                        ),
                        IconButton(
                          onPressed: _days > 1 ? () => setState(() => _days--) : null,
                          icon: const Icon(Icons.remove_circle_outline),
                        ),
                        Text('$_days ${_days == 1 ? 'day' : 'days'}', style: Type.body),
                        IconButton(
                          onPressed: _days < 60 ? () => setState(() => _days++) : null,
                          icon: const Icon(Icons.add_circle_outline),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: Space.lg),
              Glass(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('Where', style: Type.body.copyWith(color: EvabobColors.ink)),
                    const SizedBox(height: 4),
                    Text(
                      'Only your area is shown, never your address. It is how '
                      'people near you find this first.',
                      style: Type.label.copyWith(color: EvabobColors.inkMuted),
                    ),
                    const SizedBox(height: Space.md),
                    PlaceFields(
                      state: _state,
                      area: _area,
                      onState: (v) => setState(() => _state = v),
                      point: _point,
                      onPoint: (p) => setState(() => _point = p),
                    ),
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      value: _remote,
                      onChanged: (v) => setState(() => _remote = v),
                      title: Text(_want
                          ? 'Can be done from anywhere'
                          : 'I can do or send this anywhere'),
                      subtitle: const Text('Design work, a parcel by courier, lessons online'),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: Space.lg),
              Glass(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('Photos (up to 4)',
                        style: Type.body.copyWith(color: EvabobColors.ink)),
                    const SizedBox(height: Space.sm),
                    Wrap(
                      spacing: Space.sm,
                      runSpacing: Space.sm,
                      children: [
                        for (final p in _photos)
                          Stack(
                            children: [
                              ClipRRect(
                                borderRadius: Radii.all(Radii.sm),
                                child: Image.network(marketPhotoUrl(p),
                                    width: 72, height: 72, fit: BoxFit.cover),
                              ),
                              Positioned(
                                right: 0,
                                top: 0,
                                child: GestureDetector(
                                  onTap: () => setState(() => _photos.remove(p)),
                                  child: const CircleAvatar(
                                    radius: 11,
                                    backgroundColor: EvabobColors.ink,
                                    child: Icon(Icons.close, size: 14,
                                        color: EvabobColors.white),
                                  ),
                                ),
                              ),
                            ],
                          ),
                        if (_photos.length < 4)
                          PressScale(
                            onTap: _addPhoto,
                            child: Container(
                              width: 72,
                              height: 72,
                              decoration: BoxDecoration(
                                color: EvabobColors.pageBg,
                                borderRadius: Radii.all(Radii.sm),
                              ),
                              child: _photoBusy
                                  ? const Center(
                                      child: SizedBox.square(
                                          dimension: 20,
                                          child: CircularProgressIndicator(strokeWidth: 2)))
                                  : Icon(Icons.add_a_photo_outlined,
                                      color: EvabobColors.primary),
                            ),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: Space.lg),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: Space.md),
                  child: Text(_error!,
                      style: Type.body.copyWith(color: EvabobColors.alert)),
                ),
              EvabobPrimaryButton(
                label: _want ? 'Post and find sellers' : 'Post it',
                busy: _busy,
                onPressed: _submit,
              ),
              const SizedBox(height: Space.md),
              Text(
                _want
                    ? 'Nothing is paid until you accept an offer. Sellers near '
                        'you with a good record are told first.'
                    : 'Buyers pay through Evabob and choose how: hold it all '
                        'until delivery, pay half now, or pay it all.',
                textAlign: TextAlign.center,
                style: Type.label.copyWith(color: EvabobColors.inkMuted),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
