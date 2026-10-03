import AVFoundation
import Foundation
import Speech

struct PcmClip {
  let samples: [Int16]
  let sampleRate: Double

  var data: Data {
    samples.withUnsafeBufferPointer { Data(buffer: $0) }
  }
}

enum PaseoSpeechError: Error {
  case invalidAudio
  case encoderUnavailable
}

enum PaseoSpeechKit {
  static func pcmClip(fromBase64 base64: String, sampleRate: Double) throws -> PcmClip {
    guard let data = Data(base64Encoded: base64), data.count >= 2 else {
      throw PaseoSpeechError.invalidAudio
    }
    let samples = data.withUnsafeBytes { raw -> [Int16] in
      Array(raw.bindMemory(to: Int16.self))
    }
    return PcmClip(samples: samples, sampleRate: sampleRate)
  }

  static func floatBuffer(from clip: PcmClip) throws -> AVAudioPCMBuffer {
    guard
      let format = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: clip.sampleRate, channels: 1,
        interleaved: false),
      let buffer = AVAudioPCMBuffer(
        pcmFormat: format, frameCapacity: AVAudioFrameCount(clip.samples.count)),
      let channel = buffer.floatChannelData?[0]
    else {
      throw PaseoSpeechError.invalidAudio
    }
    buffer.frameLength = AVAudioFrameCount(clip.samples.count)
    for index in 0..<clip.samples.count {
      channel[index] = Float(clip.samples[index]) / Float(Int16.max)
    }
    return buffer
  }

  /// Mono Int16 samples from any PCM buffer, averaging channels.
  static func int16Samples(from buffer: AVAudioPCMBuffer) -> [Int16] {
    let frames = Int(buffer.frameLength)
    let channels = Int(buffer.format.channelCount)
    guard frames > 0, channels > 0 else { return [] }
    var samples = [Int16](repeating: 0, count: frames)
    if let floats = buffer.floatChannelData {
      for frame in 0..<frames {
        var sum: Float = 0
        for channel in 0..<channels { sum += floats[channel][frame] }
        let value = max(-1, min(1, sum / Float(channels)))
        samples[frame] = Int16(value * Float(Int16.max))
      }
    } else if let ints = buffer.int16ChannelData {
      for frame in 0..<frames {
        var sum = 0
        for channel in 0..<channels { sum += Int(ints[channel][frame]) }
        samples[frame] = Int16(sum / channels)
      }
    }
    return samples
  }

  // MARK: AAC encoding

  /// AAC in an MP4 container, about 3 KB per second of speech at 24 kbps.
  static func encodeAac(_ clip: PcmClip) throws -> Data {
    let buffer = try floatBuffer(from: clip)
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("paseo-utterance-\(UUID().uuidString).m4a")
    defer { try? FileManager.default.removeItem(at: url) }
    var settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: clip.sampleRate,
      AVNumberOfChannelsKey: 1,
      AVEncoderBitRateKey: 24_000,
    ]
    do {
      try writeFile(buffer: buffer, url: url, settings: settings)
    } catch {
      // Some encoder versions reject the bit rate for a sample rate; their default still compresses.
      settings.removeValue(forKey: AVEncoderBitRateKey)
      try? FileManager.default.removeItem(at: url)
      try writeFile(buffer: buffer, url: url, settings: settings)
    }
    let data = try Data(contentsOf: url)
    guard !data.isEmpty else { throw PaseoSpeechError.encoderUnavailable }
    return data
  }

  // The file is finalized when AVAudioFile is released, so it must not outlive this scope.
  private static func writeFile(buffer: AVAudioPCMBuffer, url: URL, settings: [String: Any]) throws
  {
    let file = try AVAudioFile(
      forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    try file.write(from: buffer)
  }

  // MARK: Decoding

  static func decode(data: Data, fileExtension: String) throws -> PcmClip {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("paseo-reply-\(UUID().uuidString).\(fileExtension)")
    defer { try? FileManager.default.removeItem(at: url) }
    try data.write(to: url)
    let file = try AVAudioFile(forReading: url)
    let format = file.processingFormat
    guard
      let buffer = AVAudioPCMBuffer(
        pcmFormat: format, frameCapacity: AVAudioFrameCount(max(file.length, 1)))
    else {
      throw PaseoSpeechError.invalidAudio
    }
    try file.read(into: buffer)
    return PcmClip(samples: int16Samples(from: buffer), sampleRate: format.sampleRate)
  }

  // MARK: System voices

  /// Best installed voice for a language: Latin American Spanish first for `es`, premium over enhanced.
  static func bestVoice(for language: String) -> AVSpeechSynthesisVoice? {
    let base = language.split(separator: "-").first.map(String.init)?.lowercased() ?? language
    let preferredRegions: [String] =
      base == "es" ? ["es-MX", "es-US", "es-419", "es-CO", "es-ES"] : []
    let voices = AVSpeechSynthesisVoice.speechVoices().filter {
      $0.language.lowercased().hasPrefix(base)
    }
    func score(_ voice: AVSpeechSynthesisVoice) -> Int {
      var value = 0
      switch voice.quality {
      case .premium: value += 300
      case .enhanced: value += 200
      default: value += 100
      }
      if voice.language.caseInsensitiveCompare(language) == .orderedSame { value += 50 }
      if let index = preferredRegions.firstIndex(where: {
        $0.caseInsensitiveCompare(voice.language) == .orderedSame
      }) {
        value += 40 - index * 5
      }
      return value
    }
    return voices.max { score($0) < score($1) } ?? AVSpeechSynthesisVoice(language: language)
  }
}

