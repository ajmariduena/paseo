import ExpoModulesCore
import Foundation

private let transcribeTimeout: TimeInterval = 10

public class PaseoSpeechModule: Module {
  private let workQueue = DispatchQueue(label: "sh.paseo.speech", qos: .userInitiated)
  // Renderers and transcribers deliver results asynchronously; they must live until then.
  private var renderers: [UUID: SystemVoiceRenderer] = [:]
  private var transcribers: [UUID: OnDeviceTranscriber] = [:]
  private let speaker = SpeakerPreference()

  public func definition() -> ModuleDefinition {
    Name("PaseoSpeech")

    Function("setPreferSpeaker") { (enabled: Bool) in
      DispatchQueue.main.async {
        self.speaker.setEnabled(enabled)
      }
    }

    AsyncFunction("transcribe") {
      (pcmBase64: String, sampleRate: Double, locale: String, promise: Promise) in
      guard let clip = try? PaseoSpeechKit.pcmClip(fromBase64: pcmBase64, sampleRate: sampleRate)
      else {
        promise.resolve(nil)
        return
      }
      OnDeviceTranscriber.authorize { authorized in
        DispatchQueue.main.async {
          guard authorized else {
            promise.resolve(nil)
            return
          }
          let id = UUID()
          let transcriber = OnDeviceTranscriber()
          self.transcribers[id] = transcriber
          transcriber.transcribe(clip: clip, locale: locale, timeout: transcribeTimeout) { text in
            DispatchQueue.main.async {
              self.transcribers.removeValue(forKey: id)
              promise.resolve(text)
            }
          }
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("encodeAac") { (pcmBase64: String, sampleRate: Double, promise: Promise) in
      self.workQueue.async {
        do {
          let clip = try PaseoSpeechKit.pcmClip(fromBase64: pcmBase64, sampleRate: sampleRate)
          let data = try PaseoSpeechKit.encodeAac(clip)
          promise.resolve(["base64": data.base64EncodedString(), "mimeType": "audio/mp4"])
        } catch {
          promise.reject("ERR_ENCODE", "Could not compress the recording: \(error)")
        }
      }
    }

    AsyncFunction("decode") { (base64: String, mimeType: String, promise: Promise) in
      self.workQueue.async {
        guard let data = Data(base64Encoded: base64) else {
          promise.reject("ERR_DECODE", "Invalid audio data")
          return
        }
        do {
          let clip = try PaseoSpeechKit.decode(
            data: data, fileExtension: Self.fileExtension(for: mimeType))
          promise.resolve([
            "pcmBase64": clip.data.base64EncodedString(), "sampleRate": clip.sampleRate,
          ])
        } catch {
          promise.reject("ERR_DECODE", "Could not decode the reply audio: \(error)")
        }
      }
    }

    AsyncFunction("synthesize") { (text: String, language: String, promise: Promise) in
      let id = UUID()
      let renderer = SystemVoiceRenderer()
      self.renderers[id] = renderer
      renderer.render(text: text, language: language) { clip in
        DispatchQueue.main.async {
          self.renderers.removeValue(forKey: id)
          promise.resolve([
            "pcmBase64": clip.data.base64EncodedString(), "sampleRate": clip.sampleRate,
          ])
        }
      }
    }.runOnQueue(.main)
  }

  private static func fileExtension(for mimeType: String) -> String {
    let lower = mimeType.lowercased()
    if lower.contains("mpeg") || lower.contains("mp3") { return "mp3" }
    if lower.contains("mp4") || lower.contains("m4a") || lower.contains("aac") { return "m4a" }
    if lower.contains("wav") { return "wav" }
    return "mp3"
  }
}
