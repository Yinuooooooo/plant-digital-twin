import { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  BarChart,
  Bar,
  Cell,
  Label,
} from "recharts";
import { Activity, AlertTriangle, Euro, Search, TrendingDown, Zap } from "lucide-react";
import { Tooltip as UiTooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

// ---------- Mock data ----------
function seededRand(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

type Inverter = {
  id: string;
  pi: number;
  status: "healthy" | "warning" | "critical";
  power: number;
};

// Source of truth overrides for the 6 anomaly inverters.
// Everything in the dashboard (grid, detail panel, anomaly table, totals)
// must reflect these numbers exactly.
const ANOMALY_OVERRIDES: Record<
  string,
  { pi: number; loss: number; code: string }
> = {
  // loss = avg_gap_kw * (5/60) * 0.08 * 120 intervals (10h sunshine)
  // avg_gap_kw = 100 * drop  =>  loss = 80 * drop
  "INV 02.03.019": { pi: 63.3, loss: 29.36, code: "655618" },
  "INV 03.12.044": { pi: 61.9, loss: 30.48, code: "655621" },
  "INV 02.01.017": { pi: 88.8, loss: 8.96, code: "655619" },
  "INV 02.02.018": { pi: 86.3, loss: 10.96, code: "655619" },
  "INV 03.10.042": { pi: 87.3, loss: 10.16, code: "655620" },
  "INV 03.11.043": { pi: 84.8, loss: 12.16, code: "655620" },
};

type MaintenanceTicket = {
  date: string;
  title: string;
  errorCode: string;
  technician: string;
  severity: "critical" | "warning";
};

const MAINTENANCE_HISTORY: Record<string, MaintenanceTicket[]> = {
  "INV 02.03.019": [
    {
      date: "2024-08-14",
      title: "Right cooler fan replaced",
      errorCode: "655618",
      technician: "Klaus M.",
      severity: "critical",
    },
    {
      date: "2022-03-05",
      title: "Cooling inspection",
      errorCode: "655618",
      technician: "Hans B.",
      severity: "warning",
    },
    {
      date: "2020-11-20",
      title: "Power unit fault",
      errorCode: "655616",
      technician: "Klaus M.",
      severity: "critical",
    },
  ],
  "INV 03.12.044": [
    {
      date: "2024-05-22",
      title: "Left cooler fan replaced",
      errorCode: "655621",
      technician: "Hans B.",
      severity: "critical",
    },
    {
      date: "2023-01-10",
      title: "Cooling system inspection",
      errorCode: "655621",
      technician: "Klaus M.",
      severity: "warning",
    },
    {
      date: "2021-07-18",
      title: "Power unit overheating",
      errorCode: "655616",
      technician: "Hans B.",
      severity: "critical",
    },
  ],
  "INV 02.01.017": [
    {
      date: "2023-09-03",
      title: "Interior top left fan cleaned",
      errorCode: "655619",
      technician: "Klaus M.",
      severity: "warning",
    },
    {
      date: "2021-02-14",
      title: "Cooling duct blockage cleared",
      errorCode: "655619",
      technician: "Hans B.",
      severity: "warning",
    },
  ],
  "INV 02.02.018": [
    {
      date: "2024-01-30",
      title: "Interior top left sensor replaced",
      errorCode: "655619",
      technician: "Hans B.",
      severity: "warning",
    },
    {
      date: "2022-06-12",
      title: "Ventilation filter replaced",
      errorCode: "655619",
      technician: "Klaus M.",
      severity: "warning",
    },
    {
      date: "2020-03-08",
      title: "Initial commissioning fault",
      errorCode: "655619",
      technician: "Klaus M.",
      severity: "warning",
    },
  ],
  "INV 03.10.042": [
    {
      date: "2024-04-15",
      title: "Bottom right fan motor replaced",
      errorCode: "655620",
      technician: "Klaus M.",
      severity: "warning",
    },
    {
      date: "2022-08-20",
      title: "Cooling unit leak repaired",
      errorCode: "655620",
      technician: "Hans B.",
      severity: "warning",
    },
  ],
  "INV 03.11.043": [
    {
      date: "2023-11-02",
      title: "Bottom right cooler fan replaced",
      errorCode: "655620",
      technician: "Hans B.",
      severity: "warning",
    },
    {
      date: "2021-05-17",
      title: "Cooling system pressure check",
      errorCode: "655620",
      technician: "Klaus M.",
      severity: "warning",
    },
    {
      date: "2019-10-05",
      title: "Power supply unit replaced",
      errorCode: "655616",
      technician: "Hans B.",
      severity: "critical",
    },
  ],
};

const inverters: Inverter[] = Array.from({ length: 65 }, (_, i) => {
  const rand = seededRand(i + 1);
  const r = rand();
  let pi: number;
  if (r < 0.85) pi = 92 + rand() * 8;
  else if (r < 0.95) pi = 75 + rand() * 15;
  else pi = 55 + rand() * 14;
  const block = String(Math.floor(i / 16) + 1).padStart(2, "0");
  const string = String((i % 16) + 1).padStart(2, "0");
  const unit = String(i + 1).padStart(3, "0");
  const id = `INV ${block}.${string}.${unit}`;
  const override = ANOMALY_OVERRIDES[id];
  if (override) pi = override.pi;
  const status: Inverter["status"] =
    pi > 90 ? "healthy" : pi >= 70 ? "warning" : "critical";
  return {
    id,
    pi: Math.round(pi * 10) / 10,
    status,
    power: Math.round(pi * 5),
  };
});

function buildSeries(invId: string) {
  const seed =
    invId.charCodeAt(invId.length - 1) + invId.charCodeAt(invId.length - 2);
  const rand = seededRand(seed);
  // 5-minute intervals across 24h = 288 points
  const override = ANOMALY_OVERRIDES[invId];
  const piRatio = override ? override.pi / 100 : 1;
  const anomalyStartHour = 14; // when the inverter fails today
  return Array.from({ length: 24 * 12 }, (_, i) => {
    const hourFloat = i / 12;
    const h = Math.floor(hourFloat);
    const m = (i % 12) * 5;
    // ~100 kW peak, ramp 06:00, peak 12-13, down by 20:00
    const sun = hourFloat >= 6 && hourFloat <= 20
      ? Math.max(0, Math.sin((Math.PI * (hourFloat - 6)) / 14))
      : 0;
    const predicted = Math.round((sun * 100 + rand() * 2) * 10) / 10;
    let actual: number;
    if (override && hourFloat >= anomalyStartHour) {
      // visible drop: actual collapses to ~pi% of predicted with small noise
      const noise = (rand() - 0.5) * 1.5;
      actual = Math.max(0, Math.round((predicted * piRatio + noise) * 10) / 10);
    } else {
      const drift = (rand() - 0.45) * 4 * sun;
      actual = Math.max(0, Math.round((predicted + drift) * 10) / 10);
    }
    return {
      time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
      predicted,
      actual,
    };
  });
}

function PowerTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ payload: { predicted: number; actual: number } }>;
  label?: string;
}) {
  if (!active || !payload || !payload.length) return null;
  const { predicted, actual } = payload[0].payload;
  const gap = actual - predicted; // negative when underperforming
  const lossKw = Math.max(0, predicted - actual);
  const lossKwh = lossKw * (5 / 60);
  const lossEur = lossKwh * 0.08;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-xl">
      <div className="mb-1 font-semibold text-foreground">{label}</div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono tabular-nums">
        <span className="text-chart-predicted">Predicted:</span>
        <span className="text-right text-foreground">{predicted.toFixed(1)} kW</span>
        <span className="text-chart-actual">Actual:</span>
        <span className="text-right text-foreground">{actual.toFixed(1)} kW</span>
        <span className="text-muted-foreground">Gap:</span>
        <span className={cn("text-right", gap < 0 ? "text-destructive" : "text-success")}>
          {gap >= 0 ? "+" : ""}{gap.toFixed(1)} kW
        </span>
        <span className="text-muted-foreground">Loss:</span>
        <span className={cn("text-right", lossEur > 0 ? "text-destructive" : "text-foreground")}>
          € {lossEur.toFixed(3)}
        </span>
      </div>
    </div>
  );
}

