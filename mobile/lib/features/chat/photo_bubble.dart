import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/config/env.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';

/// A photo sent in a chat, with its caption. Tap to see it full screen.
class PhotoBubble extends StatelessWidget {
  const PhotoBubble({super.key, required this.meta, this.mine = false});

  final Map<String, dynamic> meta;
  final bool mine;

  static bool isPhoto(Map<String, dynamic>? meta) =>
      meta?['type']?.toString() == 'photo' &&
      (meta?['url']?.toString() ?? '').isNotEmpty;

  static String resolve(String path) {
    if (path.startsWith('http')) return path;
    return '${Env.resolveApiBaseUrl().replaceAll(RegExp(r'/$'), '')}$path';
  }

  @override
  Widget build(BuildContext context) {
    final url = resolve(meta['url'].toString());
    final headers = context.read<ApiClient>().mediaHeaders;
    final caption = meta['caption']?.toString().trim() ?? '';
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 260),
        child: Column(
          crossAxisAlignment:
              mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            GestureDetector(
              onTap: () => _openFull(context, url, headers),
              child: Semantics(
                image: true,
                label: caption.isEmpty ? 'Photo' : 'Photo: $caption',
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(18),
                  child: Image.network(
                    url,
                    headers: headers,
                    fit: BoxFit.cover,
                    loadingBuilder: (context, child, progress) => progress ==
                            null
                        ? child
                        : Container(
                            width: 220,
                            height: 220,
                            color: EvabobColors.sheet,
                            alignment: Alignment.center,
                            child:
                                const CircularProgressIndicator(strokeWidth: 2),
                          ),
                    errorBuilder: (context, error, stack) => Container(
                      width: 220,
                      height: 120,
                      color: EvabobColors.sheet,
                      alignment: Alignment.center,
                      padding: const EdgeInsets.all(12),
                      child: Text(
                        'This photo could not be loaded.',
                        textAlign: TextAlign.center,
                        style: Type.caption
                            .copyWith(color: EvabobColors.navyMuted),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            if (caption.isNotEmpty) ...[
              const SizedBox(height: 4),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Text(
                  caption,
                  style: Type.body.copyWith(color: EvabobColors.nearBlack),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  static void _openFull(
    BuildContext context,
    String url,
    Map<String, String> headers,
  ) {
    showDialog<void>(
      context: context,
      barrierColor: Colors.black87,
      builder: (ctx) => GestureDetector(
        onTap: () => Navigator.pop(ctx),
        child: Stack(
          children: [
            Positioned.fill(
              child: InteractiveViewer(
                maxScale: 4,
                child: Center(
                  child: Image.network(
                    url,
                    headers: headers,
                    fit: BoxFit.contain,
                  ),
                ),
              ),
            ),
            Positioned(
              top: MediaQuery.of(ctx).padding.top + 8,
              right: 8,
              child: IconButton(
                tooltip: 'Close',
                onPressed: () => Navigator.pop(ctx),
                icon: const Icon(Icons.close_rounded, color: Colors.white),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
