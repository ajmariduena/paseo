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

private enum Palette {
  static let surface = Color(red: 0.094, green: 0.106, blue: 0.102)
  static let muted = Color(red: 0.631, green: 0.647, blue: 0.643)
  static let track = Color(red: 0.263, green: 0.275, blue: 0.271)
  static let accent = Color(red: 0.486, green: 0.796, blue: 0.627)
  static let brand = Color(red: 0.125, green: 0.455, blue: 0.290)
  static let warning = Color(red: 0.878, green: 0.639, blue: 0.227)
  static let danger = Color(red: 0.776, green: 0.310, blue: 0.263)
}

private func stateColor(_ state: String) -> Color {
  switch state {
  case "permission": return Palette.warning
  case "error": return Palette.danger
  default: return Palette.accent
  }
}

private func linkURL(_ line: PaseoAgentsAttributes.Line?) -> URL? {
  guard let raw = line?.url else { return nil }
  return URL(string: raw)
}

private struct StateMark: View {
  let state: String

  var body: some View {
    Group {
      if state == "working" {
        Circle()
          .trim(from: 0, to: 0.7)
          .stroke(Palette.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round))
      } else {
        Circle().fill(stateColor(state))
      }
    }
    .frame(width: 9, height: 9)
    .accessibilityHidden(true)
  }
}

private struct LineRow: View {
  let line: PaseoAgentsAttributes.Line
  let isStale: Bool

  var body: some View {
    let content = HStack(spacing: 8) {
      StateMark(state: line.state)
      (Text(line.title).foregroundColor(.white)
        + Text(subtitleSuffix).foregroundColor(Palette.muted))
        .font(.system(size: 14))
        .lineLimit(1)
      Spacer(minLength: 8)
      detail
        .font(.system(size: 12))
        .foregroundStyle(detailColor)
        .lineLimit(1)
      if line.url != nil {
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(Palette.track)
          .accessibilityHidden(true)
      }
    }
    .padding(.vertical, line.state == "permission" ? 5 : 0)
    .padding(.horizontal, line.state == "permission" ? 8 : 0)
    .background(
      RoundedRectangle(cornerRadius: 9)
        .fill(line.state == "permission" ? Palette.warning.opacity(0.12) : .clear)
    )
    .padding(.horizontal, line.state == "permission" ? -8 : 0)
    .accessibilityElement(children: .combine)

    if let url = linkURL(line) {
      Link(destination: url) { content }
    } else {
      content
    }
  }

  private var detailColor: Color {
    switch line.state {
    case "permission": return Palette.warning
    case "error": return Palette.danger
    default: return Palette.muted
    }
  }

  private var subtitleSuffix: String {
    guard let subtitle = line.subtitle, !subtitle.isEmpty else { return "" }
    return " · \(subtitle)"
  }

  @ViewBuilder private var detail: some View {
    if line.state == "working" && line.since > 0 {
      // A stale activity can't tell whether the agent is still running, so the timer stops.
      if isStale {
        Text("—")
      } else {
        Text(Date(timeIntervalSince1970: line.since), style: .timer)
          .monospacedDigit()
          .multilineTextAlignment(.trailing)
          .frame(maxWidth: 64, alignment: .trailing)
      }
    } else {
      Text(line.label)
    }
  }
}

private struct ChipView: View {
  let chip: PaseoAgentsAttributes.Chip

  var body: some View {
    HStack(spacing: 5) {
      if chip.state == "working" {
        StateMark(state: chip.state)
      }
      Text(chip.text)
        .font(.system(size: 12, weight: .medium))
        .lineLimit(1)
    }
    .foregroundStyle(chip.state == "working" ? Color.white.opacity(0.88) : stateColor(chip.state))
    .padding(.horizontal, 9)
    .padding(.vertical, 3)
    .background(
      Capsule().fill(
        chip.state == "working" || chip.state == "finished"
          ? Color.white.opacity(0.08) : stateColor(chip.state).opacity(0.16))
    )
  }
}

private struct UpdatedAgo: View {
  let updatedAt: Double?

  var body: some View {
    if let updatedAt {
      HStack(spacing: 3) {
        Image(systemName: "clock")
        Text(Date(timeIntervalSince1970: updatedAt), style: .relative)
      }
      .font(.system(size: 11))
      .foregroundStyle(Palette.muted)
    } else {
      Image(systemName: "arrow.clockwise")
        .font(.system(size: 11))
        .foregroundStyle(Palette.muted)
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
          UpdatedAgo(updatedAt: state.updatedAt)
        }
      }
      if let chips = state.chips, !chips.isEmpty {
        HStack(spacing: 6) {
          ForEach(chips, id: \.state) { chip in
            ChipView(chip: chip)
          }
        }
        .accessibilityElement(children: .combine)
      } else {
        Text(state.headline)
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(.white)
          .lineLimit(1)
      }
      VStack(alignment: .leading, spacing: 5) {
        ForEach(state.lines, id: \.id) { line in
          LineRow(line: line, isStale: isStale)
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
      Text(label).font(.system(size: 12)).foregroundStyle(Palette.muted).lineLimit(1)
    }
    .accessibilityElement(children: .combine)
  }
}

/// The two counts the expanded island shows: only non-zero ones, most urgent first.
private func islandCounts(_ state: PaseoAgentsAttributes.ContentState)
  -> [PaseoAgentsAttributes.Chip]
{
  if let chips = state.chips { return Array(chips.prefix(2)) }
  var counts: [PaseoAgentsAttributes.Chip] = []
  if state.waiting > 0 {
    counts.append(.init(state: "permission", count: state.waiting, text: "", short: state.waitingLabel))
  }
  if state.working > 0 {
    counts.append(.init(state: "working", count: state.working, text: "", short: state.workingLabel))
  }
  return counts
}

private func compactState(_ state: PaseoAgentsAttributes.ContentState) -> String {
  if state.waiting > 0 { return "permission" }
  if state.working > 0 { return "working" }
  return state.chips?.first?.state ?? "finished"
}

private func compactCount(_ state: PaseoAgentsAttributes.ContentState) -> Int {
  if state.waiting > 0 { return state.waiting }
  if state.working > 0 { return state.working }
  return state.chips?.first?.count ?? 0
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
      .widgetURL(linkURL(context.state.lines.first))
    } dynamicIsland: { context in
      let counts = islandCounts(context.state)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          if let first = counts.first {
            CountView(
              value: first.count,
              label: first.short,
              color: first.state == "working" ? .white : stateColor(first.state),
              alignment: .leading
            )
            .padding(.leading, 6)
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          if counts.count > 1 {
            let second = counts[1]
            CountView(
              value: second.count,
              label: second.short,
              color: second.state == "working" ? .white : stateColor(second.state),
              alignment: .trailing
            )
            .padding(.trailing, 6)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 5) {
            ForEach(context.state.lines.prefix(2), id: \.id) { line in
              LineRow(line: line, isStale: context.isStale)
            }
          }
          .padding(.horizontal, 6)
        }
      } compactLeading: {
        HStack(spacing: 4) {
          StateMark(state: compactState(context.state))
          Text("\(compactCount(context.state))")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(stateColor(compactState(context.state)))
        }
      } compactTrailing: {
        Text(context.state.lines.first?.title ?? "")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(context.state.waiting > 0 ? Palette.warning : .white)
          .lineLimit(1)
          .frame(maxWidth: 76)
      } minimal: {
        StateMark(state: compactState(context.state))
      }
      .widgetURL(linkURL(context.state.lines.first))
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