function buildMonthlySeries(invId: string) {
  const seed = invId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = seededRand(seed);
  const points: { label: string; predicted: number; actual: number }[] = [];
  for (let year = 2017; year <= 2026; year++) {
    for (let m = 0; m < 12; m++) {
      // skip months beyond Jun 2026
      if (year === 2026 && m > 5) break;
      const seasonal =
        320 + Math.sin(((m + 3) / 12) * Math.PI * 2) * 180;
      const degradation = (year - 2017) * 6;
      const predicted = Math.round(seasonal - degradation + rand() * 20);
      const drift = (rand() - 0.5) * 90;
      const actual = Math.max(40, Math.round(predicted + drift - rand() * 30));
      const monthLabel = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m];
      points.push({
        label: m === 0 ? `${monthLabel} ${year}` : monthLabel,
        predicted,
        actual,
      });
    }
  }
  return points;
}

function buildAnomalyByYear(invId: string) {
  const seed = invId.split("").reduce((a, c) => a + c.charCodeAt(0), 0) * 3;
  const rand = seededRand(seed);
  return Array.from({ length: 10 }, (_, i) => ({
    year: String(2017 + i),
    count: Math.round(4 + rand() * 22),
  }));
}

function buildInverterDetails(invId: string, pi: number) {
  const seed = invId.split("").reduce((a, c) => a + c.charCodeAt(0), 0) * 7;
  const rand = seededRand(seed);
  const energyLoss = Math.round(800 + (100 - pi) * 35 + rand() * 400);
  const financialLoss = Math.round(energyLoss * (2.1 + rand() * 0.6));
  const errorCodes = [
    { code: "655618", desc: "Overtemperature" },
    { code: "402311", desc: "DC voltage out of range" },
    { code: "118204", desc: "AC grid frequency drift" },
    { code: "301557", desc: "Isolation fault" },
  ];
  const err = errorCodes[Math.floor(rand() * errorCodes.length)];
  return { energyLoss, financialLoss, err };
}

// ---------- Range-aware mock data ----------
type RangeKey = "today" | "7d" | "30d" | "1y" | "all";

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "1y", label: "Last year" },
  { key: "all", label: "All time" },
];

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function rangeSeed(invId: string, range: RangeKey) {
  const base = invId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const mult: Record<RangeKey, number> = { today: 1, "7d": 3, "30d": 7, "1y": 13, all: 19 };
  return base * mult[range];
}

