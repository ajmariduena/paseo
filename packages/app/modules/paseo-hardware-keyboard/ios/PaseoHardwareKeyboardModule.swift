import ExpoModulesCore
import GameController
import UIKit

private let hardwareSubmitEventName = "onHardwareKeyboardSubmit"
private let keyCommandEventName = "onHardwareKeyCommand"
private let keyboardConnectionEventName = "onHardwareKeyboardConnectionChange"

private weak var activeModule: PaseoHardwareKeyboardModule?
private weak var activeRootViewController: PaseoHardwareKeyboardRootViewController?
private var isHardwareSubmitEnabled = false
private var registeredKeyCommands: [RegisteredKeyCommand] = []
private var hasObservedKeyCommand = false

struct PaseoKeyCommandSpec: Record {
  @Field var id: String = ""
  @Field var input: String = ""
  @Field var modifiers: [String] = []
  @Field var title: String? = nil
  @Field var inTextInput: Bool = false
  @Field var outsideTextInput: Bool = false
}

private struct KeyCommandDefinition {
  let id: String
  let input: String
  let modifierFlags: UIKeyModifierFlags
  let title: String?
  let inTextInput: Bool
  let outsideTextInput: Bool

  init?(spec: PaseoKeyCommandSpec) {
    guard let input = keyCommandInput(for: spec.input) else {
      return nil
    }
    self.id = spec.id
    self.input = input
    self.modifierFlags = keyModifierFlags(for: spec.modifiers)
    self.title = spec.title
    self.inTextInput = spec.inTextInput
    self.outsideTextInput = spec.outsideTextInput
  }
}

private struct RegisteredKeyCommand {
  let id: String
  let command: UIKeyCommand
  let inTextInput: Bool
  let outsideTextInput: Bool
}

private func keyCommandInput(for key: String) -> String? {
  switch key {
  case "ArrowUp": return UIKeyCommand.inputUpArrow
  case "ArrowDown": return UIKeyCommand.inputDownArrow
  case "ArrowLeft": return UIKeyCommand.inputLeftArrow
  case "ArrowRight": return UIKeyCommand.inputRightArrow
  case "Escape": return UIKeyCommand.inputEscape
  case "PageUp": return UIKeyCommand.inputPageUp
  case "PageDown": return UIKeyCommand.inputPageDown
  case "Home": return UIKeyCommand.inputHome
  case "End": return UIKeyCommand.inputEnd
  case "Tab": return "\t"
  case "Enter": return "\r"
  case "Backspace": return "\u{8}"
  case "Space": return " "
  default: return key.count == 1 ? key : nil
  }
}

private func keyModifierFlags(for modifiers: [String]) -> UIKeyModifierFlags {
  var flags: UIKeyModifierFlags = []
  for modifier in modifiers {
    switch modifier {
    case "command": flags.insert(.command)
    case "control": flags.insert(.control)
    case "alternate": flags.insert(.alternate)
    case "shift": flags.insert(.shift)
    default: break
    }
  }
  return flags
}

private func currentHardwareKeyboardConnected() -> Bool {
  if hasObservedKeyCommand {
    return true
  }
  if #available(iOS 14.0, *) {
    return GCKeyboard.coalesced != nil
  }
  return false
}

@objc
public class PaseoHardwareKeyboardReactDelegateHandler: ExpoReactDelegateHandler {
  public override func createRootViewController() -> UIViewController? {
    return PaseoHardwareKeyboardRootViewController()
  }
}

public class PaseoHardwareKeyboardModule: Module {
  private var keyboardObservers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("PaseoHardwareKeyboard")

    Events(hardwareSubmitEventName, keyCommandEventName, keyboardConnectionEventName)

    OnCreate {
      activeModule = self
      self.observeKeyboardConnection()
    }

    Function("setHardwareKeyboardSubmitEnabled") { (enabled: Bool) in
      DispatchQueue.main.async {
        isHardwareSubmitEnabled = enabled
      }
    }

    Function("setKeyCommands") { (specs: [PaseoKeyCommandSpec]) in
      let definitions = specs.compactMap(KeyCommandDefinition.init(spec:))
      DispatchQueue.main.async {
        registeredKeyCommands = definitions.map(makeRegisteredKeyCommand)
        activeRootViewController?.claimKeyCommandsIfIdle()
      }
    }

    Function("isHardwareKeyboardConnected") { () -> Bool in
      return currentHardwareKeyboardConnected()
    }

    OnDestroy {
      if activeModule === self {
        activeModule = nil
      }
      for observer in self.keyboardObservers {
        NotificationCenter.default.removeObserver(observer)
      }
      self.keyboardObservers = []
      isHardwareSubmitEnabled = false
      DispatchQueue.main.async {
        registeredKeyCommands = []
      }
    }
  }

  fileprivate func emitHardwareKeyboardSubmit() {
    sendEvent(hardwareSubmitEventName, [:])
  }

  fileprivate func emitKeyCommand(id: String, textInputFocused: Bool) {
    if !hasObservedKeyCommand {
      hasObservedKeyCommand = true
      emitKeyboardConnection(true)
    }
    sendEvent(keyCommandEventName, ["id": id, "textInputFocused": textInputFocused])
  }

  private func emitKeyboardConnection(_ connected: Bool) {
    sendEvent(keyboardConnectionEventName, ["connected": connected])
  }

  private func observeKeyboardConnection() {
    guard #available(iOS 14.0, *) else {
      return
    }
    let center = NotificationCenter.default
    keyboardObservers = [
      center.addObserver(forName: .GCKeyboardDidConnect, object: nil, queue: .main) {
        [weak self] _ in
        self?.emitKeyboardConnection(true)
      },
      center.addObserver(forName: .GCKeyboardDidDisconnect, object: nil, queue: .main) {
        [weak self] _ in
        hasObservedKeyCommand = false
        self?.emitKeyboardConnection(currentHardwareKeyboardConnected())
      },
    ]
  }
}

