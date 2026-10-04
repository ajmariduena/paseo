import ActivityKit
import SwiftUI
import WidgetKit

// Must stay identical to PaseoAgentsAttributes in modules/paseo-live-activity.
struct PaseoAgentsAttributes: ActivityAttributes {
  public struct Line: Codable, Hashable {
    var id: String
    var title: String
    var subtitle: String?
    var state: String
    var label: String
    var since: Double
  }

  public struct ContentState: Codable, Hashable {
    var headline: String
    var working: Int
    var waiting: Int
    var workingLabel: String
    var waitingLabel: String
    var lines: [Line]
  }

  var title: String
}

private enum Palette {
  static let surface = Color(red: 0.094, green: 0.106, blue: 0.102)
  static let muted = Color(red: 0.631, green: 0.647, blue: 0.643)
  static let track = Color(red: 0.263, green: 0.275, blue: 0.271)
  static let accent = Color(red: 0.486, green: 0.796, blue: 0.627)
  static let brand = Color(red: 0.125, green: 0.455, blue: 0.290)
  static let warning = Color(red: 0.878, green: 0.639, blue: 0.227)
  static let danger = Color(red: 0.776, green: 0.310, blue: 0.263)
}

private struct StateMark: View {
  let state: String

  var body: some View {
    switch state {
    case "working":
      Circle()
        .trim(from: 0, to: 0.7)
        .stroke(Palette.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round))
        .frame(width: 9, height: 9)
    case "permission":
      Circle().fill(Palette.warning).frame(width: 9, height: 9)
    case "error":
      Circle().fill(Palette.danger).frame(width: 9, height: 9)
    default:
      Circle().fill(Palette.accent).frame(width: 9, height: 9)
    }
  }
}

private struct LineRow: View {
  let line: PaseoAgentsAttributes.Line

  var body: some View {
    HStack(spacing: 8) {
      StateMark(state: line.state)
      (Text(line.title).foregroundColor(.white)
        + Text(subtitleSuffix).foregroundColor(Palette.muted))
        .font(.system(size: 14))
        .lineLimit(1)
      Spacer(minLength: 8)
      detail
        .font(.system(size: 12))
        .foregroundStyle(line.state == "permission" ? Palette.warning : Palette.muted)
        .lineLimit(1)
    }
  }

  private var subtitleSuffix: String {
    guard let subtitle = line.subtitle, !subtitle.isEmpty else { return "" }
    return " · \(subtitle)"
  }

  @ViewBuilder private var detail: some View {
    if line.state == "working" && line.since > 0 {
      Text(Date(timeIntervalSince1970: line.since), style: .timer)
        .monospacedDigit()
        .multilineTextAlignment(.trailing)
        .frame(maxWidth: 64, alignment: .trailing)
    } else {
      Text(line.label)
    }
  }
}

private struct LockScreenView: View {
  let title: String
  let state: PaseoAgentsAttributes.ContentState
  let isStale: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        RoundedRectangle(cornerRadius: 5)
          .fill(Palette.brand)
          .frame(width: 18, height: 18)
          .overlay(Text("P").font(.system(size: 11, weight: .bold)).foregroundStyle(.white))
        Text(title)
          .font(.system(size: 13))
          .foregroundStyle(Palette.muted)
          .lineLimit(1)
        Spacer()
        if isStale {
          Image(systemName: "arrow.clockwise")
            .font(.system(size: 11))
            .foregroundStyle(Palette.muted)
        }
      }
      Text(state.headline)
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(.white)
        .lineLimit(1)
      VStack(alignment: .leading, spacing: 5) {
        ForEach(state.lines, id: \.id) { line in
          LineRow(line: line)
        }
      }
    }
    .padding(16)
  }
}

private struct CountView: View {
  let value: Int
  let label: String
  let color: Color
  let alignment: HorizontalAlignment

  var body: some View {
    VStack(alignment: alignment, spacing: 0) {
      Text("\(value)").font(.system(size: 26, weight: .semibold)).foregroundStyle(color)
      Text(label).font(.system(size: 12)).foregroundStyle(Palette.muted)
    }
  }
}

struct PaseoAgentsLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: PaseoAgentsAttributes.self) { context in
      LockScreenView(
        title: context.attributes.title,
        state: context.state,
        isStale: context.isStale
      )
      .activityBackgroundTint(Palette.surface.opacity(0.92))
      .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          CountView(
            value: context.state.working,
            label: context.state.workingLabel,
            color: .white,
            alignment: .leading
          )
          .padding(.leading, 6)
        }
        DynamicIslandExpandedRegion(.trailing) {
          if context.state.waiting > 0 {
            CountView(
              value: context.state.waiting,
              label: context.state.waitingLabel,
              color: Palette.warning,
              alignment: .trailing
            )
            .padding(.trailing, 6)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 5) {
            ForEach(context.state.lines.prefix(2), id: \.id) { line in
              LineRow(line: line)
            }
          }
          .padding(.horizontal, 6)
        }
      } compactLeading: {
        HStack(spacing: 4) {
          StateMark(state: context.state.waiting > 0 ? "permission" : "working")
          Text("\(context.state.waiting > 0 ? context.state.waiting : context.state.working)")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(context.state.waiting > 0 ? Palette.warning : Palette.accent)
        }
      } compactTrailing: {
        Text(context.state.lines.first?.title ?? "")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(.white)
          .lineLimit(1)
          .frame(maxWidth: 76)
      } minimal: {
        StateMark(state: context.state.waiting > 0 ? "permission" : "working")
      }
      .keylineTint(Palette.accent)
    }
  }
}

@main
struct PaseoWidgets: WidgetBundle {
  var body: some Widget {
    PaseoAgentsLiveActivity()
  }
}
