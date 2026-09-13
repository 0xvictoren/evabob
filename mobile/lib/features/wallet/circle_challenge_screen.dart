import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../../core/theme/evabob_colors.dart';
import '../../core/utils/text_safe.dart';

/// Runs one or more Circle challenges in a **single** WebView session
/// so the user is not bounced through multiple screens (double-PIN UX).
///
/// Layout rules (prevents the classic "Confirm swap" overflow mess):
/// - Always [Scaffold] + [Material] + [SafeArea]
/// - Status line is constrained (maxLines + ellipsis) — never dump raw API/errors
/// - WebView sits in [Expanded] + [ClipRect] (bounded height; no nested flex bomb)
/// - Do not nest custom swap details inside Circle's PIN challenge UI
class CircleChallengeScreen extends StatefulWidget {
  const CircleChallengeScreen({
    super.key,
    required this.appId,
    required this.userToken,
    required this.encryptionKey,
    required this.challengeIds,
    this.title = 'Confirm',
  });

  final String appId;
  final String userToken;
  final String encryptionKey;
  final List<String> challengeIds;
  final String title;

  factory CircleChallengeScreen.single({
    required String appId,
    required String userToken,
    required String encryptionKey,
    required String challengeId,
    String title = 'Confirm',
  }) {
    return CircleChallengeScreen(
      appId: appId,
      userToken: userToken,
      encryptionKey: encryptionKey,
      challengeIds: [challengeId],
      title: title,
    );
  }

  @override
  State<CircleChallengeScreen> createState() => _CircleChallengeScreenState();
}

class _CircleChallengeScreenState extends State<CircleChallengeScreen> {
  static const _challengeDocumentUrl = 'https://evabob.app/_circle-challenge/';
  WebViewController? _controller;
  String _status = 'Loading secure confirmation…';
  bool _done = false;
  bool _initialDocumentLoaded = false;
  final List<String> _completedIds = [];
  final List<String> _failedIds = [];

  /// challengeId → 0x signature, for typed-data challenges. Circle never
  /// returns these from the server, so they must be relayed from here.
  final Map<String, String> _signatures = {};

  Map<String, dynamic> get _authPayload => {
        'appId': widget.appId,
        'userToken': widget.userToken,
        'encryptionKey': widget.encryptionKey.trim(),
        // First challenge id for backward-compatible single-execute page
        'challengeId': widget.challengeIds.first,
        // Full list for sequential execute in one session
        'challengeIds': widget.challengeIds,
      };

  @override
  void initState() {
    super.initState();
    debugPrint(
      'CircleChallengeScreen: challenges=${widget.challengeIds} '
      'tokenLen=${widget.userToken.length} '
      'keyLen=${widget.encryptionKey.trim().length} '
      'appId=${widget.appId}',
    );
    _boot();
  }

  void _setStatus(Object? message) {
    if (!mounted) return;
    setState(() => _status = shortUiText(message, max: 200));
  }

  /// Embed auth JSON in HTML so the module never races JS injection.
  String _embedAuth(String html) {
    final payload = jsonEncode(_authPayload);
    final boot = '<script>window.__EVABOB_CHALLENGE__=$payload;</script>';
    if (html.contains('</head>')) {
      return html.replaceFirst('</head>', '$boot</head>');
    }
    return '$boot$html';
  }

  Future<void> _configureAndroid(WebViewController controller) async {
    final platform = controller.platform;
    if (platform is! AndroidWebViewController) return;
    try {
      await platform.setMediaPlaybackRequiresUserGesture(false);
      await platform.setMixedContentMode(MixedContentMode.neverAllow);
      // Circle W3S uses iframes + cookies for getDeviceId / PIN UI.
      final cookieManager = WebViewCookieManager();
      final cookiePlatform = cookieManager.platform;
      if (cookiePlatform is AndroidWebViewCookieManager) {
        await cookiePlatform.setAcceptThirdPartyCookies(platform, true);
      }
      if (kDebugMode) {
        platform.setOnConsoleMessage((msg) {
          debugPrint('W3S WebView [${msg.level.name}]: ${msg.message}');
        });
      }
    } catch (e) {
      debugPrint('CircleChallengeScreen android config: $e');
    }
  }

