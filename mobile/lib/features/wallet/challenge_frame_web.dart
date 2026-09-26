import 'dart:convert';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:flutter/widgets.dart';
import 'package:web/web.dart' as web;

/// Runs the Circle PIN document in an iframe.
///
/// The page is `circle/challenge.html` on the web-app's own origin, written at
/// build time by `web-app/tool/sync_assets.mjs` from the same challenge.html
/// and checksum-verified Circle SDK the phones load into their WebView. It has
/// to be a real page there (not inline `srcdoc`): Circle's PIN iframe replies
/// to its parent's origin. A small script in it, carrying the document's
/// nonce, stands in for the WebView's `EvabobBridge` channel by calling
/// `evabobChallengeBridge` on this page.
class ChallengeFrame extends StatefulWidget {
  const ChallengeFrame({
    super.key,
    required this.payload,
    required this.onMessage,
    required this.onStarted,
  });

  final Map<String, dynamic> payload;
  final void Function(String message) onMessage;
  final VoidCallback onStarted;

  @override
  State<ChallengeFrame> createState() => _ChallengeFrameState();
}

class _ChallengeFrameState extends State<ChallengeFrame> {
  static const _document = 'circle/challenge.html';
  static const _callback = 'evabobChallengeBridge';
  bool _started = false;

  @override
  void initState() {
    super.initState();
    // One PIN screen at a time, so one page-level callback.
    globalContext.setProperty(
      _callback.toJS,
      ((JSString message) => widget.onMessage(message.toDart)).toJS,
    );
  }

  @override
  void dispose() {
    globalContext.delete(_callback.toJS);
    super.dispose();
  }

  void _start(web.HTMLIFrameElement frame) {
    if (_started || !mounted) return;
    final win = frame.contentWindow;
    if (win == null) return;
    _started = true;
    (win as JSObject).callMethod(
      '__evabobStart'.toJS,
      jsonEncode(widget.payload).toJS,
    );
    widget.onStarted();
  }

  @override
  Widget build(BuildContext context) {
    return HtmlElementView.fromTagName(
      tagName: 'iframe',
      onElementCreated: (element) {
        final frame = element as web.HTMLIFrameElement;
        frame.style
          ..border = '0'
          ..width = '100%'
          ..height = '100%';
        frame.title = 'Confirm with your PIN';
        frame.addEventListener(
          'load',
          ((web.Event _) => _start(frame)).toJS,
        );
        frame.src = _document;
      },
    );
  }
}
