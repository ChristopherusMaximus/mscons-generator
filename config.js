// Zentrale Konfiguration für den MSCONS-Generator
// -> kann von der IT leicht angepasst werden

window.MSCONS_CONFIG = {
  // EDIFACT-Header
  SENDER_ID: "9979383000006",
  RECIPIENT_ID: "9906629000002",
  APP_CODE: "TL", // z.B. TL für Messdaten

  // Standardwerte
  DEFAULTS: {
    slp: "H0",                  // Standard-SLP
    expectedAnnualKWh: 7300,    // ~20 kWh/Tag
    noisePct: 6,                // Zufallsrauschen in %
    direction: "consumption",   // "consumption" | "generation"
    pvPeakKW: 4,                // Standard-PV-Leistung in kWp
  },

  // Sicherheitsgrenze für ungefähre ZIP-Größe
  LIMIT_MB: 50,
};
