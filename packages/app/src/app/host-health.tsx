import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { HostHealthScreen } from "@/screens/host-health-screen";

export default function HostHealthRoute() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  return (
    <HostRouteBootstrapBoundary>
      <HostHealthScreen serverId={params.serverId?.trim() || null} />
    </HostRouteBootstrapBoundary>
  );
}
