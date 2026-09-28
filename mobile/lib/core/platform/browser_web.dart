import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

/// Browser APIs used by the web-app build.
class Browser {
  Browser._();

  /// `sessionStorage` lives only as long as the tab: closing it signs the
  /// person out, which is what the web-app wants for a money app.
  static String? sessionGet(String key) {
    try {
      return web.window.sessionStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  static void sessionSet(String key, String value) {
    try {
      web.window.sessionStorage.setItem(key, value);
    } catch (_) {}
  }

  static void sessionRemove(String key) {
    try {
      web.window.sessionStorage.removeItem(key);
    } catch (_) {}
  }

  /// Hands [bytes] to the browser as a file download.
  static void download(Uint8List bytes, String fileName, String mimeType) {
    final blob = web.Blob(
      [bytes.toJS].toJS,
      web.BlobPropertyBag(type: mimeType),
    );
    final url = web.URL.createObjectURL(blob);
    final a = web.document.createElement('a') as web.HTMLAnchorElement
      ..href = url
      ..download = fileName
      ..style.display = 'none';
    web.document.body?.append(a);
    a.click();
    a.remove();
    // Give the browser a moment to start the download before revoking.
    Future<void>.delayed(const Duration(seconds: 5), () {
      web.URL.revokeObjectURL(url);
    });
  }

  /// A line in the browser console, so sign-in steps can be read in the
  /// page's DevTools.
  static void log(String message) {
    web.console.info(message.toJS);
  }

  /// Opens [url] in a new tab, without giving it a handle back to this one.
  static void openTab(String url) {
    web.window.open(url, '_blank', 'noopener,noreferrer');
  }
}
