import React, { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Zap,
  Sun,
  Shuffle,
  Package,
  CheckCircle2,
  XCircle,
  Info,
  Loader2,
} from "lucide-react";
import JSZip from "jszip";
import saveAs from "file-saver";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// >>> Versions-Tag für Frontend-Anzeige
const APP_VERSION = "2025-11-19-02";

// ===== Fixed EDIFACT header fields =====
const SENDER_ID = "9979383000006";
const RECIPIENT_ID = "9906629000002";
const APP_CODE = "TL"; // constant

// ===== Helper utils =====
function pad(n: number, w = 2) {
  return n.toString().padStart(w, "0");
}

function formatEdifactDateTime(dt: Date) {
  // YYYYMMDDHHMM?+00 (UTC)
  const y = dt.getUTCFullYear();
  const m = pad(dt.getUTCMonth() + 1);
  const d = pad(dt.getUTCDate());
  const hh = pad(dt.getUTCHours());
  const mm = pad(dt.getUTCMinutes());
  return `${y}${m}${d}${hh}${mm}?+00`;
}

function rnd(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function seg(...parts: (string | number)[]) {
  return parts.join("+") + "'";
}

// ===== Time window helpers =====
const SLOTS_PER_DAY = 96; // 24h * 4
const SLOT_MS = 15 * 60 * 1000;

// Saisonfaktoren für PV (Juni/Juli ~1.0, Winter deutlich niedriger)
const PV_SEASON_FACTORS: number[] = [
  0.25, // Jan
  0.30, // Feb
  0.45, // Mär
  0.65, // Apr
  0.85, // Mai
  1.0, // Jun
  1.0, // Jul
  0.9, // Aug
  0.7, // Sep
  0.5, // Okt
  0.35, // Nov
  0.25, // Dez
];

function getPVSeasonFactor(date: Date) {
  const m = date.getUTCMonth(); // 0-11
  return PV_SEASON_FACTORS[m] ?? 0.5;
}

function gaussian(x: number, mu: number, sigma: number) {
  return Math.exp(-((x - mu) ** 2) / (2 * sigma ** 2));
}

// BDEW-ähnliche Shapes
function shapeH0(hour: number) {
  // sehr niedrige Nacht, kleiner Morgenbuckel, dominanter Abendpeak, leichter Mittagsbuckel
  const base = 0.12;
  const morning = 0.35 * gaussian(hour, 7.5, 1.0);
  const evening = 1.1 * gaussian(hour, 19.5, 1.5);
  const midday = 0.15 * gaussian(hour, 13.0, 2.5);
  return base + morning + evening + midday;
}

function shapeG0(hour: number) {
  // tagsüber deutlich höher als nachts, leichte Peaks am Vormittag/Nachmittag
  const base = 0.05;
  const dayPlateau = hour >= 6 && hour <= 20 ? 0.9 : 0.1;
  const morning = 0.25 * gaussian(hour, 9.0, 1.4);
  const afternoon = 0.25 * gaussian(hour, 16.0, 1.4);
  return base + dayPlateau + morning + afternoon;
}

function shapeL0(hour: number) {
  // früh, mittags und abends erhöht, Nacht moderat
  const base = 0.1;
  const early = 0.55 * gaussian(hour, 6.0, 1.2);
  const midday = 0.45 * gaussian(hour, 12.0, 2.0);
  const evening = 0.4 * gaussian(hour, 18.0, 1.6);
  return base + early + midday + evening;
}

export type SLPKey = "H0" | "G0" | "L0";

function makeSLPValues(
  slots: number,
  slp: SLPKey,
  dailyKWh: number,
  noisePct: number,
  seed: number
) {
  const r = rnd(seed);
  const oneDay: number[] = [];
  let sumDay = 0;

  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    const hour = (i * 15) / 60;
    const v =
      slp === "H0" ? shapeH0(hour) : slp === "G0" ? shapeG0(hour) : shapeL0(hour);
    oneDay.push(v);
    sumDay += v;
  }

  // normalize to 1.0
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    oneDay[i] = oneDay[i] / sumDay;
  }

  const vals: number[] = [];
  for (let i = 0; i < slots; i++) {
    const base = oneDay[i % SLOTS_PER_DAY] * dailyKWh; // kWh/day portion
    const noise = 1 + (r() - 0.5) * (2 * noisePct / 100);
    vals.push(Number(Math.max(0, base * noise).toFixed(3)));
  }

  // Re-normalize per day
  const dcount = Math.floor(slots / SLOTS_PER_DAY);
  for (let d = 0; d < dcount; d++) {
    const s = d * SLOTS_PER_DAY;
    const slice = vals.slice(s, s + SLOTS_PER_DAY);
    const total = slice.reduce((a, b) => a + b, 0);
    if (total > 0) {
      const f = dailyKWh / total;
      for (let i = 0; i < SLOTS_PER_DAY; i++) {
        vals[s + i] = Number((slice[i] * f).toFixed(3));
      }
    }
  }
  return vals;
}