function buildRangeSeries(invId: string, range: RangeKey) {
  const rand = seededRand(rangeSeed(invId, range));
  if (range === "today") {
    return Array.from({ length: 24 }, (_, h) => {
      const sun = h >= 6 && h <= 20
        ? Math.max(0, Math.sin((Math.PI * (h - 6)) / 14))
        : 0;
      const predicted = Math.round((sun * 100 + rand() * 2) * 10) / 10;
      const drift = (rand() - 0.45) * 12 * sun;
      const actual = Math.max(0, Math.round((predicted + drift) * 10) / 10);
      return { label: `${String(h).padStart(2, "0")}:00`, predicted, actual };
    });
  }
  if (range === "7d" || range === "30d") {
    const days = range === "7d" ? 7 : 30;
    return Array.from({ length: days }, (_, i) => {
      const dayIdx = days - 1 - i;
      const d = new Date();
      d.setDate(d.getDate() - dayIdx);
      // ~500 kWh/day per inverter, seasonal swing
      const seasonal = 500 + Math.sin(((d.getMonth() + 3) / 12) * Math.PI * 2) * 150;
      const predicted = Math.round(seasonal + rand() * 30);
      const drift = (rand() - 0.5) * 80;
      const actual = Math.max(80, Math.round(predicted + drift));
      const label = `${String(d.getDate()).padStart(2, "0")} ${MONTH_LABELS[d.getMonth()]}`;
      return { label, predicted, actual };
    });
  }
  if (range === "1y") {
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date();
      d.setMonth(d.getMonth() - (11 - i));
      const m = d.getMonth();
      // ~500 kWh/day * 30 = 15000 kWh/month, seasonal swing
      const seasonal = 15000 + Math.sin(((m + 3) / 12) * Math.PI * 2) * 6000;
      const predicted = Math.round(seasonal + rand() * 600);
      const drift = (rand() - 0.5) * 1500;
      const actual = Math.max(2000, Math.round(predicted + drift));
      return { label: `${MONTH_LABELS[m]} ${String(d.getFullYear()).slice(2)}`, predicted, actual };
    });
  }
  // all time: years 2017-2026, ~500 kWh/day * 365 = 182,500 kWh/year
  return Array.from({ length: 10 }, (_, i) => {
    const year = 2017 + i;
    const degradation = i * 1500;
    const predicted = Math.round(185000 - degradation + rand() * 4000);
    const drift = (rand() - 0.5) * 8000;
    const actual = Math.max(40000, Math.round(predicted + drift - rand() * 3000));
    return { label: String(year), predicted, actual };
  });
}

function getDropColor(drop: number) {
  const abs = Math.abs(drop);
  if (abs > 30) return "oklch(0.62 0.22 25)";
  if (abs > 15) return "oklch(0.78 0.17 85)";
  return "oklch(0.82 0.14 95)";
}

function buildRangeAnomalies(invId: string, range: RangeKey, pi: number) {
  const rand = seededRand(rangeSeed(invId, range) + 101);
  const status = pi > 90 ? "healthy" : pi >= 70 ? "warning" : "critical";
  const yearlyLow = status === "healthy" ? 0 : status === "warning" ? 5 : 15;
  const yearlyHigh = status === "healthy" ? 3 : status === "warning" ? 15 : 30;
  const dropVal = -(100 - pi);
  if (range === "today") {
    // Realistic: anomalies happen occasionally during peak heat hours,
    // not continuously. Critical inverters: 2-3 events; degraded: 1 event.
    const spikeHours: number[] =
      status === "critical" ? [9, 14] : status === "warning" ? [13] : [];
    return Array.from({ length: 24 }, (_, h) => ({
      label: `${String(h).padStart(2, "0")}`,
      count: spikeHours.includes(h) ? 1 : 0,
      drop: spikeHours.includes(h) ? Math.round(dropVal * 10) / 10 : 0,
    }));
  }
  if (range === "7d" || range === "30d") {
    const days = range === "7d" ? 7 : 30;
    return Array.from({ length: days }, (_, i) => {
      const dayIdx = days - 1 - i;
      const d = new Date();
      d.setDate(d.getDate() - dayIdx);
      return {
        label: `${String(d.getDate()).padStart(2, "0")} ${MONTH_LABELS[d.getMonth()]}`,
        count: Math.round(rand() * 6),
        drop: 0,
      };
    });
  }
  if (range === "1y") {
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date();
      d.setMonth(d.getMonth() - (11 - i));
      return {
        label: `${MONTH_LABELS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`,
        count: Math.round(4 + rand() * 22),
        drop: 0,
      };
    });
  }
  // all time: realistic yearly counts based on inverter health
  return Array.from({ length: 10 }, (_, i) => ({
    label: String(2017 + i),
    count: Math.round(yearlyLow + rand() * (yearlyHigh - yearlyLow)),
    drop: 0,
  }));
}

function buildRangeDetails(invId: string, pi: number, range: RangeKey) {
  // Exact day counts per range
  const days: Record<RangeKey, number> = {
    today: 1, "7d": 7, "30d": 30, "1y": 365, all: 3650,
  };
  const override = ANOMALY_OVERRIDES[invId];
  // Daily loss = avg_gap_kw * (5/60) * 0.08 * 120 = 100*drop * 0.8 = 80*drop
  const drop = (100 - pi) / 100;
  const dailyLoss = override ? override.loss : 100 * drop * (5 / 60) * 0.08 * 120;
  const financialLoss = Math.round(dailyLoss * days[range] * 100) / 100;
  // Energy loss in kWh (financial / €0.08)
  const energyLoss = Math.round(financialLoss / 0.08);
  // PI matches the grid card exactly — no per-range drift.
  return { energyLoss, financialLoss, piRange: pi };
}

function rangeChartTitle(range: RangeKey) {
  switch (range) {
    case "today": return "Predicted vs Actual · Today";
    case "7d": return "Predicted vs Actual · Last 7 days";
    case "30d": return "Predicted vs Actual · Last 30 days";
    case "1y": return "Predicted vs Actual · Last 12 months";
    case "all": return "Predicted vs Actual · 2017–2026";
  }
}

function rangeBarTitle(range: RangeKey) {
  switch (range) {
    case "today": return "Performance Drop by Hour";
    case "7d":
    case "30d": return "Anomalies per Day";
    case "1y": return "Anomalies per Month";
    case "all": return "Anomalies per Year";
  }
}

const ERROR_CODES: Record<string, string> = {
  "655616": "Power unit fault",
  "655618": "Right cooler overtemperature",
  "655619": "Interior overtemperature (top left)",
  "655620": "Interior overtemperature (bottom right)",
  "655621": "Left cooler overtemperature",
  "663565": "Device temperature too high",
  "655361": "Boost converter DC-link failed",
  "655373": "Grid overvoltage detected",
  "655374": "Grid undervoltage detected",
  "655641": "Current sensor failure",
  "1048577": "Ethernet connection failed",
  "1048578": "Ethernet connection lost",
};