  Future<void> _boot() async {
    final key = widget.encryptionKey.trim();
    if (key.isEmpty ||
        key.contains(' ') ||
        widget.challengeIds.isEmpty ||
        widget.userToken.trim().isEmpty ||
        widget.appId.trim().isEmpty) {
      _setStatus('Missing session — close and try again');
      debugPrint(
        'CircleChallengeScreen abort: empty auth '
        'ids=${widget.challengeIds.length} appId=${widget.appId.isNotEmpty}',
      );
      return;
    }

    String html;
    try {
      html = await rootBundle.loadString('assets/challenge.html');
    } catch (e) {
      debugPrint('CircleChallengeScreen asset load failed: $e');
      html = _fallbackHtml();
    }
    html = _embedAuth(html);

    final controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      // Light background — Circle PIN UI is light; black + broken CSS = red garbage.
      ..setBackgroundColor(EvabobColors.pageBg)
      ..addJavaScriptChannel(
        'EvabobBridge',
        onMessageReceived: (msg) => _onBridge(msg.message),
      )
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) {
            // Circle's PIN sheet runs in subframes. The app document itself
            // must never navigate after credentials have been embedded.
            if (!request.isMainFrame) return NavigationDecision.navigate;
            if (!_initialDocumentLoaded && _isInitialDocument(request.url)) {
              return NavigationDecision.navigate;
            }
            _setStatus('Unexpected navigation blocked');
            return NavigationDecision.prevent;
          },
          onPageFinished: (url) {
            if (!_initialDocumentLoaded && _isInitialDocument(url)) {
              _initialDocumentLoaded = true;
              if (!_done) _setStatus('Enter your PIN when prompted');
            }
          },
          onWebResourceError: (err) {
            final failedHost = Uri.tryParse(err.url ?? '')?.host;
            debugPrint(
              'CircleChallengeScreen resource error: '
              '${err.errorCode} host=${failedHost?.isNotEmpty == true ? failedHost : "unknown"}',
            );
            if (!_done) {
              _setStatus('Network error loading secure UI');
            }
          },
        ),
      );

    await _configureAndroid(controller);

    // HTTPS base URL so ES module import + Circle iframes share a secure origin.
    await controller.loadHtmlString(
      html,
      baseUrl: _challengeDocumentUrl,
    );

    if (!mounted) return;
    setState(() {
      _controller = controller;
      _status = widget.challengeIds.length > 1
          ? 'Confirm once — approving ${widget.challengeIds.length} steps…'
          : 'Confirm with your PIN';
    });
  }

  bool _isInitialDocument(String raw) {
    // Some WebView implementations report loadHtmlString as about:blank even
    // when a secure base URL is supplied. It is accepted only for the first
    // document and never after credentials are loaded.
    if (raw == 'about:blank') return true;
    final uri = Uri.tryParse(raw);
    return uri != null &&
        uri.scheme == 'https' &&
        uri.host == 'evabob.app' &&
        uri.path == '/_circle-challenge/' &&
        !uri.hasQuery &&
        !uri.hasFragment;
  }

  void _collectIds(Map<String, dynamic> data) {
    void absorb(String key, List<String> into) {
      final v = data[key];
      if (v is List) {
        for (final e in v) {
          final s = e?.toString() ?? '';
          if (s.isNotEmpty && !into.contains(s)) into.add(s);
        }
      }
    }

    absorb('completedIds', _completedIds);
    absorb('failedIds', _failedIds);

    // Signatures arrive either per-step (progress) or batched (success).
    final sig = data['signature']?.toString();
    final sigFor = data['challengeId']?.toString();
    if (sig != null &&
        sig.startsWith('0x') &&
        sigFor != null &&
        sigFor.isNotEmpty) {
      _signatures[sigFor] = sig;
    }
    final batch = data['signatures'];
    if (batch is List) {
      for (final e in batch) {
        if (e is! Map) continue;
        final id = e['challengeId']?.toString();
        final s = e['signature']?.toString();
        if (id != null && id.isNotEmpty && s != null && s.startsWith('0x')) {
          _signatures[id] = s;
        }
      }
    }

    final single = data['challengeId']?.toString();
    if (single != null &&
        single.isNotEmpty &&
        data['failed'] != true &&
        !_failedIds.contains(single) &&
        !_completedIds.contains(single) &&
        (data['type'] == 'progress' || data['type'] == 'success')) {
      // progress with resultStatus may mark a step complete
      final st = data['resultStatus']?.toString().toUpperCase() ?? '';
      if (st == 'COMPLETE' ||
          st == 'COMPLETED' ||
          st == 'SUCCESS' ||
          st == 'OK' ||
          st.isEmpty) {
        if (data['type'] == 'success' || data['resultStatus'] != null) {
          if (!_completedIds.contains(single)) _completedIds.add(single);
        }
      }
    }
  }

  /// Popping this route destroys the WebView, and with it the Circle iframe
  /// that is still posting the signed payload back to Circle. Tearing it down
  /// the instant `sdk.execute` calls back is what leaves challenges stuck at
  /// PENDING. Give the SDK a moment to flush before unmounting.
  static const _settleDelay = Duration(milliseconds: 1200);

  Future<void> _finish(
    bool ok, {
    bool cancelled = false,
    bool partial = false,
  }) async {
    if (_done) return;
    _done = true;
    if (ok || partial) {
      _setStatus('Finalizing with Circle…');
      await Future<void>.delayed(_settleDelay);
    }
    if (!mounted) return;
    // Prefer structured result so parent can verify + re-run PENDING only.
    Navigator.of(context).pop(<String, dynamic>{
      'ok': ok,
      'cancelled': cancelled,
      'partial': partial,
      'completedIds': List<String>.from(_completedIds),
      'failedIds': List<String>.from(_failedIds),
      'signatures': Map<String, String>.from(_signatures),
      'challengeIds': widget.challengeIds,
    });
  }

  void _onBridge(String raw) {
    if (_done) return;
    try {
      final data = jsonDecode(raw) as Map<String, dynamic>;
      final type = data['type']?.toString();
      debugPrint(
        'CircleChallengeScreen bridge: $type ${shortUiText(raw, max: 180)}',
      );
      _collectIds(data);
      if (type == 'success') {
        // Fill completed from payload or assume all requested ids.
        if (_completedIds.isEmpty) {
          _completedIds.addAll(widget.challengeIds);
        }
        _setStatus('Approved — verifying…');
        unawaited(_finish(true));
      } else if (type == 'partial') {
        _setStatus(
          data['message'] ?? 'Almost there — finishing the last step…',
        );
        unawaited(_finish(false, partial: true));
      } else if (type == 'error') {
        final cancelled = data['cancelled'] == true;
        _setStatus(
          data['message'] ??
              data['error'] ??
              (cancelled ? 'Cancelled' : 'PIN error'),
        );
        // If some steps completed, treat as partial so parent can verify.
        if (_completedIds.isNotEmpty && !cancelled) {
          unawaited(_finish(false, partial: true));
        } else if (cancelled) {
          unawaited(_finish(false, cancelled: true));
        }
        // Hard error with zero completions: leave screen open for retry button in HTML.
      } else if (type == 'progress') {
        _setStatus(data['message'] ?? _status);
      }
    } catch (e) {
      debugPrint('CircleChallengeScreen bad bridge payload: $e');
    }
  }

  String _fallbackHtml() => '''
<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<style>
html,body{margin:0;padding:16px;background:#F6F1E8;color:#0F1B2D;font-family:system-ui,sans-serif;overflow-x:hidden;max-width:100vw;word-break:break-word}
#s{max-height:5em;overflow:hidden}
</style></head><body>
<p id="s">Loading…</p>
<script type="module">
import { W3SSdk } from 'https://cdn.jsdelivr.net/npm/@circle-fin/w3s-pw-web-sdk@1.1.11/+esm';
const s = document.getElementById('s');
const short = (m) => { const t = String(m||''); return t.length>180?t.slice(0,140)+'…':t; };
const wait = async () => {
  for (let i=0;i<160;i++) {
    if (window.__EVABOB_CHALLENGE__?.encryptionKey) return window.__EVABOB_CHALLENGE__;
    await new Promise(r=>setTimeout(r,50));
  }
  return null;
};
const post = (o) => { try { window.EvabobBridge.postMessage(JSON.stringify(o)); } catch(e){} };
(async () => {
  const a = await wait();
  if (!a) { s.textContent = 'Session missing'; post({type:'error',message:'Session missing'}); return; }
  const ids = Array.isArray(a.challengeIds) && a.challengeIds.length ? a.challengeIds : [a.challengeId];
  const sdk = new W3SSdk({ appSettings: { appId: a.appId } });
  try {
    const did = await sdk.getDeviceId();
    if (!did) throw new Error('no device id');
  } catch (e) {
    s.textContent = 'Device session failed';
    post({type:'error',message:'Device session failed'});
    return;
  }
  sdk.setAuthentication({ userToken: a.userToken, encryptionKey: a.encryptionKey });
  for (let i=0;i<ids.length;i++) {
    s.textContent = 'Step ' + (i+1) + ' of ' + ids.length + ' — enter PIN if asked';
    post({type:'progress',message:s.textContent,challengeId:ids[i]});
    await new Promise((resolve, reject) => {
      sdk.execute(ids[i], (err, res) => err ? reject(err) : resolve(res));
    }).catch((err) => {
      const message = short(err && (err.message||err.reason) || err || 'PIN failed');
      s.textContent = 'Failed: ' + message;
      post({type:'error',message});
      throw err;
    });
  }
  s.textContent = 'Done';
  post({type:'success',result:{},challengeIds:ids});
})();
</script></body></html>
''';

  @override
  Widget build(BuildContext context) {
    // Permanent layout shell: Scaffold → Material → SafeArea → Column
    // WebView needs a bounded height → Expanded (never put inside ScrollView alone).
    return Scaffold(
      resizeToAvoidBottomInset: true,
      backgroundColor: EvabobColors.cream,
      appBar: AppBar(
        title: Text(widget.title),
        backgroundColor: EvabobColors.cream,
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () => Navigator.of(context).pop(false),
        ),
      ),
      body: Material(
        color: EvabobColors.cream,
        child: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Material(
                color: EvabobColors.sand,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                  child: Text(
                    _status,
                    maxLines: 4,
                    overflow: TextOverflow.ellipsis,
                    softWrap: true,
                    style: const TextStyle(
                      fontSize: 10,
                      height: 1.35,
                      color: EvabobColors.navyMuted,
                    ),
                  ),
                ),
              ),
              Expanded(
                child: ClipRect(
                  child: _controller == null
                      ? const Center(child: CircularProgressIndicator())
                      : WebViewWidget(controller: _controller!),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