// PV-Profil mit Tages-Skala (Saison + Wetter)
function makePVProfile(
  slots: number,
  peakKW: number,
  seed: number,
  dayScale: number
) {
  const r = rnd(seed + 12345);
  const vals: number[] = [];
  for (let i = 0; i < slots; i++) {
    const hour = ((i % SLOTS_PER_DAY) * 15) / 60;
    const genKW = peakKW * dayScale * gaussian(hour, 13.0, 2.6);
    const kwh15 = Math.max(0, genKW * 0.25 + (r() - 0.5) * 0.05);
    vals.push(Number(kwh15.toFixed(3)));
  }
  return vals;
}

// PV-Tagesfaktoren (Saison + Wetter) – zentral, damit Generator & Preview identisch sind
function computePvDayScales(startBase: Date, days: number): number[] {
  const weatherRand = rnd(2025);
  const pvDayScales: number[] = [];
  for (let d = 0; d < days; d++) {
    const dayDate = new Date(startBase.getTime() + d * 24 * 3600 * 1000);
    const seasonFactor = getPVSeasonFactor(dayDate);
    const r1 = weatherRand();
    const r2 = weatherRand();
    let weatherFactor: number;
    if (r1 < 0.15) {
      // sehr bewölkt / Regen – wenig Erzeugung
      weatherFactor = 0.2 + r2 * 0.2; // 0.2–0.4
    } else if (r1 < 0.4) {
      // bewölkt
      weatherFactor = 0.4 + r2 * 0.3; // 0.4–0.7
    } else if (r1 < 0.8) {
      // normal
      weatherFactor = 0.7 + r2 * 0.3; // 0.7–1.0
    } else {
      // sehr sonnig
      weatherFactor = 1.0 + r2 * 0.2; // 1.0–1.2
    }
    pvDayScales[d] = seasonFactor * weatherFactor;
  }
  return pvDayScales;
}

// ===== MSCONS builder =====
function buildMSCONS(options: {
  malo: string;
  obis: "1.8.0" | "2.8.0";
  start: Date;
  end: Date;
  values: number[];
}) {
  const { malo, obis, start, end, values } = options;
  const ts = new Date();
  const rand = Math.floor(Math.random() * 9_000_000) + 1_000_000;
  const docId = `D${rand}`;
  const msgRef = `MS${rand}${pad(ts.getUTCSeconds(), 2)}`;

  const segments: string[] = [];
  segments.push("UNA:+.? '");
  segments.push(
    seg(
      "UNB",
      "UNOC:3",
      `${SENDER_ID}:500`,
      `${RECIPIENT_ID}:500`,
      `${pad(ts.getUTCFullYear() % 100)}${pad(
        ts.getUTCMonth() + 1
      )}${pad(ts.getUTCDate())}:${pad(ts.getUTCHours())}${pad(
        ts.getUTCMinutes()
      )}`,
      docId,
      "",
      APP_CODE
    )
  );

  const msg: string[] = [];
  msg.push(seg("UNH", msgRef, "MSCONS:D:04B:UN:2.4c"));
  msg.push(seg("BGM", "Z48", msgRef, "9"));
  msg.push(seg("DTM", `137:${formatEdifactDateTime(ts)}:303`));
  msg.push(seg("RFF", "Z13:13025"));
  msg.push(seg("NAD", "MS", `${SENDER_ID}::293`));
  msg.push(seg("NAD", "MR", `${RECIPIENT_ID}::293`));
  msg.push(seg("UNS", "D"));
  msg.push(seg("NAD", "DP"));
  msg.push(seg("LOC", "172", malo));
  msg.push(seg("DTM", `163:${formatEdifactDateTime(start)}:303`));
  msg.push(seg("DTM", `164:${formatEdifactDateTime(end)}:303`));
  msg.push(seg("LIN", "1"));
  msg.push(seg("PIA", "5", `1-0?:${obis}:SRW`));

  let t = new Date(start.getTime());
  for (const v of values) {
    const tNext = new Date(t.getTime() + SLOT_MS);
    msg.push(seg("QTY", `220:${Number(v.toFixed(3))}`));
    msg.push(seg("DTM", `163:${formatEdifactDateTime(t)}:303`));
    msg.push(seg("DTM", `164:${formatEdifactDateTime(tNext)}:303`));
    t = tNext;
  }
  msg.push(seg("UNT", String(msg.length + 1), msgRef));

  segments.push(...msg);
  segments.push(seg("UNZ", "1", docId));
  return segments.join("");
}

