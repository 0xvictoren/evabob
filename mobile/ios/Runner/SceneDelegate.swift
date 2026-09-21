import Flutter
import UIKit

class SceneDelegate: FlutterSceneDelegate {
    private var privacyCover: UIView?
    private var observingCapture = false

    override func sceneDidBecomeActive(_ scene: UIScene) {
        super.sceneDidBecomeActive(scene)
        if !observingCapture {
            observingCapture = true
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(captureStateChanged),
                name: UIScreen.capturedDidChangeNotification,
                object: nil
            )
        }
        setPrivacyCover(visible: UIScreen.main.isCaptured)
    }

    override func sceneWillResignActive(_ scene: UIScene) {
        setPrivacyCover(visible: true)
        super.sceneWillResignActive(scene)
    }

    @objc private func captureStateChanged() {
        setPrivacyCover(visible: UIScreen.main.isCaptured)
    }

    private func setPrivacyCover(visible: Bool) {
        guard let window = window else { return }
        if visible {
            guard privacyCover == nil else { return }
            let cover = UIView(frame: window.bounds)
            cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            cover.backgroundColor = UIColor.systemBackground
            let lock = UIImageView(image: UIImage(systemName: "lock.shield.fill"))
            lock.tintColor = UIColor.secondaryLabel
            lock.contentMode = .scaleAspectFit
            lock.frame = CGRect(
                x: (cover.bounds.width - 48) / 2,
                y: (cover.bounds.height - 48) / 2,
                width: 48,
                height: 48
            )
            lock.autoresizingMask = [
                .flexibleLeftMargin,
                .flexibleRightMargin,
                .flexibleTopMargin,
                .flexibleBottomMargin,
            ]
            cover.addSubview(lock)
            window.addSubview(cover)
            privacyCover = cover
        } else {
            privacyCover?.removeFromSuperview()
            privacyCover = nil
        }
    }
}
