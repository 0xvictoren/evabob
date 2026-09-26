/// Where the Circle PIN document runs in the web-app: an iframe in the page,
/// standing in for the WebView the phones use. See [CircleChallengeScreen].
library;

export 'challenge_frame_stub.dart'
    if (dart.library.js_interop) 'challenge_frame_web.dart';