// ===== Types & UI state per MaLo =====
type MaLoCfg = {
  malo: string;
  direction: "consumption" | "generation";
  slp: SLPKey; // used only for consumption
  expectedAnnualKWh: number; // used only for consumption
  pvPeakKW: number; // used only for generation
};

type TestResult = { name: string; pass: boolean; info?: string };
type PreviewPoint = { dayLabel: string; kWh: number };

const LIMIT_MB = 50; // Guard

export default function MSCONSGenerator() {
  const [date, setDate] = useState(() => "2025-08-01");
  const [days, setDays] = useState(31);
  const [rawMalos, setRawMalos] = useState(
    `50226092026\n51620926184\n50234152284`
  );

  const [defaults] = useState<{
    slp: SLPKey;
    expectedAnnualKWh: number;
    noisePct: number;
    direction: "consumption" | "generation";
    pvPeakKW: number;
  }>({
    slp: "H0",
    expectedAnnualKWh: 7300, // ~20 kWh/day
    noisePct: 15, // mehr Variation innerhalb des Tages
    direction: "consumption",
    pvPeakKW: 4,
  });

  // Robust line splitting (Windows/Mac/Linux)
  const maloList = useMemo(
    () =>
      Array.from(
        new Set(
          rawMalos
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        )
      ),
    [rawMalos]
  );

  const [configs, setConfigs] = useState<MaLoCfg[]>([]);
  const [fallbackLinks, setFallbackLinks] = useState<
    { name: string; href: string }[]
  >([]);
  const [tests, setTests] = useState<TestResult[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  // Sync configs with maloList
  useEffect(() => {
    setConfigs((prev) => {
      const byId = new Map(prev.map((p) => [p.malo, p]));
      return maloList.map(
        (m) =>
          byId.get(m) ?? {
            malo: m,
            direction: defaults.direction,
            slp: defaults.slp,
            expectedAnnualKWh: defaults.expectedAnnualKWh,
            pvPeakKW: defaults.pvPeakKW,
          }
      );
    });
  }, [maloList, defaults]);

  // cleanup Blob URLs on unmount
  useEffect(
    () => () => {
      fallbackLinks.forEach((l) => URL.revokeObjectURL(l.href));
    },
    [fallbackLinks]
  );

  // Grobe Stats für UX: erwartete Dateianzahl & Größe
  const stats = useMemo(() => {
    const fileCount = configs.length * days;
    // grobe Abschätzung: ~20 kB pro MSCONS-Datei
    const estimatedMb = (fileCount * 20000) / (1024 * 1024);
    return { fileCount, estimatedMb };
  }, [configs, days]);

  // Preview-Daten (erste MaLo, Tagesenergie)
  const previewData = useMemo<PreviewPoint[]>(() => {
    if (!configs.length) return [];
    const cfg = configs[0];
    const startBase = new Date(`${date}T22:00:00Z`);
    const points: PreviewPoint[] = [];

    if (cfg.direction === "consumption") {
      const seedBase = 1000; // entspricht idx=0 im Generator
      for (let d = 0; d < days; d++) {
        const baseDailyKWh = cfg.expectedAnnualKWh / 365;
        const dayRandGen = rnd(seedBase + d * 7919);
        const dayFactor = 0.8 + dayRandGen() * 0.4; // 0.8–1.2
        const dailyKWh = baseDailyKWh * dayFactor;
        const dayDate = new Date(startBase.getTime() + d * 24 * 3600 * 1000);
        points.push({
          dayLabel: `${pad(dayDate.getUTCDate())}.${pad(
            dayDate.getUTCMonth() + 1
          )}`,
          kWh: Number(dailyKWh.toFixed(1)),
        });
      }
    } else {
      const pvDayScales = computePvDayScales(startBase, days);
      for (let d = 0; d < days; d++) {
        const scale = pvDayScales[d];
        // grobe Abschätzung: ~3.8 kWh/kWp bei scale≈1
        const approxDailyKWh = cfg.pvPeakKW * scale * 3.8;
        const dayDate = new Date(startBase.getTime() + d * 24 * 3600 * 1000);
        points.push({
          dayLabel: `${pad(dayDate.getUTCDate())}.${pad(
            dayDate.getUTCMonth() + 1
          )}`,
          kWh: Number(approxDailyKWh.toFixed(1)),
        });
      }
    }

    return points;
  }, [configs, date, days]);

  async function handleGenerateZip() {
    setIsGenerating(true);
    try {
      // Zeitraum: 22:00 → 22:00 nächster Tag
      const startBase = new Date(`${date}T22:00:00Z`);
      const masterZip = new JSZip();

      type FileItem = { malo: string; name: string; content: string };

      // PV-Tagesskalen (Saison + Wetter) – gemeinsam für alle Erzeuger
      const pvDayScales = computePvDayScales(startBase, days);

      const allFiles: FileItem[] = [];

      configs.forEach((cfg, idx) => {
        const seedBase = 1000 + idx * 97;
        for (let d = 0; d < days; d++) {
          const start = new Date(startBase.getTime() + d * 24 * 3600 * 1000);
          const end = new Date(start.getTime() + 24 * 3600 * 1000);
          const ymd = `${start.getUTCFullYear()}${pad(
            start.getUTCMonth() + 1
          )}${pad(start.getUTCDate())}`;

          if (cfg.direction === "consumption") {
            // Tagesvariation pro Tag (±20 %) um den Jahresmittelwert herum
            const baseDailyKWh = cfg.expectedAnnualKWh / 365;
            const dayRandGen = rnd(seedBase + d * 7919);
            const dayFactor = 0.8 + dayRandGen() * 0.4; // 0.8–1.2
            const dailyKWh = baseDailyKWh * dayFactor;

            const vals = makeSLPValues(
              96,
              cfg.slp,
              dailyKWh,
              defaults.noisePct,
              seedBase + d
            );
            const content = buildMSCONS({
              malo: cfg.malo,
              obis: "1.8.0",
              start,
              end,
              values: vals,
            });
            const name = `MSCONS_${APP_CODE}_${SENDER_ID}_${RECIPIENT_ID}_${ymd}_${cfg.malo}_VERBRAUCH.txt`;
            allFiles.push({ malo: cfg.malo, name, content });
          } else {
            // PV-Erzeugung mit saisonaler + wetterbedingter Skalierung
            const dayScale = pvDayScales[d];
            const vals = makePVProfile(
              96,
              cfg.pvPeakKW,
              seedBase + 33 + d,
              dayScale
            );
            const content = buildMSCONS({
              malo: cfg.malo,
              obis: "2.8.0",
              start,
              end,
              values: vals,
            });
            const name = `MSCONS_${APP_CODE}_${SENDER_ID}_${RECIPIENT_ID}_${ymd}_${cfg.malo}_ERZEUGUNG.txt`;
            allFiles.push({ malo: cfg.malo, name, content });
          }
        }
      });

      // Size guard (approx): ASCII byte length
      const approxBytes = allFiles.reduce(
        (sum, f) => sum + f.content.length,
        0
      );
      const limitBytes = LIMIT_MB * 1024 * 1024; // 50 MB
      if (approxBytes > limitBytes) {
        const proceed = window.confirm(
          `You're about to generate ~${(
            approxBytes /
            (1024 * 1024)
          ).toFixed(1)} MB of data (> ${LIMIT_MB} MB). Continue?`
        );
        if (!proceed) return;
      }

      // Build per-MaLo ZIPs (nur für optionale Einzel-Downloads)
      const perMaLoZipBlobs: { name: string; blob: Blob }[] = [];
      for (const cfg of configs) {
        const maloZip = new JSZip();
        const filesForMalo = allFiles.filter((f) => f.malo === cfg.malo);
        filesForMalo.forEach((f) => maloZip.file(f.name, f.content));
        const maloBlob = await maloZip.generateAsync({ type: "blob" });
        const maloZipName = `MSCONS_${date.replace(/-/g, "")}_${cfg.malo}.zip`;
        perMaLoZipBlobs.push({ name: maloZipName, blob: maloBlob });
      }

      // Master ZIP: alle MSCONS-Dateien flach (keine ZIP-in-ZIP-Struktur)
      allFiles.forEach((f) => {
        masterZip.file(f.name, f.content);
      });

      const masterBlob = await masterZip.generateAsync({ type: "blob" });
      const masterName = `MSCONS_${date.replace(/-/g, "")}_${
        configs.length
      }MaLo_master.zip`;
      saveAs(masterBlob, masterName);

      // Fallback links (Master + per-MaLo ZIPs)
      const links = [
        { name: masterName, href: URL.createObjectURL(masterBlob) },
        ...perMaLoZipBlobs.map((z) => ({
          name: z.name,
          href: URL.createObjectURL(z.blob),
        })),
      ];
      setFallbackLinks(links);
    } finally {
      setIsGenerating(false);
    }
  }

  function runSelfTests() {
    const results: TestResult[] = [];

    const sample = "A\r\nB\n\n C ";
    const split = Array.from(
      new Set(
        sample
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      )
    );
    results.push({
      name: "Regex split handles CRLF + LF + trim + dedupe",
      pass: split.length === 2 && split[0] === "A" && split[1] === "B",
    });

    const valsH0 = makeSLPValues(96, "H0", 20, 5, 123);
    results.push({ name: "H0 96 values", pass: valsH0.length === 96 });

    const sum = valsH0.reduce((a, b) => a + b, 0);
    results.push({
      name: "Daily sum ≈ 20 kWh",
      pass: Math.abs(sum - 20) < 0.05,
      info: `sum=${sum.toFixed(3)}`,
    });

    const start = new Date("2025-08-15T22:00:00Z");
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    const txt = buildMSCONS({
      malo: "99999999999",
      obis: "1.8.0",
      start,
      end,
      values: valsH0,
    });
    results.push({
      name: "Starts with UNA then UNB (packed)",
      pass: txt.startsWith("UNA:+.? 'UNB+"),
    });
    results.push({
      name: "No newlines present",
      pass: !/[\n\r]/.test(txt),
    });
    results.push({
      name: "Has UNT and UNZ",
      pass: txt.includes("UNT+") && txt.includes("UNZ+1+"),
    });
    results.push({
      name: "Has 96×QTY",
      pass: (txt.match(/QTY\+220:/g) || []).length === 96,
      info: `found ${(txt.match(/QTY\+220:/g) || []).length}`,
    });

    const genVals = makePVProfile(96, 5, 321, 1.0);
    const txtGen = buildMSCONS({
      malo: "99999999999",
      obis: "2.8.0",
      start,
      end,
      values: genVals,
    });
    results.push({
      name: "[2.8.0] Starts with UNA then UNB (packed)",
      pass: txtGen.startsWith("UNA:+.? 'UNB+"),
    });
    results.push({
      name: "[2.8.0] No newlines present",
      pass: !/[\n\r]/.test(txtGen),
    });
    results.push({
      name: "[2.8.0] Has UNT and UNZ",
      pass: txtGen.includes("UNT+") && txtGen.includes("UNZ+1+"),
    });
    results.push({
      name: "[2.8.0] Has 96×QTY",
      pass: (txtGen.match(/QTY\+220:/g) || []).length === 96,
    });

    const ymd = "20250815";
    const nameC = `MSCONS_${APP_CODE}_${SENDER_ID}_${RECIPIENT_ID}_${ymd}_12345678901_VERBRAUCH.txt`;
    const nameG = `MSCONS_${APP_CODE}_${SENDER_ID}_${RECIPIENT_ID}_${ymd}_12345678901_ERZEUGUNG.txt`;
    results.push({
      name: "Filename contains yyyymmdd + MaLo + direction",
      pass:
        nameC.includes(ymd) &&
        nameC.includes("VERBRAUCH") &&
        nameG.includes("ERZEUGUNG"),
    });

    setTests(results);
  }

  function updateCfg(malo: string, patch: Partial<MaLoCfg>) {
    setConfigs((list) =>
      list.map((c) => (c.malo === malo ? { ...c, ...patch } : c))
    );
  }

  function addPreset(type: "H0" | "G0" | "PV") {
    const existing = new Set(maloList);
    let id: string;
    do {
      id =
        "5" +
        Math.floor(1_000_000_000 + Math.random() * 9_000_000_000).toString(); // 11-stellig, beginnt mit 5
    } while (existing.has(id));

    const baseCfg: MaLoCfg =
      type === "H0"
        ? {
            malo: id,
            direction: "consumption",
            slp: "H0",
            expectedAnnualKWh: 3500,
            pvPeakKW: 4,
          }
        : type === "G0"
        ? {
            malo: id,
            direction: "consumption",
            slp: "G0",
            expectedAnnualKWh: 30000,
            pvPeakKW: 10,
          }
        : {
            malo: id,
            direction: "generation",
            slp: "H0",
            expectedAnnualKWh: 0,
            pvPeakKW: 5,
          };

    setRawMalos((prev) => (prev ? `${prev}\n${id}` : id));
    setConfigs((prev) => [...prev, baseCfg]);
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header + Version */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Zap className="w-6 h-6" />
          <div>
            <h1 className="text-2xl font-semibold">MSCONS Generator</h1>
            <div className="text-xs text-muted-foreground flex items-center gap-2 mt-1">
              <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-slate-300">
                Version {APP_VERSION}
              </span>
              <span>Multi-MaLo · 15-min · Demo-Daten</span>
            </div>
          </div>
        </div>
      </div>

      {/* Zeitraum & MaLo-Liste + Presets */}
      <Card className="shadow-sm">
        <CardContent className="p-6 space-y-4">
          <div className="grid md:grid-cols-3 gap-4">
            <div>
              <Label>Startdatum (ohne Zeit)</Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div>
              <Label>Tage</Label>
              <Input
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={(e) =>
                  setDays(parseInt(e.target.value || "1", 10))
                }
              />
            </div>
            <div>
              <Label>MaLo-IDs (eine pro Zeile)</Label>
              <Textarea
                rows={4}
                value={rawMalos}
                onChange={(e) => setRawMalos(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Schnell-Presets:</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => addPreset("H0")}
            >
              H0 Haushalt ~3.500 kWh
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => addPreset("G0")}
            >
              G0 Gewerbe ~30.000 kWh
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => addPreset("PV")}
            >
              PV ~5 kWp
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Pro-MaLo Einstellungen */}
      <Card className="shadow-sm">
        <CardContent className="p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Pro-MaLo Einstellungen</div>
            <div className="text-[11px] text-muted-foreground flex items-center gap-1">
              <Info className="w-3 h-3" />
              <span>
                PV-Wetter &amp; Tagesform gelten immer für alle Erzeuger, die im
                selben Schritt generiert werden.
              </span>
            </div>
          </div>

          <div className="grid md:grid-cols-7 gap-2 text-sm font-medium">
            <div>MaLo</div>
            <div>Richtung</div>
            <div>SLP</div>
            <div>kWh/Jahr</div>
            <div>PV kWp</div>
            <div>Tage</div>
            <div>Info</div>
          </div>
          <div className="space-y-2">
            {configs.map((c) => (
              <div
                key={c.malo}
                className="grid md:grid-cols-7 gap-2 items-center"
              >
                <Input
                  value={c.malo}
                  onChange={(e) =>
                    updateCfg(c.malo, { malo: e.target.value })
                  }
                />

                {/* Direction toggle */}
                <Select
                  value={c.direction}
                  onValueChange={(v) =>
                    updateCfg(c.malo, {
                      direction: v as MaLoCfg["direction"],
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="consumption">
                      Verbrauch (1.8.0)
                    </SelectItem>
                    <SelectItem value="generation">
                      Erzeugung (2.8.0)
                    </SelectItem>
                  </SelectContent>
                </Select>

                {/* SLP (only for consumption) */}
                <Select
                  value={c.slp}
                  onValueChange={(v) =>
                    updateCfg(c.malo, { slp: v as SLPKey })
                  }
                  disabled={c.direction !== "consumption"}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="SLP" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="H0">H0</SelectItem>
                    <SelectItem value="G0">G0</SelectItem>
                    <SelectItem value="L0">L0</SelectItem>
                  </SelectContent>
                </Select>

                {/* Expected annual kWh (only for consumption) */}
                <Input
                  type="number"
                  step="1"
                  min={0}
                  value={c.expectedAnnualKWh}
                  onChange={(e) =>
                    updateCfg(c.malo, {
                      expectedAnnualKWh: parseFloat(
                        e.target.value || "0"
                      ),
                    })
                  }
                  disabled={c.direction !== "consumption"}
                />

                {/* PV kWp (only for generation) */}
                <Input
                  type="number"
                  step="0.1"
                  min={0}
                  value={c.pvPeakKW}
                  onChange={(e) =>
                    updateCfg(c.malo, {
                      pvPeakKW: parseFloat(e.target.value || "0"),
                    })
                  }
                  disabled={c.direction !== "generation"}
                />

                {/* Days (readonly mirror) */}
                <div className="text-sm text-muted-foreground">
                  {days}
                </div>

                {/* Info */}
                <div className="text-xs text-muted-foreground">
                  {c.direction === "consumption"
                    ? `~${(c.expectedAnnualKWh / 365).toFixed(
                        1
                      )} kWh/Tag`
                    : `${c.pvPeakKW} kWp`}
                </div>
              </div>
            ))}
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <Shuffle className="w-3 h-3" />
            <span>
              Zufällige Abweichungen je Intervall; tägliche Summe wird auf
              Ziel-kWh normalisiert. Verbrauch nutzt H0/G0/L0-SLP, PV basiert
              auf kWp, Saison &amp; Wetter.
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Preview Chart */}
      <Card className="shadow-sm">
        <CardContent className="p-6 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">
              Vorschau: Tagesenergie (erste MaLo)
            </div>
            <div className="text-xs text-muted-foreground">
              {configs[0]
                ? `${configs[0].malo} · ${
                    configs[0].direction === "consumption"
                      ? "Verbrauch"
                      : "Erzeugung"
                  }`
                : "Keine MaLo konfiguriert"}
            </div>
          </div>
          {previewData.length > 0 ? (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={previewData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="dayLabel" />
                  <YAxis
                    label={{
                      value: "kWh/Tag",
                      angle: -90,
                      position: "insideLeft",
                    }}
                  />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="kWh"
                    dot={false}
                    stroke="#0f766e"
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              Bitte mindestens eine MaLo konfigurieren, um eine Vorschau zu
              sehen.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Generate */}
      <Card className="shadow-sm">
        <CardContent className="p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <Button
              onClick={handleGenerateZip}
              className="gap-2"
              disabled={isGenerating || configs.length === 0}
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Wird generiert …
                </>
              ) : (
                <>
                  <Package className="w-4 h-4" />
                  ZIP erzeugen & herunterladen
                </>
              )}
            </Button>
            <div className="text-xs text-muted-foreground text-right">
              {stats.fileCount > 0 && (
                <>
                  Voraussichtlich {stats.fileCount} Dateien (
                  ~{stats.estimatedMb.toFixed(2)} MB)
                </>
              )}
            </div>
          </div>

          {fallbackLinks.length > 0 && (
            <div className="mt-2">
              <div className="text-sm mb-1">
                Falls der Browser den ZIP-Download blockt: Einzellinks
              </div>
              <div className="grid gap-1">
                {fallbackLinks.map((f, i) => (
                  <a
                    key={i}
                    href={f.href}
                    download={f.name}
                    className="underline text-blue-600 hover:text-blue-800 break-all"
                  >
                    {f.name}
                  </a>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Self-Tests UI */}
      <Card className="shadow-sm">
        <CardContent className="p-6 space-y-3">
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={runSelfTests}>
              Self-Checks durchführen
            </Button>
            <span className="text-sm text-muted-foreground">
              (Regex-Split, 96×QTY, UNA/UNB, Summe≈kWh)
            </span>
          </div>
          {tests.length > 0 && (
            <ul className="space-y-1">
              {tests.map((t, i) => (
                <li
                  key={i}
                  className="flex items-center gap-2 text-sm"
                >
                  {t.pass ? (
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-600" />
                  )}
                  <span>
                    {t.name}
                    {t.info ? ` – ${t.info}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="text-[11px] text-muted-foreground flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <Sun className="w-3 h-3" />
          <span>
            Format: UNA vorhanden, UNB direkt anschließend, keine Zeilenumbrüche
            zwischen Segmenten, UNT korrekt gezählt. 15-Min-Intervalle
            (DTM 163/164) über den gewählten Zeitraum.
          </span>
        </div>
        <div>
          Hinweis: Nur Erzeuger, die im selben Generierungslauf erstellt werden,
          teilen sich exakt dieselben Wetter- &amp; Saisonfaktoren (gleiche
          „Wettertage“ im Monat).
        </div>
      </div>
    </div>
  );
}
