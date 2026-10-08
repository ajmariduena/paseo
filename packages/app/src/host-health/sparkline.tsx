import { useMemo, type ReactElement } from "react";
import { View } from "react-native";
import Svg, { Line, Path } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { sparklinePaths, type ChartWindow, type MetricTone } from "./model";

// Colors ride on the <Svg> as `color` and the shapes paint with currentColor: withUnistyles wraps
// its component in a <div> on web, which is invalid inside an <svg> and drops the shape.
const DefaultSvg = withUnistyles(Svg, (theme) => ({ color: theme.colors.foregroundMuted }));
const WarningSvg = withUnistyles(Svg, (theme) => ({ color: theme.colors.statusWarning }));
const DangerSvg = withUnistyles(Svg, (theme) => ({ color: theme.colors.statusDanger }));
const BorderSvg = withUnistyles(Svg, (theme) => ({ color: theme.colors.border }));

const TONE_SVG = { default: DefaultSvg, warning: WarningSvg, danger: DangerSvg };
const GRID_PERCENTS = [25, 50, 75];

export function Sparkline({
  values,
  tone,
  height,
  window,
  grid = false,
  thresholdPercent,
}: {
  values: readonly number[];
  tone: MetricTone;
  height: number;
  window: ChartWindow;
  grid?: boolean;
  thresholdPercent?: number;
}): ReactElement {
  const paths = useMemo(
    () => sparklinePaths({ values, height, capacity: window.capacity, endIndex: window.endIndex }),
    [values, height, window.capacity, window.endIndex],
  );
  const width = window.capacity - 1;
  const viewBox = `0 0 ${width} ${height}`;
  const ToneSvg = TONE_SVG[tone];
  const containerStyle = useMemo(() => [styles.container, { height }], [height]);
  return (
    <View
      style={containerStyle}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {grid ? (
        <BorderSvg
          style={styles.layer}
          width="100%"
          height={height}
          viewBox={viewBox}
          preserveAspectRatio="none"
        >
          {GRID_PERCENTS.map((percent) => {
            const y = height - (percent / 100) * height;
            return (
              <Line
                key={percent}
                x1={0}
                x2={width}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </BorderSvg>
      ) : null}
      {thresholdPercent != null ? (
        <DangerSvg
          style={styles.layer}
          width="100%"
          height={height}
          viewBox={viewBox}
          preserveAspectRatio="none"
        >
          <Line
            x1={0}
            x2={width}
            y1={height - (thresholdPercent / 100) * height}
            y2={height - (thresholdPercent / 100) * height}
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="3 3"
            strokeOpacity={0.6}
            vectorEffect="non-scaling-stroke"
          />
        </DangerSvg>
      ) : null}
      {paths ? (
        <ToneSvg
          style={styles.layer}
          width="100%"
          height={height}
          viewBox={viewBox}
          preserveAspectRatio="none"
        >
          <Path d={paths.area} fill="currentColor" fillOpacity={0.1} />
          <Path
            d={paths.line}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </ToneSvg>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
  },
  layer: {
    position: "absolute",
    top: 0,
    left: 0,
  },
});
