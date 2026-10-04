import ActivityKit
import ExpoModulesCore
import Foundation

// ActivityKit matches activities by this type's name and Codable shape: it must stay identical to
// PaseoAgentsAttributes in targets/live-activity/PaseoAgentsLiveActivity.swift, and the
// ContentState field names are the JSON keys the JS side and daemon pushes send.
struct PaseoAgentsAttributes: ActivityAttributes {
  public struct Line: Codable, Hashable {
    var id: String
    var title: String
    var subtitle: String?
    var state: String
    var label: String
    var since: Double
    var url: String?
  }

  public struct Chip: Codable, Hashable {
    var state: String
    var count: Int
    var text: String
    var short: String
  }

  public struct ContentState: Codable, Hashable {
    var headline: String
    var working: Int
    var waiting: Int
    var workingLabel: String
    var waitingLabel: String
    var lines: [Line]
    // Optional so activities started by an older JS bundle still decode.
    var chips: [Chip]?
    var updatedAt: Double?
  }

  var title: String
}

public class PaseoLiveActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoLiveActivity")

    Function("isEnabled") { () -> Bool in
      if #available(iOS 16.2, *) {
        return ActivityAuthorizationInfo().areActivitiesEnabled
      }
      return false
    }

    Function("isRunning") { () -> Bool in
      if #available(iOS 16.2, *) {
        return !Activity<PaseoAgentsAttributes>.activities.isEmpty
      }
      return false
    }

    AsyncFunction("start") { (title: String, stateJson: String, staleAfter: Double) async throws in
      guard #available(iOS 16.2, *) else { return }
      let content = ActivityContent(
        state: try decodeState(stateJson),
        staleDate: Date().addingTimeInterval(staleAfter)
      )
      for activity in Activity<PaseoAgentsAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      _ = try Activity.request(attributes: PaseoAgentsAttributes(title: title), content: content)
    }

    AsyncFunction("update") { (stateJson: String, staleAfter: Double) async throws in
      guard #available(iOS 16.2, *) else { return }
      let content = ActivityContent(
        state: try decodeState(stateJson),
        staleDate: Date().addingTimeInterval(staleAfter)
      )
      for activity in Activity<PaseoAgentsAttributes>.activities {
        await activity.update(content)
      }
    }

    AsyncFunction("end") { (stateJson: String, dismissAfter: Double) async throws in
      guard #available(iOS 16.2, *) else { return }
      let content =
        stateJson.isEmpty ? nil : ActivityContent(state: try decodeState(stateJson), staleDate: nil)
      let policy: ActivityUIDismissalPolicy =
        dismissAfter > 0 ? .after(Date().addingTimeInterval(dismissAfter)) : .immediate
      for activity in Activity<PaseoAgentsAttributes>.activities {
        await activity.end(content, dismissalPolicy: policy)
      }
    }
  }
}

private func decodeState(_ json: String) throws -> PaseoAgentsAttributes.ContentState {
  try JSONDecoder().decode(PaseoAgentsAttributes.ContentState.self, from: Data(json.utf8))
}
