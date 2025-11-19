const { useState, useEffect, useMemo } = React;
const { SENDER_ID, RECIPIENT_ID, APP_CODE, DEFAULTS, LIMIT_MB } = window.MSCONS_CONFIG;

// ===== Helper & MSCONS Core =====
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

function seg(...parts) {
  return parts.join("+") + "'";
}

const SLOTS_PER_DAY = 96; // 24h * 4
const SLOT_MS = 15 * 60 * 1000;

// ===== SLP-Shapes (BDEW-ähnlich) =====
function gaussian(x, mu, sigma) {
  return Math.exp(-((x - mu) ** 2) / (2 * sigma ** 2));
}

function shapeH0(hour) {
  // BDEW-ähnlich: sehr niedrige Nacht, kleiner Morgenbuckel, dominante Abendspitze, leichter Mittagsbuckel
  const base = 0.12; // Grundlast (Nacht relativ niedrig)
  const morning = 0.35 * gaussian(hour, 7.5, 1.0);   // schmaler Morgenpeak
  const evening = 1.1 * gaussian(hour, 19.5, 1.5);   // dominanter Abendpeak
  const midday  = 0.15 * gaussian(hour, 13.0, 2.5);  // flacher Mittagsbuckel
  return base + morning + evening + midday;
}

function shapeG0(hour) {
  // BDEW-ähnlich: tagsüber deutlich höher als nachts, leichte Peaks am Vormittag/Nachmittag
  const base = 0.05;
  const dayPlateau = hour >= 6 && hour <= 20 ? 0.9 : 0.1; // Tag/Nacht-Unterschied
  const morning = 0.25 * gaussian(hour, 9.0, 1.4);
  const afternoon = 0.25 * gaussian(hour, 16.0, 1.4);
  return base + dayPlateau + morning + afternoon;
}

function shapeL0(hour) {
  // BDEW-ähnlich: früh, mittags und abends erhöht, Nacht moderat
  const base = 0.10;
  const early = 0.55 * gaussian(hour, 6.0, 1.2);     // früh morgens
  const midday = 0.45 * gaussian(hour, 12.0, 2.0);   // mittags
  const evening = 0.40 * gaussian(hour, 18.0, 1.6);  // abends
  return base + early + midday + evening;
}

function makeSLPValues(slots, slp, dailyKWh, noisePct, seed) {
  const r = rnd(seed);
  const oneDay = [];
  let sumDay = 0;

  // Basis: 96 normierte Faktoren für einen Tag
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    const hour = (i * 15) / 60;
    const v =
      slp === "H0" ? shapeH0(hour) :
      slp === "G0" ? shapeG0(hour) :
      shapeL0(hour);
    oneDay.push(v);
    sumDay += v;
  }

  // auf 1.0 normieren
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    oneDay[i] = oneDay[i] / sumDay;
  }

  const vals = [];
  for (let i = 0; i < slots; i++) {
    const base = oneDay[i % SLOTS_PER_DAY] * dailyKWh; // kWh/Tag-Anteil
    const noise = 1 + (r() - 0.5) * (2 * noisePct / 100);
    vals.push(Number((Math.max(0, base * noise)).toFixed(3)));
  }

  // pro Tag erneut auf dailyKWh normalisieren
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

function makePVProfile(slots, peakKW, seed) {
  const r = rnd(seed + 12345);
  const vals = [];
  for (let i = 0; i < slots; i++) {
    const hour = ((i % SLOTS_PER_DAY) * 15) / 60;
    const genKW = peakKW * gaussian(hour, 13.0, 2.6);
    const kwh15 = Math.max(0, genKW * 0.25 + (r() - 0.5) * 0.04);
    vals.push(Number(kwh15.toFixed(3)));
  }
  return vals;
}