private func makeRegisteredKeyCommand(_ definition: KeyCommandDefinition) -> RegisteredKeyCommand {
  let command = UIKeyCommand(
    input: definition.input,
    modifierFlags: definition.modifierFlags,
    action: #selector(PaseoHardwareKeyboardRootViewController.handleRegisteredKeyCommand(_:))
  )
  if let title = definition.title {
    command.title = title
    command.discoverabilityTitle = title
  }
  if #available(iOS 15.0, *) {
    command.wantsPriorityOverSystemBehavior = true
  }
  return RegisteredKeyCommand(
    id: definition.id,
    command: command,
    inTextInput: definition.inTextInput,
    outsideTextInput: definition.outsideTextInput
  )
}

private final class PaseoHardwareKeyboardRootViewController: UIViewController {
  private static let submitCommand: UIKeyCommand = {
    let command = UIKeyCommand(
      input: "\r",
      modifierFlags: [],
      action: #selector(handleHardwareKeyboardSubmit(_:))
    )
    if #available(iOS 15.0, *) {
      command.wantsPriorityOverSystemBehavior = true
    }
    return command
  }()

  private var isPad: Bool {
    UIDevice.current.userInterfaceIdiom == .pad
  }

  // With no text field focused there is no first responder, and UIKit only
  // looks for key commands along the first responder's chain. The root view
  // controller holds that slot so global shortcuts keep working.
  override var canBecomeFirstResponder: Bool {
    isPad && !registeredKeyCommands.isEmpty
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    activeRootViewController = self
    let center = NotificationCenter.default
    let reclaimNotifications: [Notification.Name] = [
      UITextView.textDidEndEditingNotification,
      UITextField.textDidEndEditingNotification,
      UIApplication.didBecomeActiveNotification,
    ]
    for name in reclaimNotifications {
      center.addObserver(
        self,
        selector: #selector(claimKeyCommandsIfIdle),
        name: name,
        object: nil
      )
    }
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    claimKeyCommandsIfIdle()
  }

  override var keyCommands: [UIKeyCommand]? {
    guard isPad else {
      return super.keyCommands
    }
    var commands = super.keyCommands ?? []
    if isHardwareSubmitEnabled {
      commands.append(Self.submitCommand)
    }
    let textInput = UIResponder.paseoCurrentFirstResponder as? UITextInput
    if textInput?.markedTextRange != nil {
      return commands
    }
    let isTextInputFocused = textInput != nil
    for registered in registeredKeyCommands {
      let isAllowed = isTextInputFocused ? registered.inTextInput : registered.outsideTextInput
      if isAllowed {
        commands.append(registered.command)
      }
    }
    return commands
  }

  @objc
  func claimKeyCommandsIfIdle() {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.canBecomeFirstResponder, !self.isFirstResponder else {
        return
      }
      guard let window = self.viewIfLoaded?.window, window.paseoFirstResponderView == nil else {
        return
      }
      self.becomeFirstResponder()
    }
  }

  @objc
  func handleRegisteredKeyCommand(_ sender: UIKeyCommand) {
    guard let registered = registeredKeyCommands.first(where: {
      $0.command.input == sender.input && $0.command.modifierFlags == sender.modifierFlags
    }) else {
      return
    }
    let isTextInputFocused = UIResponder.paseoCurrentFirstResponder is UITextInput
    activeModule?.emitKeyCommand(id: registered.id, textInputFocused: isTextInputFocused)
  }

  @objc
  private func handleHardwareKeyboardSubmit(_ sender: UIKeyCommand) {
    guard canSubmitCurrentTextInput() else {
      return
    }
    activeModule?.emitHardwareKeyboardSubmit()
  }

  private func canSubmitCurrentTextInput() -> Bool {
    guard let responder = UIResponder.paseoCurrentFirstResponder else {
      return false
    }
    guard let textInput = responder as? UITextInput else {
      return false
    }
    return textInput.markedTextRange == nil
  }
}

private extension UIView {
  var paseoFirstResponderView: UIView? {
    if isFirstResponder {
      return self
    }
    for subview in subviews {
      if let responder = subview.paseoFirstResponderView {
        return responder
      }
    }
    return nil
  }
}

private extension UIResponder {
  private static weak var currentFirstResponder: UIResponder?

  static var paseoCurrentFirstResponder: UIResponder? {
    currentFirstResponder = nil
    UIApplication.shared.sendAction(
      #selector(captureCurrentFirstResponder(_:)),
      to: nil,
      from: nil,
      for: nil
    )
    return currentFirstResponder
  }

  @objc
  private func captureCurrentFirstResponder(_ sender: Any?) {
    UIResponder.currentFirstResponder = self
  }
}