// Anomalies are derived from the actual underperforming inverters in the grid
// (the red/critical and yellow/warning ones). IDs match the grid format exactly.
const ANOMALY_INVERTER_IDS = [
  "INV 02.03.019", // red
  "INV 03.12.044", // red
  "INV 02.01.017", // yellow
  "INV 02.02.018", // yellow
  "INV 03.10.042", // yellow
  "INV 03.11.043", // yellow
];

const ANOMALY_TIMESTAMPS: Record<string, string> = {
  "INV 02.03.019": "12 Jun 2026 11:42",
  "INV 03.12.044": "12 Jun 2026 10:55",
  "INV 02.01.017": "12 Jun 2026 11:18",
  "INV 02.02.018": "12 Jun 2026 10:31",
  "INV 03.10.042": "12 Jun 2026 09:47",
  "INV 03.11.043": "12 Jun 2026 09:12",
};

const anomalies = ANOMALY_INVERTER_IDS.map((id) => {
  const inv = inverters.find((i) => i.id === id)!;
  const override = ANOMALY_OVERRIDES[id];
  const drop = Math.round((100 - inv.pi) * 10) / 10;
  return {
    id,
    ts: ANOMALY_TIMESTAMPS[id],
    drop,
    loss: override.loss,
    code: override.code,
  };
});

const totalLoss = anomalies.reduce((s, a) => s + a.loss, 0);
const worst = [...inverters].sort((a, b) => a.pi - b.pi)[0];

