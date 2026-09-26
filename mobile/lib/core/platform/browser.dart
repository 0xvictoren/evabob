/// Browser-only helpers for the web-app build (`web-app/`).
///
/// Android and iOS get the stub, which is never reached: every caller checks
/// `kIsWeb` first. Keeping the browser code behind a conditional import means
/// the phone builds never compile `package:web`.
library;

export 'browser_stub.dart' if (dart.library.js_interop) 'browser_web.dart';
