import Flutter
import UIKit
#if canImport(CircleProgrammableWalletSDK)
import CircleProgrammableWalletSDK
#endif

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "CircleSdkBridge") {
      CircleSdkBridge.register(messenger: registrar.messenger())
    }
  }
}

/// Circle's native wallet SDK, for confirming with Face ID instead of the PIN.
///
/// The web SDK the app otherwise uses for PINs has no biometrics; Circle
/// offers them only in its native SDKs. Compiled in only when the
/// CircleProgrammableWalletSDK pod is installed (see docs/BIOMETRICS.md);
/// otherwise it tells the app it is absent and the PIN is used.
enum CircleSdkBridge {
  static let endpoint = "https://api.circle.com/v1/w3s/"
  static var initialisedFor: String?

  static func register(messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "evabob/circle_sdk", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      #if canImport(CircleProgrammableWalletSDK)
      let args = call.arguments as? [String: Any] ?? [:]
      let appId = args["appId"] as? String ?? ""
      let userToken = args["userToken"] as? String ?? ""
      let encryptionKey = args["encryptionKey"] as? String ?? ""
      switch call.method {
      case "available":
        result(true)
      case "setBiometricsPin":
        ensureInit(appId: appId)
        WalletSdk.shared.setBiometricsPin(userToken: userToken, encryptionKey: encryptionKey) { response in
          result(outcome(response.result))
        }
      case "execute":
        ensureInit(appId: appId)
        let ids = args["challengeIds"] as? [String] ?? []
        WalletSdk.shared.execute(userToken: userToken, encryptionKey: encryptionKey, challengeIds: ids) { response in
          result(outcome(response.result))
        }
      default:
        result(FlutterMethodNotImplemented)
      }
      #else
      if call.method == "available" {
        result(false)
      } else {
        result(["ok": false, "error": "Face ID confirmation is not in this build."])
      }
      #endif
    }
  }

  #if canImport(CircleProgrammableWalletSDK)
  static func ensureInit(appId: String) {
    guard !appId.isEmpty, initialisedFor != appId else { return }
    let configuration = WalletSdk.Configuration(
      endPoint: endpoint,
      appId: appId,
      settingsManagement: .init(enableBiometricsPin: true)
    )
    do {
      try WalletSdk.shared.setConfiguration(configuration)
      initialisedFor = appId
    } catch {
      initialisedFor = nil
    }
  }

  static func signature(in value: Any) -> String? {
    func unwrap(_ any: Any) -> Any? {
      let m = Mirror(reflecting: any)
      if m.displayStyle == .optional { return m.children.first?.value }
      return any
    }
    guard let data = Mirror(reflecting: value).descendant("data").flatMap(unwrap) else { return nil }
    guard let sig = Mirror(reflecting: data).descendant("signature").flatMap(unwrap) else { return nil }
    return sig as? String
  }

  static func outcome<T, E: Error>(_ r: Result<T, E>) -> [String: Any] {
    switch r {
    case .success(let value):
      // Signing steps hand their signature back to the server, as the web PIN
      // screen does. Read by reflection so it compiles across SDK versions.
      var out: [String: Any] = ["ok": true]
      if let sig = signature(in: value) { out["signature"] = sig }
      return out
    case .failure(let error):
      let text = String(describing: error)
      return [
        "ok": false,
        "canceled": text.lowercased().contains("cancel"),
        "error": text,
      ]
    }
  }
  #endif
}