// MSCONS-Builder (UNA+UNB ohne Zeilenumbrüche, 15min-Daten)
function buildMSCONS({ malo, obis, start, end, values }) {
  const ts = new Date();
  const rand = Math.floor(Math.random() * 9_000_000) + 1_000_000;
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
      `${pad(ts.getUTCFullYear() % 100)}${pad(ts.getUTCMonth() + 1)}${pad(ts.getUTCDate())}:${pad(ts.getUTCHours())}${pad(ts.getUTCMinutes())}`,
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
  // Hinweis: PIA ist bewusst vereinfacht; kann bei Bedarf auf echte Netzbetreiber-Profile umgebaut werden
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

// ===== React-Komponente =====
function MsconsGenerator() {
  const [date, setDate] = useState("2025-08-01");
  const [days, setDays] = useState(31);
  const [rawMalos, setRawMalos] = useState("50226092026\n51620926184\n50234152284");

  const [configs, setConfigs] = useState([]);
  const [downloads, setDownloads] = useState([]);
  const [tests, setTests] = useState([]);

  // MaLo-Liste robust aus Textarea extrahieren
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

  // Configs mit MaLo-Liste synchron halten
  useEffect(() => {
    setConfigs((prev) => {
      const byId = new Map(prev.map((p) => [p.malo, p]));
      return maloList.map((m) =>
        byId.get(m) || {
          malo: m,
          direction: DEFAULTS.direction,
          slp: DEFAULTS.slp,
          expectedAnnualKWh: DEFAULTS.expectedAnnualKWh,
          pvPeakKW: DEFAULTS.pvPeakKW,
        }
      );
    });
  }, [maloList]);

  function updateCfg(malo, patch) {
    setConfigs((list) =>
      list.map((c) => (c.malo === malo ? { ...c, ...patch } : c))
    );
  }

  async function handleGenerateZip() {
    const startBase = new Date(`${date}T22:00:00Z`); // 22:00 → 22:00 nächster Tag
    const masterZip = new JSZip();
    const allFiles = [];

    configs.forEach((cfg, idx) => {
      const seedBase = 1000 + idx * 97;

      for (let d = 0; d < days; d++) {
        const start = new Date(startBase.getTime() + d * 24 * 3600 * 1000);
        const end = new Date(start.getTime() + 24 * 3600 * 1000);
        const ymd =
          start.getUTCFullYear().toString() +
          pad(start.getUTCMonth() + 1) +
          pad(start.getUTCDate());

        if (cfg.direction === "consumption") {
          const dailyKWh = cfg.expectedAnnualKWh / 365;
          const vals = makeSLPValues(
            96,
            cfg.slp,
            dailyKWh,
            DEFAULTS.noisePct,
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
          const vals = makePVProfile(96, cfg.pvPeakKW, seedBase + 33 + d);
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

    // Größen-Guard
    const approxBytes = allFiles.reduce((sum, f) => sum + f.content.length, 0);
    const limitBytes = LIMIT_MB * 1024 * 1024;
    if (approxBytes > limitBytes) {
      const proceed = window.confirm(
        `You're about to generate ~${(approxBytes / (1024 * 1024)).toFixed(1)} MB of data (> ${LIMIT_MB} MB). Continue?`
      );
      if (!proceed) return;
    }

    // pro-MaLo ZIP + Master-ZIP
    const perMaLoZipBlobs = [];
    for (const cfg of configs) {
      const maloZip = new JSZip();
      const filesForMalo = allFiles.filter((f) => f.malo === cfg.malo);
      filesForMalo.forEach((f) => maloZip.file(f.name, f.content));
      const maloBlob = await maloZip.generateAsync({ type: "blob" });
      const maloZipName = `MSCONS_${date.replace(/-/g, "")}_${cfg.malo}.zip`;
      masterZip.file(maloZipName, maloBlob);
      perMaLoZipBlobs.push({ name: maloZipName, blob: maloBlob });
    }

    const masterBlob = await masterZip.generateAsync({ type: "blob" });
    const masterName = `MSCONS_${date.replace(/-/g, "")}_${configs.length}MaLo_master.zip`;
    saveAs(masterBlob, masterName);

    setDownloads([{ name: masterName, blob: masterBlob }, ...perMaLoZipBlobs]);
  }

  function runSelfTests() {
    const results = [];

    // 1) Regex split correctness (CRLF/LF + trim + dedupe)
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

    // 2) One-day values length per SLP
    const valsH0 = makeSLPValues(96, "H0", 20, 5, 123);
    results.push({ name: "H0 96 values", pass: valsH0.length === 96 });

    // 3) Sum normalization ≈ dailyKWh
    const sum = valsH0.reduce((a, b) => a + b, 0);
    results.push({
      name: "Daily sum ≈ 20 kWh",
      pass: Math.abs(sum - 20) < 0.05,
      info: `sum=${sum.toFixed(3)}`,
    });

    // 4) MSCONS structure (single day, Verbrauch)
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

    // 5) MSCONS structure (single day, Erzeugung 2.8.0)
    const genVals = makePVProfile(96, 5, 321);
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

    // 6) Dateiname-Check
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

  return (
    <div className="container">
      <div className="card">
        <h1 className="card-title">⚡ MSCONS Generator</h1>
        <div className="card-subtitle">
          Multi-MaLo, 15-Min-Lastgänge, UNA+UNB ohne Zeilenumbrüche, pro Tag eine Datei,
          pro MaLo ein ZIP, plus Master-ZIP.
        </div>
      </div>

      <div className="card">
        <div className="grid grid-3">
          <div>
            <label>Startdatum (ohne Zeit)</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label>Tage</label>
            <input
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
            <label>MaLo-IDs (eine pro Zeile)</label>
            <textarea
              value={rawMalos}
              onChange={(e) => setRawMalos(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="muted" style={{ marginBottom: 6 }}>
          Pro-MaLo Einstellungen
        </div>
        <div
          className="grid grid-7"
          style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}
        >
          <div>MaLo</div>
          <div>Richtung</div>
          <div>SLP</div>
          <div>kWh/Jahr</div>
          <div>PV kWp</div>
          <div>Tage</div>
          <div>Info</div>
        </div>
        <div>
          {configs.map((c) => (
            <div key={c.malo} className="row">
              <input
                value={c.malo}
                onChange={(e) => updateCfg(c.malo, { malo: e.target.value })}
              />

              <select
                value={c.direction}
                onChange={(e) =>
                  updateCfg(c.malo, { direction: e.target.value })
                }
              >
                <option value="consumption">Verbrauch (1.8.0)</option>
                <option value="generation">Erzeugung (2.8.0)</option>
              </select>

              <select
                value={c.slp}
                onChange={(e) => updateCfg(c.malo, { slp: e.target.value })}
                disabled={c.direction !== "consumption"}
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
              />

              <div className="muted">{days}</div>

              <div className="muted">
                {c.direction === "consumption"
                  ? `~${(c.expectedAnnualKWh / 365).toFixed(1)} kWh/Tag`
                  : `${c.pvPeakKW} kWp`}
              </div>
            </div>
          ))}
        </div>
        <div className="muted mt-2">
          Zufällige leichte Abweichungen je Intervall, Summen werden pro Tag auf
          das Ziel (kWh/Tag) normalisiert.
          Pro MaLo: entweder Verbrauch (kWh/Jahr + SLP) oder Erzeugung (kWp).
        </div>
      </div>

      <div className="card">
        <button className="btn" onClick={handleGenerateZip}>
          ZIP erzeugen &amp; herunterladen
        </button>
        {downloads.length > 0 && (
          <div className="mt-3">
            <div className="muted" style={{ marginBottom: 6 }}>
              Manuelle Downloads (falls Auto-Download blockiert wurde):
            </div>
            <div className="downloads-grid">
              {downloads.map((f, i) => (
                <button
                  key={i}
                  className="btn btn-outline"
                  onClick={() => saveAs(f.blob, f.name)}
                >
                  {f.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>
          Self-Checks (Struktur, 96×QTY, etc.)
        </div>
        <button className="btn btn-outline" onClick={runSelfTests}>
          Self-Checks durchführen
        </button>
        {tests.length > 0 && (
          <ul className="mt-2">
            {tests.map((t, i) => (
              <li key={i}>
                {t.pass ? "✅" : "❌"} {t.name}
                {t.info ? ` – ${t.info}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="muted mt-2">
        Format: UNA vorhanden, UNB direkt anschließend, keine Zeilenumbrüche zwischen Segmenten,
        UNT korrekt gezählt. 15-Min-Intervalle (DTM 163/164) über den gewählten Zeitraum.
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<MsconsGenerator />);