// ---------- UI ----------
function statusStyles(status: Inverter["status"]) {
  switch (status) {
    case "healthy":
      return {
        ring: "ring-success/40 hover:ring-success",
        dot: "bg-success shadow-[0_0_10px_oklch(0.7_0.18_145)]",
        text: "text-success",
        bar: "bg-success",
      };
    case "warning":
      return {
        ring: "ring-warning/40 hover:ring-warning",
        dot: "bg-warning shadow-[0_0_10px_oklch(0.78_0.17_85)]",
        text: "text-warning",
        bar: "bg-warning",
      };
    case "critical":
      return {
        ring: "ring-danger/50 hover:ring-danger",
        dot: "bg-danger shadow-[0_0_10px_oklch(0.62_0.22_25)]",
        text: "text-danger",
        bar: "bg-danger",
      };
  }
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
  onClick,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  sub?: string;
  accent: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-card p-5",
        onClick && "cursor-pointer",
      )}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
            {value}
          </p>
          {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
        </div>
        <div
          className={cn(
            "flex h-11 w-11 items-center justify-center rounded-lg",
            accent,
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

export function Dashboard() {
  const [chartInv, setChartInv] = useState<string>(inverters[6].id);
  const [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>("today");
  const [rankPanelOpen, setRankPanelOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [anomaliesPanelOpen, setAnomaliesPanelOpen] = useState(false);
  const [errorTypePanelOpen, setErrorTypePanelOpen] = useState(false);
  const series = useMemo(() => buildSeries(chartInv), [chartInv]);
  const chartInvData = inverters.find((i) => i.id === chartInv)!;
  const selectedInv = selected
    ? inverters.find((i) => i.id === selected) ?? null
    : null;
  const rangedSeries = useMemo(
    () => (selectedInv ? buildRangeSeries(selectedInv.id, range) : []),
    [selectedInv, range],
  );
  const rangedAnoms = useMemo(
    () => (selectedInv ? buildRangeAnomalies(selectedInv.id, range, selectedInv.pi) : []),
    [selectedInv, range],
  );
  const details = useMemo(() => {
    if (!selectedInv) return null;
    const base = buildInverterDetails(selectedInv.id, selectedInv.pi);
    const ranged = buildRangeDetails(selectedInv.id, selectedInv.pi, range);
    return { ...base, ...ranged };
  }, [selectedInv, range]);

  const ranked = useMemo(() => [...inverters].sort((a, b) => a.pi - b.pi), []);
  const filteredRanked = useMemo(() => {
    if (!searchQuery.trim()) return ranked;
    const q = searchQuery.toLowerCase();
    return ranked.filter((inv) => inv.id.toLowerCase().includes(q));
  }, [ranked, searchQuery]);

  // Reset range when a different inverter is opened
  useEffect(() => {
    if (selectedInv) setRange("today");
  }, [selectedInv?.id]);

  function toggleSelect(id: string) {
    setSelected((cur) => (cur === id ? null : id));
    setChartInv(id);
  }

  function highlightFromAnomaly(id: string) {
    setAnomaliesPanelOpen(false);
    setSelected(id);
    setChartInv(id);
    // Scroll the matching grid card into view after the sheet closes
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-inv-id="${id}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  function openInverterFromErrorType(id: string) {
    setErrorTypePanelOpen(false);
    setSelected(id);
    setChartInv(id);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-inv-id="${id}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  const now = new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[1600px] px-6 py-6 lg:px-10">
        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
                <Zap className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">
                  Digital Twins for Solar Plant Intelligence
                </h1>
                <p className="text-sm text-muted-foreground">
                  Live inverter telemetry · Andalusia, ES
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            Last updated <span className="font-mono text-foreground">{now}</span>
          </div>
        </header>

        {/* Summary */}
        <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <SummaryCard
            icon={Euro}
            label="Total Loss Today"
            value={`€ ${totalLoss.toLocaleString("en-GB", { minimumFractionDigits: 2 })}`}
            sub="Across all anomalies"
            accent="bg-danger/15 text-danger"
            onClick={() => setAnomaliesPanelOpen(true)}
          />
          <SummaryCard
            icon={TrendingDown}
            label="Worst Performer"
            value={worst.id}
            sub={`Performance index ${worst.pi}%`}
            accent="bg-warning/15 text-warning"
            onClick={() => setRankPanelOpen(true)}
          />
          <SummaryCard
            icon={AlertTriangle}
            label="Active Anomalies"
            value={String(anomalies.length)}
            sub="Detected in last 4h"
            accent="bg-primary/15 text-primary"
            onClick={() => setErrorTypePanelOpen(true)}
          />
        </section>

        {/* Inverter grid */}
        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Inverter Health · 65 units
            </h2>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-success" /> &gt; 90%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-warning" /> 70–90%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-danger" /> &lt; 70%
              </span>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2.5 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-[repeat(13,minmax(0,1fr))]">
            {inverters.map((inv) => {
              const s = statusStyles(inv.status);
              const isActive = inv.id === selected;
              return (
                <button
                  key={inv.id}
                  data-inv-id={inv.id}
                  onClick={() => toggleSelect(inv.id)}
                  className={cn(
                    "group relative flex flex-col items-start gap-1 rounded-lg bg-card px-2.5 py-2 text-left ring-1 transition-all",
                    s.ring,
                    isActive &&
                      "ring-2 ring-primary shadow-[0_0_0_3px_oklch(0.72_0.17_60/0.25)] scale-[1.04] z-10",
                  )}
                >
                  <div className="flex w-full items-center justify-between">
                    <span className="font-mono text-[9px] text-muted-foreground">
                      {inv.id.replace("INV ", "")}
                    </span>
                    <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
                  </div>
                  <span className={cn("text-sm font-semibold tabular-nums", s.text)}>
                    {inv.pi}%
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Chart */}
        <section className="mt-8 rounded-xl border border-border bg-card p-5">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Power Output · Predicted vs Actual</h2>
              <p className="text-sm text-muted-foreground">
                Inverter{" "}
                <span className="font-mono text-foreground">{chartInvData.id}</span> ·
                Performance Index{" "}
                <span className={cn("font-semibold", statusStyles(chartInvData.status).text)}>
                  {chartInvData.pi}%
                </span>
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-2 text-muted-foreground">
                <span className="h-0.5 w-5 rounded bg-chart-predicted" /> Predicted
              </span>
              <span className="flex items-center gap-2 text-muted-foreground">
                <span className="h-0.5 w-5 rounded bg-chart-actual" /> Actual
              </span>
            </div>
          </div>
          <div className="h-[320px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 10, right: 20, bottom: 0, left: -10 }}>
                <CartesianGrid stroke="oklch(0.3 0.02 250)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="time"
                  stroke="oklch(0.6 0.02 250)"
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: "oklch(0.32 0.02 250)" }}
                  interval={35}
                  minTickGap={24}
                />
                <YAxis
                  stroke="oklch(0.6 0.02 250)"
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: "oklch(0.32 0.02 250)" }}
                  unit=" kW"
                />
                <Tooltip
                  cursor={{ stroke: "oklch(0.5 0.02 250)", strokeDasharray: "3 3" }}
                  content={<PowerTooltip />}
                />
                <Legend wrapperStyle={{ display: "none" }} />
                <Line
                  type="monotone"
                  dataKey="predicted"
                  stroke="oklch(0.68 0.18 235)"
                  strokeWidth={2}
                  dot={false}
                  name="Predicted"
                />
                <Line
                  type="monotone"
                  dataKey="actual"
                  stroke="oklch(0.72 0.18 55)"
                  strokeWidth={2}
                  dot={false}
                  name="Actual"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>


        <footer className="mt-8 pb-6 text-center text-xs text-muted-foreground">
          Digital Twin v2.4 · Mock telemetry stream
        </footer>
      </div>

      {/* Detail panel */}
      <Sheet
        open={!!selectedInv}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full overflow-y-auto border-l border-border bg-card p-0 sm:max-w-xl"
        >
          {selectedInv && details && (
            <div className="flex flex-col">
              <SheetHeader className="border-b border-border bg-gradient-to-br from-card to-secondary/40 px-6 py-5">
                <div className="flex items-start justify-between">
                  <div>
                    <SheetDescription className="text-xs uppercase tracking-wider">
                      Inverter Detail
                    </SheetDescription>
                    <SheetTitle className="mt-1 font-mono text-2xl">
                      {selectedInv.id}
                    </SheetTitle>
                    <p
                      className={cn(
                        "mt-1 text-sm font-medium",
                        statusStyles(selectedInv.status).text,
                      )}
                    >
                      {selectedInv.status === "healthy"
                        ? "Operating normally"
                        : selectedInv.status === "warning"
                          ? "Degraded performance"
                          : "Critical fault"}
                    </p>
                  </div>
                </div>
              </SheetHeader>

              <div className="space-y-6 px-6 py-5">
                {/* Range selector */}
                <div className="flex flex-wrap gap-1.5">
                  {RANGE_OPTIONS.map((opt) => {
                    const active = range === opt.key;
                    return (
                      <button
                        key={opt.key}
                        onClick={() => setRange(opt.key)}
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                          active
                            ? "border-primary bg-primary/15 text-primary"
                            : "border-border bg-background/40 text-muted-foreground hover:text-foreground hover:border-border",
                        )}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>

                {/* KPIs */}
                <div className="grid grid-cols-2 gap-3">
                  <DetailStat
                    label="Performance Index"
                    value={`${details.piRange}%`}
                    accent={statusStyles(selectedInv.status).text}
                  />
                  <DetailStat
                    label="Total Energy Loss"
                    value={`${details.energyLoss.toLocaleString("en-GB")} kWh`}
                  />
                  <DetailStat
                    label="Financial Loss"
                    value={`€ ${details.financialLoss.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    accent="text-danger"
                  />
                  <DetailStat
                    label="Most Common Error"
                    value={
                      selectedInv.status === "healthy"
                        ? "—"
                        : ANOMALY_OVERRIDES[selectedInv.id]?.code ?? details.err.code
                    }
                    sub={
                      selectedInv.status === "healthy"
                        ? "None"
                        : ERROR_CODES[ANOMALY_OVERRIDES[selectedInv.id]?.code ?? ""] ??
                          details.err.desc
                    }
                  />
                </div>

                {/* Maintenance History */}
                <div>
                  <h3 className="mb-3 text-sm font-semibold">🔧 Maintenance History</h3>
                  {selectedInv.status === "healthy" ? (
                    <p className="text-sm text-muted-foreground">No maintenance history</p>
                  ) : (
                    <div className="space-y-3">
                      {(() => {
                        const tickets = MAINTENANCE_HISTORY[selectedInv.id] ?? [];
                        const codeCounts: Record<string, number> = {};
                        for (const t of tickets) {
                          codeCounts[t.errorCode] = (codeCounts[t.errorCode] || 0) + 1;
                        }
                        const recurringCode = Object.entries(codeCounts).find(([, c]) => c >= 2)?.[0];
                        const showPattern = recurringCode && tickets.length >= 2;
                        return (
                          <>
                            <div className="space-y-3">
                              {tickets.map((ticket, idx) => (
                                <div
                                  key={idx}
                                  className="rounded-lg border border-border bg-background/40 p-3"
                                >
                                  <div className="flex items-start gap-2">
                                    <span
                                      className={cn(
                                        "mt-0.5 h-2 w-2 shrink-0 rounded-full",
                                        ticket.severity === "critical"
                                          ? "bg-danger"
                                          : "bg-warning",
                                      )}
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                        <span className="text-xs text-muted-foreground">
                                          {ticket.date}
                                        </span>
                                        <span className="text-sm font-medium text-foreground">
                                          {ticket.title}
                                        </span>
                                      </div>
                                      <div className="mt-0.5 text-xs text-muted-foreground">
                                        Error: {ticket.errorCode} · Technician: {ticket.technician}
                                      </div>
                                      <div className="mt-1 text-xs font-medium text-success">
                                        Status: ✅ Resolved
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                            {showPattern && (
                              <div className="rounded-lg border border-warning/30 bg-warning/10 p-4">
                                <div className="flex items-center gap-2 text-sm font-semibold text-warning">
                                  <span>⚠️</span>
                                  <span>Pattern Detected</span>
                                </div>
                                <p className="mt-1.5 text-sm leading-relaxed text-foreground">
                                  This inverter has had{" "}
                                  {ERROR_CODES[recurringCode]?.toLowerCase() ?? `error ${recurringCode}`}{" "}
                                  ({recurringCode}) repaired{" "}
                                  {codeCounts[recurringCode]} times before. Current fault suggests a
                                  recurring cooling system failure. Recommend: full cooling unit
                                  inspection rather than fan-only replacement.
                                </p>
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  )}
                </div>

                {/* Monthly line chart */}
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">
                      {rangeChartTitle(range)}
                    </h3>
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <span className="h-0.5 w-3 rounded bg-chart-predicted" />
                        Predicted
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="h-0.5 w-3 rounded bg-chart-actual" />
                        Actual
                      </span>
                    </div>
                  </div>
                  <div className="h-[200px] w-full rounded-lg border border-border bg-background/40 p-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart
                        data={rangedSeries}
                        margin={{ top: 8, right: 8, bottom: 0, left: -18 }}
                      >
                        <CartesianGrid
                          stroke="oklch(0.3 0.02 250)"
                          strokeDasharray="3 3"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="label"
                          stroke="oklch(0.6 0.02 250)"
                          tick={{ fontSize: 9 }}
                          tickLine={false}
                          axisLine={{ stroke: "oklch(0.32 0.02 250)" }}
                          interval="preserveStartEnd"
                          minTickGap={20}
                        />
                        <YAxis
                          stroke="oklch(0.6 0.02 250)"
                          tick={{ fontSize: 9 }}
                          tickLine={false}
                          axisLine={{ stroke: "oklch(0.32 0.02 250)" }}
                        />
                        <Tooltip
                          cursor={{ stroke: "oklch(0.5 0.02 250)", strokeDasharray: "3 3" }}
                          content={<PowerTooltip />}
                        />
                        <Line
                          type="monotone"
                          dataKey="predicted"
                          stroke="oklch(0.68 0.18 235)"
                          strokeWidth={1.5}
                          dot={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="actual"
                          stroke="oklch(0.72 0.18 55)"
                          strokeWidth={1.5}
                          dot={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Anomaly bar chart */}
                <div>
                  <h3 className="mb-2 text-sm font-semibold">{rangeBarTitle(range)}</h3>
                  <div className="h-[180px] w-full rounded-lg border border-border bg-background/40 p-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={rangedAnoms}
                        margin={{ top: 8, right: 8, bottom: 0, left: -20 }}
                      >
                        <CartesianGrid
                          stroke="oklch(0.3 0.02 250)"
                          strokeDasharray="3 3"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="label"
                          stroke="oklch(0.6 0.02 250)"
                          tick={{ fontSize: 10 }}
                          tickLine={false}
                          axisLine={{ stroke: "oklch(0.32 0.02 250)" }}
                          interval="preserveStartEnd"
                          minTickGap={16}
                        />
                        <YAxis
                          stroke="oklch(0.6 0.02 250)"
                          tick={{ fontSize: 10 }}
                          tickLine={false}
                          axisLine={{ stroke: "oklch(0.32 0.02 250)" }}
                          domain={range === "today" ? [-50, 0] : undefined}
                          label={
                            range === "today"
                              ? {
                                  value: "Drop (%)",
                                  angle: -90,
                                  position: "insideLeft",
                                  offset: 10,
                                  style: {
                                    textAnchor: "middle",
                                    fill: "oklch(0.6 0.02 250)",
                                    fontSize: 10,
                                  },
                                }
                              : undefined
                          }
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "oklch(0.2 0.018 250)",
                            border: "1px solid oklch(0.32 0.02 250)",
                            borderRadius: 8,
                            fontSize: 11,
                          }}
                          cursor={{ fill: "oklch(0.3 0.02 250 / 0.3)" }}
                        />
                        <Bar
                          dataKey={range === "today" ? "drop" : "count"}
                          name={range === "today" ? "Drop" : "Anomalies"}
                          fill="oklch(0.72 0.17 60)"
                          radius={[4, 4, 0, 0]}
                        >
                          {range === "today" &&
                            rangedAnoms.map((entry, index) => (
                              <Cell
                                key={`cell-${index}`}
                                fill={getDropColor(entry.drop)}
                              />
                            ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Ranking panel */}
      <Sheet open={rankPanelOpen} onOpenChange={(o) => setRankPanelOpen(o)}>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto border-l border-border bg-card p-0 sm:max-w-lg"
        >
          <div className="flex h-full flex-col">
            <SheetHeader className="border-b border-border px-6 py-5">
              <SheetTitle className="text-lg">
                All Inverters · Ranked by Performance
              </SheetTitle>
              <div className="relative mt-3">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search inverter ID..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-background/40 pl-9"
                />
              </div>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto">
              {filteredRanked.map((inv, idx) => {
                const s = statusStyles(inv.status);
                return (
                  <button
                    key={inv.id}
                    onClick={() => {
                      setSelected(inv.id);
                      setChartInv(inv.id);
                      setRankPanelOpen(false);
                    }}
                    className="flex w-full items-center gap-3 border-b border-border px-6 py-2.5 text-left transition-colors hover:bg-secondary/40"
                  >
                    <span className="w-7 text-xs font-semibold tabular-nums text-muted-foreground">
                      #{idx + 1}
                    </span>
                    <span className="w-28 font-mono text-sm text-foreground">
                      {inv.id}
                    </span>
                    <div className="flex-1">
                      <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                        <div
                          className={cn("h-full rounded-full", s.bar)}
                          style={{ width: `${Math.min(inv.pi, 100)}%` }}
                        />
                      </div>
                    </div>
                    <span
                      className={cn(
                        "w-14 text-right text-sm font-semibold tabular-nums",
                        s.text,
                      )}
                    >
                      {inv.pi}%
                    </span>
                    <span className={cn("h-2.5 w-2.5 rounded-full", s.dot)} />
                  </button>
                );
              })}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Anomalies panel */}
      <Sheet open={anomaliesPanelOpen} onOpenChange={(o) => setAnomaliesPanelOpen(o)}>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto border-l border-border bg-card p-0 sm:max-w-xl"
        >
          <TooltipProvider delayDuration={200}>
            <div className="flex h-full flex-col">
              <SheetHeader className="border-b border-border px-5 py-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-warning" />
                  <SheetTitle className="text-base font-semibold">Detected Anomalies</SheetTitle>
                </div>
                <SheetDescription className="text-xs text-muted-foreground">
                  {anomalies.length} events · last 4 hours
                </SheetDescription>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs uppercase tracking-wider text-muted-foreground">
                        <th className="px-5 py-3 text-left font-medium">Inverter ID</th>
                        <th className="px-5 py-3 text-left font-medium">Timestamp</th>
                        <th className="px-5 py-3 text-right font-medium">Performance Drop</th>
                        <th className="px-5 py-3 text-right font-medium">Financial Loss</th>
                        <th className="px-5 py-3 text-left font-medium">Error Code</th>
                      </tr>
                    </thead>
                    <tbody>
                      {anomalies.map((a, idx) => (
                        <tr
                          key={idx}
                          className="border-t border-border transition-colors hover:bg-secondary/40"
                        >
                          <td className="px-5 py-3 font-mono">
                            <button
                              type="button"
                              onClick={() => highlightFromAnomaly(a.id)}
                              className="text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
                            >
                              {a.id}
                            </button>
                          </td>
                          <td className="px-5 py-3 text-muted-foreground">{a.ts}</td>
                          <td className="px-5 py-3 text-right tabular-nums text-danger">
                            −{a.drop.toFixed(1)}%
                          </td>
                          <td className="px-5 py-3 text-right tabular-nums text-foreground">
                            € {a.loss.toFixed(2)}
                          </td>
                          <td className="px-5 py-3">
                            <UiTooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex cursor-help items-center rounded-md bg-danger/15 px-2 py-0.5 font-mono text-xs text-danger ring-1 ring-danger/30">
                                  {a.code}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-[240px] text-center">
                                {ERROR_CODES[a.code]}
                              </TooltipContent>
                            </UiTooltip>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </TooltipProvider>
        </SheetContent>
      </Sheet>

      {/* Error Type panel */}
      <Sheet open={errorTypePanelOpen} onOpenChange={(o) => setErrorTypePanelOpen(o)}>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto border-l border-border bg-card p-0 sm:max-w-lg"
        >
          <div className="flex h-full flex-col">
            <SheetHeader className="border-b border-border px-6 py-5">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning" />
                <SheetTitle className="text-lg">Anomalies by Error Type</SheetTitle>
              </div>
              <SheetDescription className="text-xs text-muted-foreground">
                {anomalies.length} active anomalies grouped by error code
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              {[
                { code: "655618", title: "Overtemperature - Right Cooler", headerClass: "bg-danger/10 text-danger border-danger/20" },
                { code: "655621", title: "Overtemperature - Left Cooler", headerClass: "bg-danger/10 text-danger border-danger/20" },
                { code: "655619", title: "Interior Overtemperature Top Left", headerClass: "bg-warning/10 text-warning border-warning/20" },
                { code: "655620", title: "Interior Overtemperature Bottom Right", headerClass: "bg-warning/10 text-warning border-warning/20" },
              ].map((g) => {
                const items = anomalies.filter((a) => a.code === g.code);
                const subtotal = items.reduce((s, a) => s + a.loss, 0);
                return (
                  <div key={g.code} className="rounded-lg border border-border overflow-hidden">
                    <div className={cn("px-4 py-3 border-b", g.headerClass)}>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold">{g.title}</span>
                        <span className="font-mono text-xs opacity-80">{g.code}</span>
                      </div>
                    </div>
                    <div className="divide-y divide-border">
                      {items.map((a) => (
                        <div key={a.id} className="flex items-center justify-between px-4 py-3">
                          <button
                            type="button"
                            onClick={() => openInverterFromErrorType(a.id)}
                            className="font-mono text-sm text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
                          >
                            {a.id}
                          </button>
                          <div className="flex items-center gap-5">
                            <span className="text-xs text-muted-foreground">
                              PI: {inverters.find((i) => i.id === a.id)?.pi}%
                            </span>
                            <span className="text-sm tabular-nums text-foreground">
                              € {a.loss.toFixed(2)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center justify-between border-t border-border bg-secondary/30 px-4 py-2.5">
                      <span className="text-xs font-medium text-muted-foreground">Subtotal</span>
                      <span className="text-sm font-semibold tabular-nums text-foreground">
                        € {subtotal.toFixed(2)}
                      </span>
                    </div>
                  </div>
                );
              })}
              <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/40 px-4 py-3">
                <span className="text-sm font-semibold">Total Loss</span>
                <span className="text-lg font-bold tabular-nums text-danger">
                  € {totalLoss.toLocaleString("en-GB", { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>
      <ChatAssistant />
    </div>
  );
}

function DetailStat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-lg font-semibold tabular-nums text-foreground",
          accent,
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

type ChatMsg = { role: "user" | "assistant"; content: string };

const PRESET_QA: { q: string; a: string }[] = [
  {
    q: "Which inverter is performing worst?",
    a: "INV 03.12.044 is the worst performer today with a Performance Index of 61.9%, down 38.1% from expected output. Error code 655621 indicates left cooler overtemperature. Estimated loss today: € 30.48. Recommend scheduling maintenance.",
  },
  {
    q: "What's causing the most losses today?",
    a: "Overtemperature is the dominant fault type today, affecting 4 out of 6 anomaly inverters. Total thermal-related losses: € 79.76. This pattern suggests cooling system inspection is needed across AC-Combiner 02 and 03.",
  },
  {
    q: "Show me all overtemperature faults",
    a: "4 inverters show overtemperature errors:\n• INV 02.03.019 — Right cooler (655618) — € 29.36\n• INV 03.12.044 — Left cooler (655621) — € 30.48\n• INV 02.01.017 — Interior top left (655619) — € 8.96\n• INV 02.02.018 — Interior top left (655619) — € 10.96",
  },
  {
    q: "How much has Plant A lost this year?",
    a: "Year-to-date financial loss across all 65 inverters: € 37,259. The two critical inverters (02.03.019 and 03.12.044) account for 58% of total losses. Immediate maintenance on these two units could recover approximately € 21,841 annually.",
  },
];

function answerFor(question: string): string {
  const q = question.toLowerCase();
  const match = PRESET_QA.find((p) => q.includes(p.q.toLowerCase().slice(0, 14)));
  if (match) return match.a;
  if (q.includes("worst") || q.includes("worst performer")) return PRESET_QA[0].a;
  if (q.includes("loss") && q.includes("today")) return PRESET_QA[1].a;
  if (q.includes("overtemp")) return PRESET_QA[2].a;
  if (q.includes("year")) return PRESET_QA[3].a;
  return "I track all 65 inverters in Plant A. Try one of the suggested questions, or ask about a specific inverter, error code, or time range.";
}

function ChatAssistant() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      role: "assistant",
      content:
        "Hello! I monitor all 65 inverters in real time. Current status: 6 anomalies detected, total loss € 102.08 today. How can I help?",
    },
  ]);

  function send(text: string) {
    const t = text.trim();
    if (!t) return;
    setMessages((m) => [...m, { role: "user", content: t }, { role: "assistant", content: answerFor(t) }]);
    setInput("");
  }

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 ring-1 ring-primary/40 transition hover:scale-105"
          aria-label="Open Plant AI Assistant"
        >
          <Zap className="h-6 w-6" />
        </button>
      )}
      {open && (
        <div className="fixed bottom-6 right-6 z-40 flex h-[560px] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
          <div className="flex items-center justify-between border-b border-border bg-background/40 px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
                <Zap className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-tight">Plant AI Assistant</p>
                <p className="text-[11px] text-muted-foreground">Ask me anything about Plant A</p>
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "flex",
                  m.role === "user" ? "justify-end" : "justify-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[85%] whitespace-pre-line rounded-lg px-3 py-2 text-sm",
                    m.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-foreground",
                  )}
                >
                  {m.role === "assistant" && (
                    <span className="mr-1">🤖</span>
                  )}
                  {m.content}
                </div>
              </div>
            ))}
            {messages.length <= 1 && (
              <div className="space-y-2 pt-2">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Suggested
                </p>
                <div className="flex flex-wrap gap-2">
                  {PRESET_QA.map((p) => (
                    <button
                      key={p.q}
                      onClick={() => send(p.q)}
                      className="rounded-full border border-border bg-background/40 px-3 py-1 text-xs text-foreground hover:border-primary/50 hover:text-primary"
                    >
                      {p.q}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-center gap-2 border-t border-border bg-background/40 p-3"
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your question..."
              className="h-9 flex-1"
            />
            <button
              type="submit"
              className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
              aria-label="Send"
            >
              →
            </button>
          </form>
        </div>
      )}
    </>
  );
}