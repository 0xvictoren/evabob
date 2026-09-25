import Flutter
import UIKit

/// Hides the app behind a plain cover in the app switcher, where its last
/// screen would otherwise be left on show.
///
/// Screenshots, screen recording and mirroring are allowed, as on Android:
/// people share receipts and show the app in presentations. (The cover used
/// to go up whenever the screen was captured, which blanked the app when it
/// was mirrored to a projector.)
class SceneDelegate: FlutterSceneDelegate {
    private var privacyCover: UIView?

    override func sceneDidBecomeActive(_ scene: UIScene) {
        super.sceneDidBecomeActive(scene)
        setPrivacyCover(visible: false)
    }

    override func sceneWillResignActive(_ scene: UIScene) {
        setPrivacyCover(visible: true)
        super.sceneWillResignActive(scene)
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
