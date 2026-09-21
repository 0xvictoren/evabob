import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';

import '../../core/config/env.dart';
import '../../core/api/api_client.dart';
import '../../core/held/held_payments_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/glass.dart';
import 'package:provider/provider.dart';

/// The conversation on a payment under review: the payer, the person being
/// paid and the reviewer, each message with its own links and photos.
///
/// Used by both people's held-payment screen and the reviewer's screen. [me]
/// is who is writing (payer, worker or reviewer); [onSend] posts a message
/// and returns once it is saved.
class ReviewConversation extends StatefulWidget {
  const ReviewConversation({
    super.key,
    required this.messages,
    required this.me,
    required this.open,
    required this.onSend,
  });

  final List<ReviewMessage> messages;
  final String me;
  final bool open;
  final Future<void> Function(
    String text,
    List<String> links,
    List<EvidencePhoto> photos,
  ) onSend;

  @override
  State<ReviewConversation> createState() => _ReviewConversationState();
}

class _ReviewConversationState extends State<ReviewConversation> {
  final _text = TextEditingController();
  final _links = TextEditingController();
  final List<EvidencePhoto> _photos = [];
  bool _sending = false;
  bool _showLinks = false;
  String? _error;

  @override
  void dispose() {
    _text.dispose();
    _links.dispose();
    super.dispose();
  }

  String _who(String from) => switch (from) {
        _ when from == widget.me => 'You',
        'payer' => 'Payer',
        'worker' => 'Being paid',
        'reviewer' => 'Reviewer',
        _ => from,
      };

  String _photoUrl(String path) {
    if (path.startsWith('http')) return path;
    return '${Env.resolveApiBaseUrl().replaceAll(RegExp(r'/$'), '')}$path';
  }

  Future<void> _addPhoto() async {
    if (_photos.length >= 3) return;
    try {
      final file = await ImagePicker().pickImage(
        source: ImageSource.gallery,
        maxWidth: 1280,
        maxHeight: 1280,
        imageQuality: 70,
      );
      if (file == null) return;
      var bytes = await file.readAsBytes();
      if (bytes.length > 250 * 1024) {
        // Try once more, smaller, before giving up.
        final smaller = await ImagePicker().pickImage(
          source: ImageSource.gallery,
          maxWidth: 900,
          maxHeight: 900,
          imageQuality: 55,
        );
        if (smaller == null) return;
        bytes = await smaller.readAsBytes();
      }
      if (bytes.length > 250 * 1024) {
        setState(() => _error = 'That photo is too large. Try a screenshot.');
        return;
      }
      final lower = file.name.toLowerCase();
      final mime = lower.endsWith('.png')
          ? 'image/png'
          : lower.endsWith('.webp')
              ? 'image/webp'
              : 'image/jpeg';
      setState(() {
        _photos.add(EvidencePhoto(base64: base64Encode(bytes), mime: mime));
        _error = null;
      });
    } catch (e) {
      setState(() => _error = friendlyError(e));
    }
  }

