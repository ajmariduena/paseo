import AVFoundation
import CallKit
import ExpoModulesCore
import ExpoTwoWayAudio

private let callEndedEventName = "onCallEnded"
private let muteChangedEventName = "onMuteChanged"
private let audioSessionActivatedEventName = "onAudioSessionActivated"
private let audioSessionDeactivatedEventName = "onAudioSessionDeactivated"
private let audioSessionActivationTimeout: TimeInterval = 2

public class PaseoCallModule: Module {
  private var controller: PaseoCallController?

  public func definition() -> ModuleDefinition {
    Name("PaseoCall")

    Events(
      callEndedEventName,
      muteChangedEventName,
      audioSessionActivatedEventName,
      audioSessionDeactivatedEventName
    )

    AsyncFunction("startCall") { (displayName: String, promise: Promise) in
      self.resolveController().startCall(displayName: displayName, promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("endCall") { (promise: Promise) in
      guard let controller = self.controller else {
        promise.resolve()
        return
      }
      controller.endCall(promise: promise)
    }.runOnQueue(.main)

    Function("isCallActive") { () -> Bool in
      return self.controller?.isCallActive ?? false
    }

    OnDestroy {
      let controller = self.controller
      self.controller = nil
      DispatchQueue.main.async {
        controller?.invalidate()
      }
    }
  }

  private func resolveController() -> PaseoCallController {
    if let controller {
      return controller
    }
    let controller = PaseoCallController { [weak self] name, body in
      self?.sendEvent(name, body)
    }
    self.controller = controller
    return controller
  }
}

private struct PendingStart {
  let callUUID: UUID
  let promise: Promise
  let timeout: DispatchWorkItem
}

/// State is confined to the main queue; isCallActive is the only read from another thread.
private final class PaseoCallController: NSObject, CXProviderDelegate {
  private let emit: (String, [String: Any]) -> Void
  private let provider: CXProvider
  private let callController = CXCallController(queue: .main)

  private var activeCallUUID: UUID?
  private var activeDisplayName = ""
  private var callUUIDEndingFromJS: UUID?
  private var pendingStart: PendingStart?
  private var isAudioSessionActive = false

  var isCallActive: Bool {
    activeCallUUID != nil
  }

  init(emit: @escaping (String, [String: Any]) -> Void) {
    self.emit = emit
    let configuration = CXProviderConfiguration()
    configuration.supportsVideo = false
    configuration.maximumCallGroups = 1
    configuration.maximumCallsPerCallGroup = 1
    configuration.supportedHandleTypes = [.generic]
    configuration.includesCallsInRecents = false
    provider = CXProvider(configuration: configuration)
    super.init()
    provider.setDelegate(self, queue: .main)
  }

  func invalidate() {
    rejectPendingStart(code: "ERR_CALL_INVALIDATED", message: "The call provider was torn down")
    activeCallUUID = nil
    callUUIDEndingFromJS = nil
    isAudioSessionActive = false
    provider.invalidate()
    CallKitAudioSessionOwnership.setOwnedByCall(false)
  }

  func startCall(displayName: String, promise: Promise) {
    if activeCallUUID != nil || pendingStart != nil {
      promise.reject("ERR_CALL_ALREADY_ACTIVE", "A call is already in progress")
      return
    }

    let callUUID = UUID()
    let handle = CXHandle(type: .generic, value: displayName)
    let action = CXStartCallAction(call: callUUID, handle: handle)
    action.isVideo = false

    let timeout = DispatchWorkItem { [weak self] in
      self?.resolvePendingStart()
    }
    pendingStart = PendingStart(callUUID: callUUID, promise: promise, timeout: timeout)
    activeDisplayName = displayName

    callController.request(CXTransaction(action: action)) { [weak self] error in
      guard let self else { return }
      if let error {
        guard self.pendingStart?.callUUID == callUUID else { return }
        self.rejectPendingStart(code: "ERR_CALL_START_FAILED", message: error.localizedDescription)
        return
      }
      DispatchQueue.main.asyncAfter(
        deadline: .now() + audioSessionActivationTimeout,
        execute: timeout
      )
    }
  }

  func endCall(promise: Promise) {
    guard let callUUID = activeCallUUID else {
      // The start transaction is still in flight; failing the pending start makes its
      // CXStartCallAction fail when it arrives.
      rejectPendingStart(code: "ERR_CALL_ENDED", message: "The call was ended before it started")
      promise.resolve()
      return
    }
    callUUIDEndingFromJS = callUUID
    callController.request(CXTransaction(action: CXEndCallAction(call: callUUID))) {
      [weak self] error in
      if error != nil, let self, self.activeCallUUID == callUUID {
        // CallKit already forgot the call (e.g. the system tore it down); clean up locally.
        self.finishCall(callUUID, endedBySystem: false)
      }
      promise.resolve()
    }
  }

  // MARK: - CXProviderDelegate

  func providerDidReset(_ provider: CXProvider) {
    let hadCall = activeCallUUID != nil
    let endedFromJS = activeCallUUID != nil && callUUIDEndingFromJS == activeCallUUID
    rejectPendingStart(code: "ERR_CALL_RESET", message: "CallKit reset the call provider")
    activeCallUUID = nil
    callUUIDEndingFromJS = nil
    isAudioSessionActive = false
    CallKitAudioSessionOwnership.setOwnedByCall(false)
    if hadCall && !endedFromJS {
      emit(callEndedEventName, [:])
    }
  }

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    guard pendingStart?.callUUID == action.callUUID else {
      action.fail()
      return
    }

    // CallKit activates the session itself at elevated priority; the app only configures it here
    // and must not call setActive(true) before provider(_:didActivate:).
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
      )
    } catch {
      print("[PaseoCall] Could not configure the audio session: \(error.localizedDescription)")
    }

