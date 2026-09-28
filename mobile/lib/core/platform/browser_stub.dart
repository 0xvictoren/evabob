import 'dart:typed_data';

/// Phone builds: none of these are called (callers check `kIsWeb`).
class Browser {
  Browser._();

  static String? sessionGet(String key) => null;

  static void sessionSet(String key, String value) {}

  static void sessionRemove(String key) {}

  static void download(Uint8List bytes, String fileName, String mimeType) =>
      throw UnsupportedError('Browser downloads exist only in the web-app');

  static void log(String message) {}

  static void openTab(String url) =>
      throw UnsupportedError('Browser tabs exist only in the web-app');
}
