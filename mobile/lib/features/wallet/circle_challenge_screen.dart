import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show kDebugMode, kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:crypto/crypto.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/text_safe.dart';
import 'challenge_frame.dart';

/// Runs one or more Circle challenges in a **single** WebView session
/// so the user is not bounced through multiple screens (double-PIN UX).
///
/// In the web-app the same document runs in an iframe instead
/// ([ChallengeFrame]); everything else on this screen is shared.
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

  /// Web-app only: the PIN document is ready to show in its iframe.
  bool _webReady = false;
  String _status = 'Loading secure confirmation…';
  bool _done = false;
  bool _initialDocumentLoaded = false;
  bool _credentialsInjected = false;
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
    if (kDebugMode) {
      debugPrint(
        'CircleChallengeScreen: challenges=${widget.challengeIds.length}',
      );
    }
    _boot();
  }

  void _setStatus(Object? message) {
    if (!mounted) return;
    setState(() => _status = shortUiText(message, max: 200));
  }

  Future<String> _trustedDocument() async {
    final html = await rootBundle.loadString('assets/challenge.html');
    final sdk = await rootBundle.loadString('assets/circle_w3s_sdk.js');
    final checksum = (await rootBundle.loadString(
      'assets/circle_w3s_sdk.js.sha256',
    ))
        .trim()
        .split(RegExp(r'\s+'))
        .first;
    final actual = sha256.convert(utf8.encode(sdk)).toString();
    if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(checksum) || actual != checksum) {
      throw StateError('Bundled Circle SDK integrity check failed');
    }
    const marker = '/*__CIRCLE_SDK_BUNDLE__*/';
    if (!html.contains(marker) || sdk.contains('</script')) {
      throw StateError('Bundled Circle SDK document is invalid');
    }
    return html.replaceFirst(marker, sdk);
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
      if (kDebugMode) {
        debugPrint('CircleChallengeScreen android config: $e');
      }
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
      if (kDebugMode) {
        debugPrint(
          'CircleChallengeScreen abort: incomplete local challenge input',
        );
      }
      return;
    }

    // The web-app serves this document itself, built and checksum-verified
    // from the same assets (web-app/tool/sync_assets.mjs).
    if (kIsWeb) {
      if (!mounted) return;
      setState(() {
        _webReady = true;
        _status = widget.challengeIds.length > 1
            ? 'Confirm once — approving ${widget.challengeIds.length} steps…'
            : 'Confirm with your PIN';
      });
      return;
    }

    late final String html;
    try {
      html = await _trustedDocument();
    } catch (e) {
      if (kDebugMode) {
        debugPrint('CircleChallengeScreen local asset verification failed: $e');
      }
      _setStatus('Secure confirmation could not be loaded');
      return;
    }

    late final WebViewController controller;
    controller = WebViewController()
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
            if (!request.isMainFrame) {
              return _isTrustedCircleResource(request.url)
                  ? NavigationDecision.navigate
                  : NavigationDecision.prevent;
            }
            if (!_initialDocumentLoaded && _isInitialDocument(request.url)) {
              return NavigationDecision.navigate;
            }
            _setStatus('Unexpected navigation blocked');
            return NavigationDecision.prevent;
          },
          onPageFinished: (url) async {
            if (!_initialDocumentLoaded && _isInitialDocument(url)) {
              _initialDocumentLoaded = true;
              if (!_credentialsInjected) {
                _credentialsInjected = true;
                await controller.runJavaScript(
                  'window.startEvabobChallenge(${jsonEncode(_authPayload)});',
                );
              }
              if (!_done) _setStatus('Enter your PIN when prompted');
            }
          },
          onWebResourceError: (err) {
            final failedHost = Uri.tryParse(err.url ?? '')?.host;
            if (kDebugMode) {
              debugPrint(
                'CircleChallengeScreen resource error: '
                '${err.errorCode} host=${failedHost?.isNotEmpty == true ? failedHost : "unknown"}',
              );
            }
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

  bool _isTrustedCircleResource(String raw) {
    if (raw == 'about:blank') return true;
    final uri = Uri.tryParse(raw);
    return uri != null &&
        uri.scheme == 'https' &&
        const {
          'pw-auth.circle.com',
          'identitytoolkit.googleapis.com',
          'securetoken.googleapis.com',
        }.contains(uri.host) &&
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
      if (kDebugMode) debugPrint('CircleChallengeScreen bridge event: $type');
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
      if (kDebugMode) debugPrint('CircleChallengeScreen bad bridge payload');
    }
  }

  @override
  Widget build(BuildContext context) {
    // Permanent layout shell: Scaffold → Material → SafeArea → Column
    // WebView needs a bounded height → Expanded (never put inside ScrollView alone).
    return Scaffold(
      resizeToAvoidBottomInset: true,
      backgroundColor: EvabobColors.pageBg,
      appBar: AppBar(
        title: Text(
          widget.title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: Type.body.copyWith(color: EvabobColors.ink),
        ),
        backgroundColor: EvabobColors.pageBg,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.close_rounded, color: EvabobColors.ink),
          tooltip: 'Close',
          onPressed: () => Navigator.of(context).pop(false),
        ),
      ),
      body: Material(
        color: EvabobColors.pageBg,
        child: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
                child: Container(
                  padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                  decoration: BoxDecoration(
                    color: EvabobColors.blue.withValues(alpha: .08),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    children: [
                      Icon(
                        Icons.lock_outline_rounded,
                        size: 16,
                        color: EvabobColors.emeraldDeep,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          _status,
                          maxLines: 3,
                          overflow: TextOverflow.ellipsis,
                          softWrap: true,
                          style: Type.label.copyWith(
                            color: EvabobColors.emeraldDeep,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              Expanded(
                child: ClipRect(
                  child: _webReady
                      ? ChallengeFrame(
                          payload: _authPayload,
                          onMessage: _onBridge,
                          onStarted: () {
                            if (!_done) {
                              _setStatus('Enter your PIN when prompted');
                            }
                          },
                        )
                      : _controller == null
                          ? Center(
                              child: CircularProgressIndicator(
                                color: EvabobColors.blue,
                              ),
                            )
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
