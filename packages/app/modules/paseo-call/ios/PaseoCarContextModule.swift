import AVFoundation
import AVKit
import CoreMotion
import ExpoModulesCore

private let audioRouteChangedEventName = "onAudioRouteChanged"
private let motionActivityEventName = "onMotionActivity"
private let carModeChangedEventName = "onCarModeChanged"

/// Car signals for the voice call's On the go mode. State is confined to the main queue.
public class PaseoCarContextModule: Module {
  private let activityManager = CMMotionActivityManager()
  private var routeObserver: NSObjectProtocol?
  private var isObservingMotion = false

  public func definition() -> ModuleDefinition {
    Name("PaseoCarContext")

    Events(audioRouteChangedEventName, motionActivityEventName, carModeChangedEventName)

    Function("getAudioRoute") { () -> [String: Any] in
      return Self.describeRoute()
    }

    // iOS has no system car mode; CarPlay shows up as the carAudio route instead.
    Function("getCarMode") { () -> Bool in
      return false
    }

    Function("getMotionAuthorization") { () -> String in
      return Self.motionAuthorization()
    }

    AsyncFunction("requestMotionAuthorization") { (promise: Promise) in
      guard CMMotionActivityManager.isActivityAvailable() else {
        promise.resolve("unavailable")
        return
      }
      guard CMMotionActivityManager.authorizationStatus() == .notDetermined else {
        promise.resolve(Self.motionAuthorization())
        return
      }
      // Core Motion has no explicit request API; the first query raises the system prompt and
      // its handler runs once the user has answered.
      let now = Date()
      self.activityManager.queryActivityStarting(
        from: now.addingTimeInterval(-60), to: now, to: .main
      ) { _, _ in
        promise.resolve(Self.motionAuthorization())
      }
    }.runOnQueue(.main)

    // AVKit has no API to open the route picker; tapping the button of an AVRoutePickerView is
    // the supported way, so a throwaway picker is attached to the window and tapped once.
    AsyncFunction("showAudioRoutePicker") {
      let window = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .flatMap { $0.windows }
        .first { $0.isKeyWindow }
      guard let window else { return }
      let picker = AVRoutePickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
      picker.prioritizesVideoDevices = false
      picker.alpha = 0.011
      window.addSubview(picker)
      picker.subviews.compactMap { $0 as? UIButton }.first?.sendActions(for: .touchUpInside)
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
        picker.removeFromSuperview()
      }
    }.runOnQueue(.main)

    AsyncFunction("startObserving") { (motion: Bool) in
      self.startObserving(motion: motion)
    }.runOnQueue(.main)

    Function("stopObserving") {
      DispatchQueue.main.async {
        self.stopObserving()
      }
    }

    OnDestroy {
      DispatchQueue.main.async {
        self.stopObserving()
      }
    }
  }

  private func startObserving(motion: Bool) {
    stopObserving()
    routeObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.sendEvent(audioRouteChangedEventName, Self.describeRoute())
    }
    guard motion,
      CMMotionActivityManager.isActivityAvailable(),
      CMMotionActivityManager.authorizationStatus() == .authorized
    else { return }
    isObservingMotion = true
    activityManager.startActivityUpdates(to: .main) { [weak self] activity in
      guard let self, let activity else { return }
      self.sendEvent(motionActivityEventName, Self.describe(activity))
    }
  }

  private func stopObserving() {
    if let routeObserver {
      NotificationCenter.default.removeObserver(routeObserver)
      self.routeObserver = nil
    }
    if isObservingMotion {
      activityManager.stopActivityUpdates()
      isObservingMotion = false
    }
  }

  private static func describeRoute() -> [String: Any] {
    let outputs = AVAudioSession.sharedInstance().currentRoute.outputs.map { port in
      ["portType": normalize(port.portType), "uid": port.uid, "name": port.portName]
    }
    return ["outputs": outputs]
  }

  /// Matches the names the JS detector and the Android module use.
  private static func normalize(_ portType: AVAudioSession.Port) -> String {
    switch portType {
    case .carAudio: return "carAudio"
    case .bluetoothHFP: return "bluetoothHFP"
    case .bluetoothA2DP: return "bluetoothA2DP"
    case .bluetoothLE: return "bluetoothLE"
    case .builtInSpeaker: return "builtInSpeaker"
    case .builtInReceiver: return "builtInReceiver"
    case .headphones: return "headphones"
    default: return portType.rawValue
    }
  }

  private static func describe(_ activity: CMMotionActivity) -> [String: Any] {
    let confidence: String
    switch activity.confidence {
    case .high: confidence = "high"
    case .medium: confidence = "medium"
    default: confidence = "low"
    }
    return [
      "automotive": activity.automotive,
      "stationary": activity.stationary,
      "walking": activity.walking || activity.running,
      "confidence": confidence,
      "startedAt": activity.startDate.timeIntervalSince1970 * 1000,
    ]
  }

  private static func motionAuthorization() -> String {
    guard CMMotionActivityManager.isActivityAvailable() else { return "unavailable" }
    switch CMMotionActivityManager.authorizationStatus() {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "authorized"
    @unknown default: return "unavailable"
    }
  }
}
