import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/widgets/evabob_ui.dart';

/// One of Evabob's own web pages — the Terms or the Privacy notice — shown
/// inside the app, on Android and iOS alike.
///
/// Only pages on evabob.xyz open here; a link on the page that leads anywhere
/// else is not followed, so this screen cannot become a general browser.
class WebPageScreen extends StatefulWidget {
  const WebPageScreen({super.key, required this.title, required this.url});

  final String title;
  final String url;

  static const termsUrl = 'https://www.evabob.xyz/terms.html';
  static const privacyUrl = 'https://www.evabob.xyz/privacy.html';

  static Future<void> open(BuildContext context, String title, String url) =>
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => WebPageScreen(title: title, url: url),
        ),
      );

  @override
  State<WebPageScreen> createState() => _WebPageScreenState();
}

class _WebPageScreenState extends State<WebPageScreen> {
  late final WebViewController _controller;
  bool _loading = true;
  bool _failed = false;

  static bool _isEvabob(String url) {
    final host = Uri.tryParse(url)?.host.toLowerCase() ?? '';
    return host == 'evabob.xyz' || host == 'www.evabob.xyz';
  }

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.disabled)
      ..setBackgroundColor(EvabobColors.pageBg)
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) => _isEvabob(request.url)
              ? NavigationDecision.navigate
              : NavigationDecision.prevent,
          onPageFinished: (_) {
            if (mounted) setState(() => _loading = false);
          },
          onWebResourceError: (error) {
            if (error.isForMainFrame == false) return;
            if (mounted) {
              setState(() {
                _loading = false;
                _failed = true;
              });
            }
          },
        ),
      )
      ..loadRequest(Uri.parse(widget.url));
  }

  void _retry() {
    setState(() {
      _failed = false;
      _loading = true;
    });
    _controller.loadRequest(Uri.parse(widget.url));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: EvabobPageHeader(
                title: widget.title,
                onBack: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: _failed
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(Space.lg),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              'This page could not be opened. Check your '
                              'connection and try again.',
                              textAlign: TextAlign.center,
                              style: Type.body
                                  .copyWith(color: EvabobColors.navyMuted),
                            ),
                            const SizedBox(height: Space.md),
                            FilledButton(
                              onPressed: _retry,
                              child: const Text('Try again'),
                            ),
                          ],
                        ),
                      ),
                    )
                  : Stack(
                      children: [
                        WebViewWidget(controller: _controller),
                        if (_loading)
                          const Center(child: CircularProgressIndicator()),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