    activeCallUUID = action.callUUID
    CallKitAudioSessionOwnership.setOwnedByCall(true)

    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
    action.fulfill()
    provider.reportOutgoingCall(with: action.callUUID, connectedAt: nil)

    let update = CXCallUpdate()
    update.remoteHandle = action.handle
    update.localizedCallerName = activeDisplayName
    update.hasVideo = false
    // Without hold support iOS offers "End & Accept" for an incoming phone call, which ends this
    // call cleanly instead of leaving the voice engine stalled on a held call.
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    provider.reportCall(with: action.callUUID, updated: update)
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    guard action.callUUID == activeCallUUID else {
      action.fulfill()
      return
    }
    let endedBySystem = callUUIDEndingFromJS != action.callUUID
    action.fulfill()
    finishCall(action.callUUID, endedBySystem: endedBySystem)
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    guard action.callUUID == activeCallUUID else {
      action.fail()
      return
    }
    action.fulfill()
    emit(muteChangedEventName, ["muted": action.isMuted])
  }

  func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    if action.isOnHold {
      action.fail()
    } else {
      action.fulfill()
    }
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    isAudioSessionActive = true
    emit(audioSessionActivatedEventName, [:])
    resolvePendingStart()
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    isAudioSessionActive = false
    emit(audioSessionDeactivatedEventName, [:])
    if activeCallUUID == nil {
      CallKitAudioSessionOwnership.setOwnedByCall(false)
    }
  }

  // MARK: - Helpers

  private func finishCall(_ callUUID: UUID, endedBySystem: Bool) {
    guard activeCallUUID == callUUID else { return }
    activeCallUUID = nil
    callUUIDEndingFromJS = nil
    if pendingStart?.callUUID == callUUID {
      rejectPendingStart(code: "ERR_CALL_ENDED", message: "The call ended before audio was ready")
    }
    // didDeactivate releases ownership once CallKit hands the session back; if CallKit never
    // activated it there is no deactivation coming.
    if !isAudioSessionActive {
      CallKitAudioSessionOwnership.setOwnedByCall(false)
    }
    if endedBySystem {
      emit(callEndedEventName, [:])
    }
  }

  private func resolvePendingStart() {
    guard let pending = pendingStart else { return }
    pendingStart = nil
    pending.timeout.cancel()
    pending.promise.resolve()
  }

  private func rejectPendingStart(code: String, message: String) {
    guard let pending = pendingStart else { return }
    pendingStart = nil
    pending.timeout.cancel()
    pending.promise.reject(code, message)
  }
}
