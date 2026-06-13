import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "@/components/Dashboard";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Digital Twins for Solar Plant Intelligence" },
      { name: "description", content: "Real-time monitoring dashboard for solar plant inverter health, power output, and anomaly detection." },
      { property: "og:title", content: "Digital Twins for Solar Plant Intelligence" },
      { property: "og:description", content: "Real-time monitoring dashboard for solar plant inverter health, power output, and anomaly detection." },
    ],
  }),
  component: Index,
});

function Index() {
  return <Dashboard />;
}
