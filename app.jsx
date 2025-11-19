const { useState, useEffect, useMemo } = React;

// ===== Fixed EDIFACT header fields =====
const SENDER_ID = "9979383000006";
const RECIPIENT_ID = "9906629000002";
const APP_CODE = "TL"; // constant
const APP_VERSION = "2025-11-19-02";
const LIMIT_MB = 50; // Size guard

// ===== Helper utils =====
function pad(n, w = 2) {
  return n.toString().padStart(w, "0");
}

function formatEdifactDateTime(dt) {
  // YYYYMMDDHHMM?+00 (UTC)
  const y = dt.getUTCFullYear();
  const m = pad(dt.getUTCMonth() + 1);
  const d = pad(dt.getUTCDate());
  const hh = pad(dt.getUTCHours());
  const mm = pad(dt.getUTCMinutes());
  return `${y}${m}${d}${hh}${mm}?+00`;
}

function rnd(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function seg() {
  return Array.from(arguments).join("+") + "'";
}

// ===== Time window helpers =====
const SLOTS_PER_DAY = 96; // 24h * 4
const SLOT_MS = 15 * 60 * 1000;

// Saisonfaktoren für PV (Juni/Juli ~1.0, Winter deutlich niedriger)
const PV_SEASON_FACTORS = [
  0.25, // Jan
  0.3, // Feb
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

function getPVSeasonFactor(date) {
  const m = date.getUTCMonth(); // 0-11
  return PV_SEASON_FACTORS[m] || 0.5;
}

// ===== SLP Shapes (normalized per day, later scaled) =====
function gaussian(x, mu, sigma) {
  return Math.exp(-((x - mu) ** 2) / (2 * sigma ** 2));
}

// BDEW-ähnliche Shapes
function shapeH0(hour) {
  const base = 0.12;
  const morning = 0.35 * gaussian(hour, 7.5, 1.0);
  const evening = 1.1 * gaussian(hour, 19.5, 1.5);
  const midday = 0.15 * gaussian(hour, 13.0, 2.5);
  return base + morning + evening + midday;
}

function shapeG0(hour) {
  const base = 0.05;
  const dayPlateau = hour >= 6 && hour <= 20 ? 0.9 : 0.1;
  const morning = 0.25 * gaussian(hour, 9.0, 1.4);
  const afternoon = 0.25 * gaussian(hour, 16.0, 1.4);
  return base + dayPlateau + morning + afternoon;
}

function shapeL0(hour) {
  const base = 0.1;
  const early = 0.55 * gaussian(hour, 6.0, 1.2);
  const midday = 0.45 * gaussian(hour, 12.0, 2.0);
  const evening = 0.4 * gaussian(hour, 18.0, 1.6);
  return base + early + midday + evening;
}

function makeSLPValues(slots, slp, dailyKWh, noisePct, seed) {
  const r = rnd(seed);
  const oneDay = [];
  let sumDay = 0;

  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    const hour = (i * 15) / 60;
    let v;
    if (slp === "H0") v = shapeH0(hour);
    else if (slp === "G0") v = shapeG0(hour);
    else v = shapeL0(hour);
    oneDay.push(v);
    sumDay += v;
  }

  // normalize to 1.0
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    oneDay[i] = oneDay[i] / sumDay;
  }

  const vals = [];
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
function makePVProfile(slots, peakKW, seed, dayScale) {
  const r = rnd(seed + 12345);
  const vals = [];
  for (let i = 0; i < slots; i++) {
    const hour = ((i % SLOTS_PER_DAY) * 15) / 60;
    const genKW = peakKW * dayScale * gaussian(hour, 13.0, 2.6);
    const kwh15 = Math.max(0, genKW * 0.25 + (r() - 0.5) * 0.05);
    vals.push(Number(kwh15.toFixed(3)));
  }
  return vals;
}

// PV-Tagesfaktoren (Saison + Wetter) – zentral, damit Generator & Preview identisch sind
function computePvDayScales(startBase, days) {
  const weatherRand = rnd(2025);
  const pvDayScales = [];
  for (let d = 0; d < days; d++) {
    const dayDate = new Date(startBase.getTime() + d * 24 * 3600 * 1000);
    const seasonFactor = getPVSeasonFactor(dayDate);
    const r1 = weatherRand();
    const r2 = weatherRand();
    let weatherFactor;
    if (r1 < 0.15) {
      weatherFactor = 0.2 + r2 * 0.2; // 0.2–0.4
    } else if (r1 < 0.4) {
      weatherFactor = 0.4 + r2 * 0.3; // 0.4–0.7
    } else if (r1 < 0.8) {
      weatherFactor = 0.7 + r2 * 0.3; // 0.7–1.0
    } else {
      weatherFactor = 1.0 + r2 * 0.2; // 1.0–1.2
    }
    pvDayScales[d] = seasonFactor * weatherFactor;
  }
  return pvDayScales;
}

// ===== MSCONS builder =====
function buildMSCONS(options) {
  const malo = options.malo;
  const obis = options.obis;
  const start = options.start;
  const end = options.end;
  const values = options.values;

  const ts = new Date();
  const rand = Math.floor(Math.random() * 9000000) + 1000000;
  const docId = `D${rand}`;
  const msgRef = `MS${rand}${pad(ts.getUTCSeconds(), 2)}`;

  const segments = [];
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

  const msg = [];
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

  segments.push.apply(segments, msg);
  segments.push(seg("UNZ", "1", docId));
  return segments.join("");
}

// ===== React App =====

function MSCONSGenerator() {
  const [date, setDate] = useState("2025-08-01");
  const [days, setDays] = useState(31);
  const [rawMalos, setRawMalos] = useState(
    "50226092026\n51620926184\n50234152284"
  );

  const [defaults] = useState({
    slp: "H0",
    expectedAnnualKWh: 7300, // ~20 kWh/day
    noisePct: 15,
    direction: "consumption",
    pvPeakKW: 4,
  });

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

  const [configs, setConfigs] = useState([]);
  const [fallbackLinks, setFallbackLinks] = useState([]);
  const [tests, setTests] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);

  // Sync configs with maloList
  useEffect(
    () => {
      setConfigs((prev) => {
        const byId = new Map(prev.map((p) => [p.malo, p]));
        return maloList.map((m) =>
          byId.get(m) || {
            malo: m,
            direction: defaults.direction,
            slp: defaults.slp,
            expectedAnnualKWh: defaults.expectedAnnualKWh,
            pvPeakKW: defaults.pvPeakKW,
          }
        );
      });
    },
    [maloList, defaults]
  );

  // cleanup Blob URLs on unmount
  useEffect(
    () => {
      return () => {
        fallbackLinks.forEach((l) => URL.revokeObjectURL(l.href));
      };
    },
    [fallbackLinks]
  );

  // Grobe Stats für UX: erwartete Dateianzahl & Größe
  const stats = useMemo(
    () => {
      const fileCount = configs.length * days;
      const estimatedMb = (fileCount * 20000) / (1024 * 1024);
      return { fileCount, estimatedMb };
    },
    [configs, days]
  );

  // Preview-Daten (erste MaLo, Tagesenergie)
  const previewData = useMemo(
    () => {
      if (!configs.length) return [];
      const cfg = configs[0];
      const startBase = new Date(date + "T22:00:00Z");
      const points = [];

      if (cfg.direction === "consumption") {
        const seedBase = 1000;
        for (let d = 0; d < days; d++) {
          const baseDailyKWh = cfg.expectedAnnualKWh / 365;
          const dayRandGen = rnd(seedBase + d * 7919);
          const dayFactor = 0.8 + dayRandGen() * 0.4; // 0.8–1.2
          const dailyKWh = baseDailyKWh * dayFactor;
          const dayDate = new Date(startBase.getTime() + d * 24 * 3600 * 1000);
          points.push({
            dayLabel:
              pad(dayDate.getUTCDate()) +
              "." +
              pad(dayDate.getUTCMonth() + 1),
            kWh: Number(dailyKWh.toFixed(1)),
          });
        }
      } else {
        const pvDayScales = computePvDayScales(startBase, days);
        for (let d = 0; d < days; d++) {
          const scale = pvDayScales[d];
          const approxDailyKWh = cfg.pvPeakKW * scale * 3.8;
          const dayDate = new Date(startBase.getTime() + d * 24 * 3600 * 1000);
          points.push({
            dayLabel:
              pad(dayDate.getUTCDate()) +
              "." +
              pad(dayDate.getUTCMonth() + 1),
            kWh: Number(approxDailyKWh.toFixed(1)),
          });
        }
      }

      return points;
    },
    [configs, date, days]
  );

  async function handleGenerateZip() {
    setIsGenerating(true);
    try {
      const startBase = new Date(date + "T22:00:00Z");
      const masterZip = new JSZip();

      const pvDayScales = computePvDayScales(startBase, days);
      const allFiles = [];

      configs.forEach((cfg, idx) => {
        const seedBase = 1000 + idx * 97;
        for (let d = 0; d < days; d++) {
          const start = new Date(startBase.getTime() + d * 24 * 3600 * 1000);
          const end = new Date(start.getTime() + 24 * 3600 * 1000);
          const ymd =
            start.getUTCFullYear() +
            pad(start.getUTCMonth() + 1) +
            pad(start.getUTCDate());

          if (cfg.direction === "consumption") {
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
              start: start,
              end: end,
              values: vals,
            });
            const name =
              "MSCONS_" +
              APP_CODE +
              "_" +
              SENDER_ID +
              "_" +
              RECIPIENT_ID +
              "_" +
              ymd +
              "_" +
              cfg.malo +
              "_VERBRAUCH.txt";
            allFiles.push({ malo: cfg.malo, name: name, content: content });
          } else {
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
              start: start,
              end: end,
              values: vals,
            });
            const name =
              "MSCONS_" +
              APP_CODE +
              "_" +
              SENDER_ID +
              "_" +
              RECIPIENT_ID +
              "_" +
              ymd +
              "_" +
              cfg.malo +
              "_ERZEUGUNG.txt";
            allFiles.push({ malo: cfg.malo, name: name, content: content });
          }
        }
      });

      const approxBytes = allFiles.reduce(
        (sum, f) => sum + f.content.length,
        0
      );
      const limitBytes = LIMIT_MB * 1024 * 1024;
      if (approxBytes > limitBytes) {
        const proceed = window.confirm(
          "You're about to generate ~" +
            (approxBytes / (1024 * 1024)).toFixed(1) +
            " MB of data (> " +
            LIMIT_MB +
            " MB). Continue?"
        );
        if (!proceed) {
          setIsGenerating(false);
          return;
        }
      }

      const perMaLoZipBlobs = [];
      for (const cfg of configs) {
        const maloZip = new JSZip();
        const filesForMalo = allFiles.filter((f) => f.malo === cfg.malo);
        filesForMalo.forEach((f) => maloZip.file(f.name, f.content));
        const maloBlob = await maloZip.generateAsync({ type: "blob" });
        const maloZipName =
          "MSCONS_" + date.replace(/-/g, "") + "_" + cfg.malo + ".zip";
        perMaLoZipBlobs.push({ name: maloZipName, blob: maloBlob });
      }

      allFiles.forEach((f) => {
        masterZip.file(f.name, f.content);
      });

      const masterBlob = await masterZip.generateAsync({ type: "blob" });
      const masterName =
        "MSCONS_" +
        date.replace(/-/g, "") +
        "_" +
        configs.length +
        "MaLo_master.zip";
      saveAs(masterBlob, masterName);

      const links = [
        { name: masterName, href: URL.createObjectURL(masterBlob) },
      ].concat(
        perMaLoZipBlobs.map((z) => ({
          name: z.name,
          href: URL.createObjectURL(z.blob),
        }))
      );
      setFallbackLinks(links);
    } finally {
      setIsGenerating(false);
    }
  }

  function runSelfTests() {
    const results = [];

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
      info: "sum=" + sum.toFixed(3),
    });

    const start = new Date("2025-08-15T22:00:00Z");
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    const txt = buildMSCONS({
      malo: "99999999999",
      obis: "1.8.0",
      start: start,
      end: end,
      values: valsH0,
    });
    results.push({
      name: "Starts with UNA then UNB (packed)",
      pass: txt.indexOf("UNA:+.? 'UNB+") === 0,
    });
    results.push({
      name: "No newlines present",
      pass: !/[\n\r]/.test(txt),
    });
    results.push({
      name: "Has UNT and UNZ",
      pass: txt.indexOf("UNT+") !== -1 && txt.indexOf("UNZ+1+") !== -1,
    });
    results.push({
      name: "Has 96×QTY",
      pass: (txt.match(/QTY\+220:/g) || []).length === 96,
      info:
        "found " + (txt.match(/QTY\+220:/g) || []).length.toString(),
    });

    const genVals = makePVProfile(96, 5, 321, 1.0);
    const txtGen = buildMSCONS({
      malo: "99999999999",
      obis: "2.8.0",
      start: start,
      end: end,
      values: genVals,
    });
    results.push({
      name: "[2.8.0] Starts with UNA then UNB (packed)",
      pass: txtGen.indexOf("UNA:+.? 'UNB+") === 0,
    });
    results.push({
      name: "[2.8.0] No newlines present",
      pass: !/[\n\r]/.test(txtGen),
    });
    results.push({
      name: "[2.8.0] Has UNT and UNZ",
      pass:
        txtGen.indexOf("UNT+") !== -1 &&
        txtGen.indexOf("UNZ+1+") !== -1,
    });
    results.push({
      name: "[2.8.0] Has 96×QTY",
      pass: (txtGen.match(/QTY\+220:/g) || []).length === 96,
    });

    const ymd = "20250815";
    const nameC =
      "MSCONS_" +
      APP_CODE +
      "_" +
      SENDER_ID +
      "_" +
      RECIPIENT_ID +
      "_" +
      ymd +
      "_12345678901_VERBRAUCH.txt";
    const nameG =
      "MSCONS_" +
      APP_CODE +
      "_" +
      SENDER_ID +
      "_" +
      RECIPIENT_ID +
      "_" +
      ymd +
      "_12345678901_ERZEUGUNG.txt";
    results.push({
      name: "Filename contains yyyymmdd + MaLo + direction",
      pass:
        nameC.indexOf(ymd) !== -1 &&
        nameC.indexOf("VERBRAUCH") !== -1 &&
        nameG.indexOf("ERZEUGUNG") !== -1,
    });

    setTests(results);
  }

  function updateCfg(malo, patch) {
    setConfigs((list) =>
      list.map((c) => (c.malo === malo ? Object.assign({}, c, patch) : c))
    );
  }

  function addPreset(type) {
    const existing = new Set(maloList);
    let id;
    do {
      id =
        "5" +
        Math.floor(
          1000000000 + Math.random() * 9000000000
        ).toString();
    } while (existing.has(id));

    let baseCfg;
    if (type === "H0") {
      baseCfg = {
        malo: id,
        direction: "consumption",
        slp: "H0",
        expectedAnnualKWh: 3500,
        pvPeakKW: 4,
      };
    } else if (type === "G0") {
      baseCfg = {
        malo: id,
        direction: "consumption",
        slp: "G0",
        expectedAnnualKWh: 30000,
        pvPeakKW: 10,
      };
    } else {
      baseCfg = {
        malo: id,
        direction: "generation",
        slp: "H0",
        expectedAnnualKWh: 0,
        pvPeakKW: 5,
      };
    }

    setRawMalos((prev) => (prev ? prev + "\n" + id : id));
    setConfigs((prev) => prev.concat([baseCfg]));
  }

  // Optional: Recharts aus globalem Namespace holen, falls vorhanden
  const Recharts = window.Recharts || {};
  const LineChart = Recharts.LineChart;
  const Line = Recharts.Line;
  const XAxis = Recharts.XAxis;
  const YAxis = Recharts.YAxis;
  const CartesianGrid = Recharts.CartesianGrid;
  const Tooltip = Recharts.Tooltip;
  const ResponsiveContainer = Recharts.ResponsiveContainer;

  return (
    <div className="app-wrapper" style={{ fontFamily: "system-ui, sans-serif", padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
        <div>
          <h1 style={{ fontSize: "24px", margin: 0 }}>MSCONS Generator</h1>
          <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "4px", display: "flex", gap: "8px", alignItems: "center" }}>
            <span style={{ border: "1px solid #d1d5db", borderRadius: "999px", padding: "2px 8px" }}>
              Version {APP_VERSION}
            </span>
            <span>Multi-MaLo · 15-min · Demo-Daten</span>
          </div>
        </div>
      </div>

      {/* Zeitraum & MaLo */}
      <div style={{ background: "white", borderRadius: "12px", border: "1px solid #e5e7eb", padding: "16px", marginBottom: "16px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: "12px" }}>
          <div>
            <label style={{ fontSize: "12px", display: "block", marginBottom: "4px" }}>Startdatum (ohne Zeit)</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #d1d5db" }}
            />
          </div>
          <div>
            <label style={{ fontSize: "12px", display: "block", marginBottom: "4px" }}>Tage</label>
            <input
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) =>
                setDays(parseInt(e.target.value || "1", 10))
              }
              style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #d1d5db" }}
            />
          </div>
          <div>
            <label style={{ fontSize: "12px", display: "block", marginBottom: "4px" }}>MaLo-IDs (eine pro Zeile)</label>
            <textarea
              rows={4}
              value={rawMalos}
              onChange={(e) => setRawMalos(e.target.value)}
              style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #d1d5db", resize: "vertical" }}
            />
          </div>
        </div>

        <div style={{ marginTop: "8px", fontSize: "11px", display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
          <span style={{ color: "#6b7280" }}>Schnell-Presets:</span>
          <button
            type="button"
            onClick={() => addPreset("H0")}
            style={{ fontSize: "11px", padding: "3px 8px", borderRadius: "999px", border: "1px solid #d1d5db", background: "white", cursor: "pointer" }}
          >
            H0 Haushalt ~3.500 kWh
          </button>
          <button
            type="button"
            onClick={() => addPreset("G0")}
            style={{ fontSize: "11px", padding: "3px 8px", borderRadius: "999px", border: "1px solid #d1d5db", background: "white", cursor: "pointer" }}
          >
            G0 Gewerbe ~30.000 kWh
          </button>
          <button
            type="button"
            onClick={() => addPreset("PV")}
            style={{ fontSize: "11px", padding: "3px 8px", borderRadius: "999px", border: "1px solid #d1d5db", background: "white", cursor: "pointer" }}
          >
            PV ~5 kWp
          </button>
        </div>
      </div>

      {/* Pro-MaLo Einstellungen */}
      <div style={{ background: "white", borderRadius: "12px", border: "1px solid #e5e7eb", padding: "16px", marginBottom: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
          <div style={{ fontSize: "14px", fontWeight: 500 }}>Pro-MaLo Einstellungen</div>
          <div style={{ fontSize: "11px", color: "#6b7280" }}>
            PV-Wetter &amp; Tagesform gelten immer für alle Erzeuger, die im selben Schritt generiert werden.
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7,minmax(0,1fr))",
            gap: "4px",
            fontSize: "12px",
            fontWeight: 500,
            marginBottom: "4px",
          }}
        >
          <div>MaLo</div>
          <div>Richtung</div>
          <div>SLP</div>
          <div>kWh/Jahr</div>
          <div>PV kWp</div>
          <div>Tage</div>
          <div>Info</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {configs.map((c) => (
            <div
              key={c.malo}
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(7,minmax(0,1fr))",
                gap: "4px",
                alignItems: "center",
              }}
            >
              <input
                value={c.malo}
                onChange={(e) => updateCfg(c.malo, { malo: e.target.value })}
                style={{ padding: "4px 6px", borderRadius: "6px", border: "1px solid #d1d5db", fontSize: "12px" }}
              />

              <select
                value={c.direction}
                onChange={(e) => updateCfg(c.malo, { direction: e.target.value })}
                style={{ padding: "4px 6px", borderRadius: "6px", border: "1px solid #d1d5db", fontSize: "12px" }}
              >
                <option value="consumption">Verbrauch (1.8.0)</option>
                <option value="generation">Erzeugung (2.8.0)</option>
              </select>

              <select
                value={c.slp}
                onChange={(e) => updateCfg(c.malo, { slp: e.target.value })}
                disabled={c.direction !== "consumption"}
                style={{ padding: "4px 6px", borderRadius: "6px", border: "1px solid #d1d5db", fontSize: "12px" }}
              >
                <option value="H0">H0</option>
                <option value="G0">G0</option>
                <option value="L0">L0</option>
              </select>

              <input
                type="number"
                min={0}
                step="1"
                value={c.expectedAnnualKWh}
                onChange={(e) =>
                  updateCfg(c.malo, {
                    expectedAnnualKWh: parseFloat(e.target.value || "0"),
                  })
                }
                disabled={c.direction !== "consumption"}
                style={{ padding: "4px 6px", borderRadius: "6px", border: "1px solid #d1d5db", fontSize: "12px" }}
              />

              <input
                type="number"
                min={0}
                step="0.1"
                value={c.pvPeakKW}
                onChange={(e) =>
                  updateCfg(c.malo, {
                    pvPeakKW: parseFloat(e.target.value || "0"),
                  })
                }
                disabled={c.direction !== "generation"}
                style={{ padding: "4px 6px", borderRadius: "6px", border: "1px solid #d1d5db", fontSize: "12px" }}
              />

              <div style={{ fontSize: "12px", color: "#6b7280" }}>{days}</div>

              <div style={{ fontSize: "11px", color: "#6b7280" }}>
                {c.direction === "consumption"
                  ? "~" + (c.expectedAnnualKWh / 365).toFixed(1) + " kWh/Tag"
                  : c.pvPeakKW + " kWp"}
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: "8px", fontSize: "11px", color: "#6b7280" }}>
          Zufällige Abweichungen je Intervall; tägliche Summe wird auf Ziel-kWh normalisiert.
          Verbrauch nutzt H0/G0/L0-SLP, PV basiert auf kWp, Saison &amp; Wetter.
        </div>
      </div>

      {/* Preview Chart (wenn Recharts vorhanden) */}
      <div style={{ background: "white", borderRadius: "12px", border: "1px solid #e5e7eb", padding: "16px", marginBottom: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
          <div style={{ fontSize: "14px", fontWeight: 500 }}>
            Vorschau: Tagesenergie (erste MaLo)
          </div>
          <div style={{ fontSize: "11px", color: "#6b7280" }}>
            {configs[0]
              ? configs[0].malo +
                " · " +
                (configs[0].direction === "consumption"
                  ? "Verbrauch"
                  : "Erzeugung")
              : "Keine MaLo konfiguriert"}
          </div>
        </div>

        {previewData.length > 0 && LineChart ? (
          <div style={{ height: "260px" }}>
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
          <div style={{ fontSize: "12px", color: "#6b7280" }}>
            {previewData.length === 0
              ? "Bitte mindestens eine MaLo konfigurieren, um eine Vorschau zu sehen."
              : "Recharts ist nicht geladen – die Vorschau-Grafik wird nur angezeigt, wenn die Recharts-Bibliothek eingebunden ist."}
          </div>
        )}
      </div>

      {/* Generate */}
      <div style={{ background: "white", borderRadius: "12px", border: "1px solid #e5e7eb", padding: "16px", marginBottom: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
          <button
            onClick={handleGenerateZip}
            disabled={isGenerating || configs.length === 0}
            style={{
              padding: "8px 14px",
              borderRadius: "999px",
              border: "none",
              background: isGenerating || configs.length === 0 ? "#9ca3af" : "#0f766e",
              color: "white",
              fontSize: "14px",
              cursor: isGenerating || configs.length === 0 ? "default" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            {isGenerating ? "Wird generiert …" : "ZIP erzeugen & herunterladen"}
          </button>
          <div style={{ fontSize: "11px", color: "#6b7280", textAlign: "right" }}>
            {stats.fileCount > 0 &&
              "Voraussichtlich " +
                stats.fileCount +
                " Dateien (~" +
                stats.estimatedMb.toFixed(2) +
                " MB)"}
          </div>
        </div>

        {fallbackLinks.length > 0 && (
          <div style={{ marginTop: "8px" }}>
            <div style={{ fontSize: "13px", marginBottom: "4px" }}>
              Falls der Browser den ZIP-Download blockt: Einzellinks
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px", fontSize: "12px" }}>
              {fallbackLinks.map((f, i) => (
                <a
                  key={i}
                  href={f.href}
                  download={f.name}
                  style={{ color: "#2563eb", textDecoration: "underline", wordBreak: "break-all" }}
                >
                  {f.name}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Self Tests */}
      <div style={{ background: "white", borderRadius: "12px", border: "1px solid #e5e7eb", padding: "16px", marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
          <button
            type="button"
            onClick={runSelfTests}
            style={{
              padding: "6px 10px",
              borderRadius: "999px",
              border: "1px solid #d1d5db",
              background: "white",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            Self-Checks durchführen
          </button>
          <span style={{ fontSize: "13px", color: "#6b7280" }}>
            (Regex-Split, 96×QTY, UNA/UNB, Summe≈kWh)
          </span>
        </div>

        {tests.length > 0 && (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: "13px" }}>
            {tests.map((t, i) => (
              <li key={i} style={{ display: "flex", gap: "6px", alignItems: "center", marginBottom: "2px" }}>
                <span style={{ fontWeight: 600, color: t.pass ? "#16a34a" : "#dc2626" }}>
                  {t.pass ? "✓" : "✗"}
                </span>
                <span>
                  {t.name}
                  {t.info ? " – " + t.info : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ fontSize: "11px", color: "#6b7280", display: "flex", flexDirection: "column", gap: "2px" }}>
        <div>
          Format: UNA vorhanden, UNB direkt anschließend, keine Zeilenumbrüche zwischen Segmenten, UNT korrekt gezählt. 15-Min-Intervalle (DTM 163/164) über den gewählten Zeitraum.
        </div>
        <div>
          Hinweis: Nur Erzeuger, die im selben Generierungslauf erstellt werden, teilen sich exakt dieselben Wetter- &amp; Saisonfaktoren (gleiche „Wettertage“ im Monat).
        </div>
      </div>
    </div>
  );
}

// Mount React App (React 17 & 18 kompatibel)
const rootEl = document.getElementById("root");
if (rootEl) {
  if (ReactDOM.createRoot) {
    ReactDOM.createRoot(rootEl).render(<MSCONSGenerator />);
  } else {
    ReactDOM.render(<MSCONSGenerator />, rootEl);
  }
}