  Future<void> _send() async {
    final text = _text.text.trim();
    if (text.isEmpty) {
      setState(() => _error = 'Write something first.');
      return;
    }
    final links = _links.text
        .split(RegExp(r'[\s,]+'))
        .map((s) => s.trim())
        .where((s) => s.isNotEmpty)
        .toList();
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      await widget.onSend(text, links, List.of(_photos));
      if (!mounted) return;
      setState(() {
        _text.clear();
        _links.clear();
        _photos.clear();
        _showLinks = false;
      });
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final df = DateFormat('d MMM, HH:mm');
    final mediaHeaders = context.read<ApiClient>().mediaHeaders;
    return Glass(
      padding: const EdgeInsets.all(Space.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Conversation',
              style: Type.label.copyWith(color: EvabobColors.nearBlack)),
          const SizedBox(height: Space.xs),
          Text(
            widget.open
                ? 'Everything here is seen by both of you and the reviewer. '
                    'Add photos or links that show what happened.'
                : 'This review is closed.',
            style: Type.caption.copyWith(color: EvabobColors.navyMuted),
          ),
          const SizedBox(height: Space.md),
          if (widget.messages.isEmpty)
            Text('No messages yet.',
                style: Type.caption.copyWith(color: EvabobColors.navyMuted)),
          for (final m in widget.messages)
            Padding(
              padding: const EdgeInsets.only(bottom: Space.md),
              child: Align(
                alignment: m.from == widget.me
                    ? Alignment.centerRight
                    : Alignment.centerLeft,
                child: Container(
                  constraints: const BoxConstraints(maxWidth: 320),
                  padding: const EdgeInsets.all(Space.md),
                  decoration: BoxDecoration(
                    color: m.from == 'reviewer'
                        ? EvabobColors.blueSoft.withValues(alpha: 0.35)
                        : m.from == widget.me
                            ? EvabobColors.sand.withValues(alpha: 0.6)
                            : EvabobColors.white,
                    borderRadius: Radii.all(Radii.sm),
                    border: Border.all(color: EvabobColors.hairline),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${_who(m.from)} · ${df.format(m.at.toLocal())}',
                        style: Type.caption
                            .copyWith(color: EvabobColors.navyMuted),
                      ),
                      const SizedBox(height: 4),
                      SelectableText(m.text,
                          style: Type.body
                              .copyWith(color: EvabobColors.nearBlack)),
                      for (final l in m.links)
                        SelectableText(l,
                            style: Type.caption
                                .copyWith(color: EvabobColors.blue)),
                      if (m.photos.isNotEmpty) ...[
                        const SizedBox(height: Space.sm),
                        Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: [
                            for (final p in m.photos)
                              GestureDetector(
                                onTap: () => showDialog<void>(
                                  context: context,
                                  builder: (_) => Dialog(
                                    child: InteractiveViewer(
                                      child: Image.network(
                                        _photoUrl(p),
                                        headers: mediaHeaders,
                                      ),
                                    ),
                                  ),
                                ),
                                child: ClipRRect(
                                  borderRadius: Radii.all(Radii.sm),
                                  child: Image.network(
                                    _photoUrl(p),
                                    headers: mediaHeaders,
                                    width: 84,
                                    height: 84,
                                    fit: BoxFit.cover,
                                    errorBuilder: (_, __, ___) =>
                                        const SizedBox(
                                      width: 84,
                                      height: 84,
                                      child: Icon(Icons.broken_image_outlined),
                                    ),
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          if (widget.open) ...[
            const Divider(height: Space.lg),
            TextField(
              controller: _text,
              minLines: 1,
              maxLines: 5,
              maxLength: 2000,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                hintText: 'Write a message',
                counterText: '',
              ),
            ),
            if (_showLinks)
              TextField(
                controller: _links,
                decoration: const InputDecoration(
                  hintText: 'Links, separated by spaces',
                ),
              ),
            if (_photos.isNotEmpty) ...[
              const SizedBox(height: Space.sm),
              Wrap(
                spacing: 6,
                children: [
                  for (var i = 0; i < _photos.length; i++)
                    InputChip(
                      label: Text('Photo ${i + 1}'),
                      onDeleted: () => setState(() => _photos.removeAt(i)),
                    ),
                ],
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: Space.sm),
              Text(_error!,
                  style: Type.caption.copyWith(color: EvabobColors.alert)),
            ],
            const SizedBox(height: Space.sm),
            Row(
              children: [
                IconButton(
                  tooltip: 'Add a photo',
                  onPressed: _sending || _photos.length >= 3 ? null : _addPhoto,
                  icon: const Icon(Icons.add_photo_alternate_outlined),
                ),
                IconButton(
                  tooltip: 'Add a link',
                  onPressed: _sending
                      ? null
                      : () => setState(() => _showLinks = !_showLinks),
                  icon: const Icon(Icons.link_rounded),
                ),
                const Spacer(),
                FilledButton(
                  onPressed: _sending ? null : _send,
                  child: _sending
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Send'),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