/// Renders an utterance with a system voice to PCM instead of the speaker, so it plays through
/// the call's audio engine (echo cancellation, same route, no session fights).
final class SystemVoiceRenderer {
  private let synthesizer = AVSpeechSynthesizer()
  private var samples: [Int16] = []
  private var sampleRate: Double = 22_050
  private var finished = false

  func render(text: String, language: String, completion: @escaping (PcmClip) -> Void) {
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = PaseoSpeechKit.bestVoice(for: language)
    utterance.rate = AVSpeechUtteranceDefaultSpeechRate
    synthesizer.write(utterance) { [weak self] buffer in
      guard let self, !self.finished else { return }
      guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else {
        self.finished = true
        completion(PcmClip(samples: self.samples, sampleRate: self.sampleRate))
        return
      }
      self.sampleRate = pcm.format.sampleRate
      self.samples.append(contentsOf: PaseoSpeechKit.int16Samples(from: pcm))
    }
  }
}

/// On-device recognition only: the point of this path is to work without a network.
final class OnDeviceTranscriber {
  private var task: SFSpeechRecognitionTask?
  private var recognizer: SFSpeechRecognizer?
  private var done = false

  static func authorize(completion: @escaping (Bool) -> Void) {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized:
      completion(true)
    case .notDetermined:
      SFSpeechRecognizer.requestAuthorization { status in
        completion(status == .authorized)
      }
    default:
      completion(false)
    }
  }

  /// A bare language like `es` has no recognizer; try the device's region, then common ones.
  static func onDeviceRecognizer(for language: String) -> SFSpeechRecognizer? {
    let base = language.split(separator: "-").first.map(String.init)?.lowercased() ?? language
    var candidates = [language]
    let current = Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
    if current.lowercased().hasPrefix(base) { candidates.append(current) }
    if base == "es" { candidates += ["es-US", "es-MX", "es-419", "es-ES"] }
    for identifier in candidates {
      if let recognizer = SFSpeechRecognizer(locale: Locale(identifier: identifier)),
        recognizer.isAvailable, recognizer.supportsOnDeviceRecognition
      {
        return recognizer
      }
    }
    return nil
  }

  func transcribe(
    clip: PcmClip, locale: String, timeout: TimeInterval, completion: @escaping (String?) -> Void
  ) {
    guard let recognizer = Self.onDeviceRecognizer(for: locale),
      let buffer = try? PaseoSpeechKit.floatBuffer(from: clip)
    else {
      completion(nil)
      return
    }
    self.recognizer = recognizer
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false
    request.taskHint = .dictation
    if #available(iOS 16.0, *) {
      request.addsPunctuation = true
    }
    request.append(buffer)
    request.endAudio()

    let finish: (String?) -> Void = { [weak self] text in
      guard let self, !self.done else { return }
      self.done = true
      self.task?.cancel()
      self.task = nil
      completion(text)
    }
    task = recognizer.recognitionTask(with: request) { result, error in
      if let result, result.isFinal {
        let text = result.bestTranscription.formattedString.trimmingCharacters(
          in: .whitespacesAndNewlines)
        finish(text.isEmpty ? nil : text)
      } else if error != nil {
        finish(nil)
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
      finish(nil)
    }
  }
}

/// WebRTC's voice-chat session plays through the earpiece; a hands-free call wants the
/// loudspeaker unless a headset or car is connected, and routes change mid-call.
final class SpeakerPreference {
  private var observer: NSObjectProtocol?

  func setEnabled(_ enabled: Bool) {
    if let observer {
      NotificationCenter.default.removeObserver(observer)
      self.observer = nil
    }
    guard enabled else { return }
    apply()
    observer = NotificationCenter.default.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.apply()
    }
  }

  private func apply() {
    let session = AVAudioSession.sharedInstance()
    let onReceiver = session.currentRoute.outputs.contains { $0.portType == .builtInReceiver }
    if onReceiver {
      try? session.overrideOutputAudioPort(.speaker)
    }
  }
}
