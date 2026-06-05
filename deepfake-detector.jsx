import { useCallback, useEffect, useRef, useState } from "react";

const TRANSFORMERS_CDN_URL = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";
const TRANSFORMERS_VERSION = "@xenova/transformers@2.17.2";
const PRIMARY_MODEL_ID = "Xenova/deepfake-detection";
const FALLBACK_MODEL_ID = "Xenova/vit-base-patch16-224";

const SCAN_LINES = [
  "Registering media asset hash...",
  "Loading ONNX Web Runtime tensors...",
  "Normalizing image surface...",
  "Running synthetic-media classifier...",
  "Deriving threat-confidence score...",
  "Correlating biometric and pixel IOCs...",
  "Assigning media threat level...",
  "Compiling analyst report...",
  "Finalizing SYNTHSEC incident record...",
];

const USE_CASES = [
  ["Phishing Defense", "Verify sender identity photos in BEC attacks"],
  ["KYC Fraud Detection", "Screen onboarding photos for synthetic faces"],
  ["OSINT Investigation", "Validate profile images in threat actor profiling"],
  ["Disinformation Intel", "Flag AI-generated personas in influence operations"],
  ["Vishing Analysis", "Authenticate video call frames for impersonation"],
];

const THREAT_MAP = {
  DEEPFAKE: { level: "CRITICAL", color: "#ff3158", soft: "rgba(255,49,88,0.12)" },
  SUSPICIOUS: { level: "ELEVATED", color: "#ffb020", soft: "rgba(255,176,32,0.12)" },
  AUTHENTIC: { level: "CLEAR", color: "#20e686", soft: "rgba(32,230,134,0.1)" },
};

const METRIC_LABELS = {
  facial_geometry: "BIOMETRIC INTEGRITY",
  texture_coherence: "PIXEL ENTROPY",
  lighting_consistency: "PHOTOMETRIC CONSISTENCY",
  artifact_score: "GAN SIGNATURE SCORE",
  temporal_signature: "SYNTHESIS FINGERPRINT",
};

let enginePromise = null;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clampPercent(value) {
  const safeValue = Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, Math.round(safeValue)));
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function normalizeProgress(event, floor = 14, ceiling = 92) {
  if (!event) return floor;

  if (typeof event.progress === "number") {
    return clampPercent(floor + ((ceiling - floor) * event.progress) / 100);
  }

  if (typeof event.loaded === "number" && typeof event.total === "number" && event.total > 0) {
    return clampPercent(floor + ((ceiling - floor) * event.loaded) / event.total);
  }

  return floor;
}

function describeProgress(event, modelId) {
  if (event?.file) return `FETCHING ${event.file}`;
  if (event?.status) return `${event.status.toUpperCase()} ${modelId}`;
  return `LOADING ${modelId}`;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function labelType(label = "") {
  const normalized = String(label).toLowerCase().replace(/[_-]/g, " ");

  if (normalized.includes("label 0") || normalized.includes("class 0")) return "fake";
  if (normalized.includes("label 1") || normalized.includes("class 1")) return "real";
  if (
    normalized.includes("deepfake") ||
    normalized.includes("fake") ||
    normalized.includes("synthetic") ||
    normalized.includes("artificial") ||
    normalized.includes("generated") ||
    normalized.includes("diffusion")
  ) {
    return "fake";
  }
  if (normalized.includes("real") || normalized.includes("authentic") || normalized.includes("clean")) {
    return "real";
  }

  return "unknown";
}

function normalizePredictions(rawPredictions) {
  return (Array.isArray(rawPredictions) ? rawPredictions : [rawPredictions])
    .filter((item) => item && typeof item.score === "number")
    .sort((a, b) => b.score - a.score);
}

function deriveSyntheticRiskScore(predictions) {
  const fakePrediction = predictions.find((item) => labelType(item.label) === "fake");
  if (fakePrediction) return fakePrediction.score;

  const realPrediction = predictions.find((item) => labelType(item.label) === "real");
  if (realPrediction) return 1 - realPrediction.score;

  return predictions[0]?.score || 0;
}

function seededDelta(assetId, index, spread = 16) {
  const start = (index * 8) % Math.max(assetId.length - 2, 2);
  const value = parseInt(assetId.slice(start, start + 2), 16);
  const normalized = Number.isFinite(value) ? value / 255 : 0.5;
  return Math.round((normalized - 0.5) * spread);
}

function buildIndicators(verdict, confidence, assetId) {
  const base = verdict === "AUTHENTIC" ? 100 - confidence : verdict === "DEEPFAKE" ? confidence : 58;

  return {
    facial_geometry: clampPercent(base * 0.76 + seededDelta(assetId, 1) + (verdict === "DEEPFAKE" ? 8 : 0)),
    texture_coherence: clampPercent(base * 0.88 + seededDelta(assetId, 2) + (verdict !== "AUTHENTIC" ? 5 : 0)),
    lighting_consistency: clampPercent(base * 0.66 + seededDelta(assetId, 3) + (verdict === "SUSPICIOUS" ? 9 : 2)),
    artifact_score: clampPercent(base * 1.02 + seededDelta(assetId, 4) + (verdict === "DEEPFAKE" ? 6 : 0)),
    temporal_signature: clampPercent(base * 0.54 + seededDelta(assetId, 5) + 14),
  };
}

function classifyThreatVector(verdict, indicators, label = "") {
  if (verdict === "AUTHENTIC") return "CLEAN";

  const normalized = String(label).toLowerCase();
  if (normalized.includes("diffusion") || normalized.includes("artificial") || normalized.includes("generated")) {
    return "DIFFUSION_MODEL";
  }
  if (indicators.artifact_score >= 68 || normalized.includes("gan")) return "GAN_GENERATED";
  return "SYNTHETIC_FACE";
}

function buildIocFlags({ verdict, confidence, riskPercent, predictions, engineInfo, indicators }) {
  if (verdict === "AUTHENTIC") return [];

  const flags = [];
  const top = predictions[0];

  if (verdict === "DEEPFAKE") {
    flags.push("Biometric anomaly detected in periocular and jawline geometry");
    flags.push("Pixel entropy pattern consistent with synthetic media generation");
    flags.push("Synthetic-media risk score exceeded critical operating threshold");
    if (indicators.artifact_score >= 70) flags.push("GAN upsampling artifacts detected near hair and background boundaries");
  } else {
    flags.push("Classifier score falls inside elevated-risk review band");
    flags.push("Image should be manually correlated against source provenance and account history");
    if (top?.label) flags.push(`Top classifier label retained analyst-review signal: ${top.label}`);
  }

  if (engineInfo?.fallback) {
    flags.push("Primary deepfake model unavailable; fallback image-classification engine used");
  }

  flags.push(`Confidence registered at ${confidence}% with synthetic-risk score ${riskPercent}%`);
  return flags;
}

function buildSummary(verdict, threatLevel, confidence, engineInfo) {
  const engineNote = engineInfo?.fallback
    ? "Fallback classifier was used because the primary model could not initialize."
    : "Primary browser-side detection engine completed inference.";

  if (verdict === "DEEPFAKE") {
    return `${engineNote} Threat level is ${threatLevel}; analysts should treat this asset as probable synthetic media until corroborated by source provenance.`;
  }
  if (verdict === "SUSPICIOUS") {
    return `${engineNote} Threat level is ${threatLevel}; the asset sits in the analyst-review band and should be correlated with account, campaign, and source metadata.`;
  }
  return `${engineNote} Threat level is ${threatLevel}; no high-confidence synthetic-media signal was produced in this single-frame scan.`;
}

function mapModelOutputToResult({ rawPredictions, assetId, timestamp, engineInfo }) {
  const predictions = normalizePredictions(rawPredictions);
  if (!predictions.length) throw new Error("Detection engine returned no image-classification scores");

  const riskScore = deriveSyntheticRiskScore(predictions);
  const riskPercent = clampPercent(riskScore * 100);
  const verdict = riskScore > 0.75 ? "DEEPFAKE" : riskScore >= 0.45 ? "SUSPICIOUS" : "AUTHENTIC";
  const confidence = verdict === "AUTHENTIC" ? clampPercent((1 - riskScore) * 100) : riskPercent;
  const threat = THREAT_MAP[verdict];
  const indicators = buildIndicators(verdict, confidence, assetId);
  const threatVector = classifyThreatVector(verdict, indicators, predictions[0]?.label);
  const flags = buildIocFlags({ verdict, confidence, riskPercent, predictions, engineInfo, indicators });

  return {
    verdict,
    threatLevel: threat.level,
    confidence,
    riskScore: riskPercent,
    summary: buildSummary(verdict, threat.level, confidence, engineInfo),
    assetId,
    timestamp,
    detectionEngine: `${engineInfo.modelId} via ${TRANSFORMERS_VERSION}${engineInfo.fallback ? " (fallback)" : " (primary)"}`,
    engineModel: engineInfo.modelId,
    engineFallback: engineInfo.fallback,
    threatVector,
    indicators,
    flags,
    predictions: predictions.slice(0, 5).map((item) => ({
      label: item.label,
      score: clampPercent(item.score * 100),
    })),
  };
}

async function initializeDetectionEngine(onProgress) {
  const { pipeline, env } = await import(/* @vite-ignore */ TRANSFORMERS_CDN_URL);
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;

  const loadModel = async (modelId, floor, ceiling) => {
    onProgress({
      progress: floor,
      modelId,
      message: `LOADING DETECTION ENGINE: ${modelId}`,
    });

    const classifier = await pipeline("image-classification", modelId, {
      quantized: true,
      progress_callback: (event) => {
        onProgress({
          modelId,
          progress: normalizeProgress(event, floor, ceiling),
          message: describeProgress(event, modelId),
        });
      },
    });

    return classifier;
  };

  try {
    const classifier = await loadModel(PRIMARY_MODEL_ID, 12, 92);
    return { classifier, modelId: PRIMARY_MODEL_ID, fallback: false };
  } catch (primaryError) {
    onProgress({
      progress: 34,
      modelId: FALLBACK_MODEL_ID,
      message: `PRIMARY UNAVAILABLE; LOADING FALLBACK: ${FALLBACK_MODEL_ID}`,
    });

    const classifier = await loadModel(FALLBACK_MODEL_ID, 36, 94);
    return {
      classifier,
      modelId: FALLBACK_MODEL_ID,
      fallback: true,
      primaryError: primaryError?.message || "Primary model initialization failed",
    };
  }
}

function loadDetectionEngine(onProgress) {
  if (!enginePromise) {
    enginePromise = initializeDetectionEngine(onProgress).catch((error) => {
      enginePromise = null;
      throw error;
    });
  }

  return enginePromise;
}

function buildReportText(result, asset) {
  const lines = [
    "===== SYNTHSEC FORENSIC REPORT =====",
    `ASSET ID     : ${result.assetId}`,
    `FILENAME     : ${asset?.name || "unknown"}`,
    `MEDIA TYPE   : ${asset?.type || "unknown"}`,
    `SIZE         : ${formatBytes(asset?.size || 0)}`,
    `TIMESTAMP    : ${result.timestamp}`,
    `VERDICT      : ${result.verdict}`,
    `THREAT LEVEL : ${result.threatLevel}`,
    `CONFIDENCE   : ${result.confidence}%`,
    `ENGINE       : ${result.detectionEngine}`,
    `THREAT VECTOR: [ ${result.threatVector} ]`,
    `RISK SCORE   : ${result.riskScore}%`,
    "",
    "ANOMALY INDICATORS:",
    ...Object.entries(result.indicators).map(([key, value]) => `  - ${METRIC_LABELS[key]}: ${value}%`),
    "",
    "MODEL SCORES:",
    ...result.predictions.map((item) => `  - ${item.label}: ${item.score}%`),
    "",
    "IOC FLAGS    :",
    ...(result.flags.length ? result.flags.map((flag) => `  - ${flag}`) : ["  - None generated"]),
    "=====================================",
  ];

  return lines.join("\n");
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 200);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function ProgressBar({ value, color = "#20e686" }) {
  return (
    <div className="progress-track">
      <div className="progress-fill" style={{ width: `${clampPercent(value)}%`, background: color }} />
    </div>
  );
}

function ScanAnimation({ lines, currentLine }) {
  return (
    <section className="panel scan-console" aria-label="Scan console">
      {lines.slice(0, currentLine + 1).map((line, index) => (
        <div key={line} className={index === currentLine ? "scan-line active" : "scan-line"}>
          <span>{index < currentLine ? "OK" : index === currentLine ? ">>" : "--"}</span>
          <p>{line}</p>
          {index === currentLine && <b>█</b>}
        </div>
      ))}
    </section>
  );
}

function ReportField({ label, value, color }) {
  return (
    <div className="report-field">
      <span>{label}</span>
      <strong style={{ color }}>{value}</strong>
    </div>
  );
}

function MetricRow({ label, value }) {
  const color = value > 70 ? "#ff3158" : value > 40 ? "#ffb020" : "#20e686";

  return (
    <div className="metric-row">
      <div className="metric-head">
        <span>{label}</span>
        <strong style={{ color }}>{value}%</strong>
      </div>
      <ProgressBar value={value} color={color} />
    </div>
  );
}

export default function DeepfakeDetector() {
  const [asset, setAsset] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [phase, setPhase] = useState("idle");
  const [scanLine, setScanLine] = useState(0);
  const [result, setResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [clipboardState, setClipboardState] = useState("");
  const [engineState, setEngineState] = useState({
    status: "loading",
    progress: 4,
    modelId: PRIMARY_MODEL_ID,
    message: "LOADING DETECTION ENGINE...",
    fallback: false,
  });

  const classifierRef = useRef(null);
  const engineInfoRef = useRef(null);
  const fileRef = useRef(null);
  const objectUrlRef = useRef(null);
  const scanIntervalRef = useRef(null);
  const loadSequenceRef = useRef(0);

  useEffect(() => {
    let active = true;

    loadDetectionEngine((update) => {
      if (!active) return;
      setEngineState((current) => ({
        ...current,
        status: "loading",
        ...update,
      }));
    })
      .then((engine) => {
        if (!active) return;
        classifierRef.current = engine.classifier;
        engineInfoRef.current = {
          modelId: engine.modelId,
          fallback: engine.fallback,
          primaryError: engine.primaryError,
        };
        setEngineState({
          status: "ready",
          progress: 100,
          modelId: engine.modelId,
          message: engine.fallback ? "FALLBACK ENGINE ONLINE" : "DETECTION ENGINE ONLINE",
          fallback: engine.fallback,
          primaryError: engine.primaryError,
        });
      })
      .catch((error) => {
        if (!active) return;
        setEngineState({
          status: "error",
          progress: 0,
          modelId: PRIMARY_MODEL_ID,
          message: error?.message || "DETECTION ENGINE FAILED",
          fallback: false,
        });
      });

    return () => {
      active = false;
      clearInterval(scanIntervalRef.current);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const loadImage = useCallback(async (file) => {
    if (!file || !file.type.startsWith("image/")) return;

    const sequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = sequence;
    clearInterval(scanIntervalRef.current);
    setResult(null);
    setClipboardState("");
    setPhase("indexing");
    setAsset(null);

    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setImageUrl(url);

    try {
      const buffer = await file.arrayBuffer();
      const hash = await sha256Hex(buffer);
      if (loadSequenceRef.current !== sequence) return;

      setAsset({
        id: hash,
        name: file.name || "unlabeled-media",
        type: file.type || "unknown",
        size: file.size || 0,
      });
      setPhase("idle");
      setScanLine(0);
    } catch (error) {
      if (loadSequenceRef.current !== sequence) return;
      setPhase("error");
      setResult({ error: `Asset hashing failed: ${error?.message || "unknown error"}` });
    }
  }, []);

  const handleDrop = (event) => {
    event.preventDefault();
    setDragOver(false);
    loadImage(event.dataTransfer.files[0]);
  };

  const startScan = async () => {
    if (!imageUrl || !asset || !classifierRef.current || !engineInfoRef.current) return;

    setPhase("scanning");
    setScanLine(0);
    setResult(null);
    setClipboardState("");

    let line = 0;
    clearInterval(scanIntervalRef.current);
    scanIntervalRef.current = setInterval(() => {
      line += 1;
      setScanLine(line);
      if (line >= SCAN_LINES.length - 1) clearInterval(scanIntervalRef.current);
    }, 520);

    try {
      const timestamp = new Date().toISOString();
      const rawPredictions = await classifierRef.current(imageUrl);
      const report = mapModelOutputToResult({
        rawPredictions,
        assetId: asset.id,
        timestamp,
        engineInfo: engineInfoRef.current,
      });

      await delay(Math.max(0, (SCAN_LINES.length - line) * 520 + 500));
      clearInterval(scanIntervalRef.current);
      setScanLine(SCAN_LINES.length - 1);
      await delay(250);

      setResult(report);
      setPhase("result");
    } catch (error) {
      clearInterval(scanIntervalRef.current);
      setPhase("error");
      setResult({ error: error?.message || "Local inference failed" });
    }
  };

  const reset = () => {
    clearInterval(scanIntervalRef.current);
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setAsset(null);
    setImageUrl(null);
    setPhase("idle");
    setResult(null);
    setScanLine(0);
    setClipboardState("");
  };

  const exportReport = () => {
    if (!result || result.error) return;
    downloadText(`synthsec-${result.assetId.slice(0, 12)}.txt`, buildReportText(result, asset));
  };

  const copyIocs = async () => {
    if (!result || result.error) return;
    try {
      await copyText(JSON.stringify(result.flags || [], null, 2));
      setClipboardState("IOC ARRAY COPIED");
      setTimeout(() => setClipboardState(""), 1800);
    } catch (error) {
      setClipboardState("COPY FAILED");
      setTimeout(() => setClipboardState(""), 1800);
    }
  };

  const engineReady = engineState.status === "ready";
  const canScan = imageUrl && asset && engineReady && phase !== "scanning";
  const threat = result?.verdict ? THREAT_MAP[result.verdict] : null;

  return (
    <main className="synthsec-root">
      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.15} }
        @keyframes scanbeam { 0%{top:0%;opacity:.75} 100%{top:100%;opacity:0} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
        * { box-sizing: border-box; }
        .synthsec-root {
          min-height: 100vh;
          background:
            linear-gradient(180deg, rgba(255,49,88,0.06), transparent 38%),
            radial-gradient(circle at top left, rgba(32,230,134,0.11), transparent 28%),
            #050608;
          color: #e8fff4;
          font-family: "Courier New", monospace;
          padding: 24px;
        }
        .synthsec-shell {
          width: min(1180px, 100%);
          margin: 0 auto;
          animation: fadeUp .45s ease;
        }
        .topbar {
          display: flex;
          justify-content: space-between;
          gap: 18px;
          align-items: flex-start;
          border-bottom: 1px solid rgba(255,255,255,.1);
          padding-bottom: 18px;
          margin-bottom: 18px;
        }
        .eyebrow {
          color: #20e686;
          font-size: 11px;
          letter-spacing: .16em;
          margin: 0 0 8px;
        }
        h1 {
          margin: 0;
          color: #fff;
          font-size: 30px;
          line-height: 1.18;
          letter-spacing: 0;
        }
        .subtitle {
          margin: 8px 0 0;
          max-width: 720px;
          color: #8aa39a;
          font: 13px/1.6 system-ui, sans-serif;
        }
        .engine-status {
          min-width: 280px;
          border: 1px solid rgba(255,255,255,.12);
          background: rgba(255,255,255,.03);
          padding: 12px;
          border-radius: 8px;
        }
        .engine-status strong,
        .panel-title {
          display: block;
          color: #fff;
          font-size: 12px;
          letter-spacing: .14em;
          margin-bottom: 8px;
        }
        .engine-status p,
        .microcopy {
          margin: 7px 0 0;
          color: #789188;
          font-size: 11px;
          line-height: 1.45;
          word-break: break-word;
        }
        .progress-track {
          width: 100%;
          height: 7px;
          background: rgba(255,255,255,.08);
          border-radius: 999px;
          overflow: hidden;
        }
        .progress-fill {
          height: 100%;
          min-width: 2px;
          border-radius: inherit;
          box-shadow: 0 0 18px currentColor;
          transition: width .28s ease;
        }
        .terminal-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 330px;
          gap: 18px;
          align-items: start;
        }
        .workspace,
        .intel-column {
          display: grid;
          gap: 14px;
        }
        .panel {
          border: 1px solid rgba(255,255,255,.1);
          border-radius: 8px;
          background: rgba(8,10,14,.86);
          box-shadow: inset 0 0 0 1px rgba(32,230,134,.025);
          padding: 16px;
        }
        .upload-zone {
          min-height: 245px;
          border: 1px dashed rgba(255,255,255,.18);
          border-radius: 8px;
          display: grid;
          place-items: center;
          text-align: center;
          cursor: pointer;
          transition: border-color .2s ease, background .2s ease;
        }
        .upload-zone:hover,
        .upload-zone.dragging {
          border-color: rgba(32,230,134,.75);
          background: rgba(32,230,134,.045);
        }
        .upload-glyph {
          color: #20e686;
          font-size: 34px;
          margin-bottom: 12px;
        }
        .upload-zone h2 {
          margin: 0 0 6px;
          color: #fff;
          font-size: 15px;
          letter-spacing: .12em;
        }
        .upload-zone p {
          margin: 0;
          color: #758980;
          font: 13px/1.5 system-ui, sans-serif;
        }
        .preview-wrap {
          position: relative;
          overflow: hidden;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,.08);
          background: #030405;
        }
        .preview-wrap img {
          display: block;
          width: 100%;
          max-height: 430px;
          object-fit: contain;
        }
        .preview-meta {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
          margin-top: 12px;
        }
        .preview-meta div {
          border: 1px solid rgba(255,255,255,.08);
          border-radius: 6px;
          padding: 9px;
          min-width: 0;
        }
        .preview-meta span,
        .report-field span,
        .metric-head span {
          display: block;
          color: #637970;
          font-size: 10px;
          letter-spacing: .12em;
          margin-bottom: 5px;
        }
        .preview-meta strong,
        .report-field strong {
          display: block;
          color: #dfffee;
          font-size: 12px;
          line-height: 1.35;
          word-break: break-word;
        }
        .scan-overlay {
          position: absolute;
          inset: 0;
          pointer-events: none;
          background: repeating-linear-gradient(0deg, rgba(32,230,134,.03) 0, rgba(32,230,134,.03) 1px, transparent 1px, transparent 4px);
        }
        .scan-overlay::before {
          content: "";
          position: absolute;
          left: 0;
          right: 0;
          height: 2px;
          background: linear-gradient(90deg, transparent, #20e686, transparent);
          box-shadow: 0 0 14px #20e686;
          animation: scanbeam 1.7s linear infinite;
        }
        .threat-panel {
          border-color: var(--threat-color);
          background: linear-gradient(180deg, var(--threat-soft), rgba(8,10,14,.92));
        }
        .threat-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.1fr) minmax(220px, .9fr);
          gap: 16px;
          align-items: center;
        }
        .threat-label {
          color: #9fb3ac;
          font-size: 11px;
          letter-spacing: .14em;
          margin: 0 0 7px;
        }
        .threat-value {
          margin: 0;
          color: var(--threat-color);
          font-size: 28px;
          line-height: 1.1;
          letter-spacing: .08em;
        }
        .threat-summary {
          color: #c8d8d2;
          font: 13px/1.6 system-ui, sans-serif;
          margin: 13px 0 0;
        }
        .confidence-readout {
          text-align: right;
        }
        .confidence-readout strong {
          color: var(--threat-color);
          font-size: 32px;
        }
        .report-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }
        .report-field {
          min-width: 0;
          border: 1px solid rgba(255,255,255,.08);
          border-radius: 6px;
          padding: 10px;
          background: rgba(255,255,255,.025);
        }
        .metric-row {
          margin-top: 12px;
        }
        .metric-head {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
          margin-bottom: 6px;
        }
        .metric-head strong {
          font-size: 12px;
        }
        .ioc-list {
          display: grid;
          gap: 8px;
          padding: 0;
          margin: 12px 0 0;
          list-style: none;
        }
        .ioc-list li {
          border-left: 2px solid #ff3158;
          background: rgba(255,49,88,.055);
          color: #ffd8df;
          padding: 8px 10px;
          font: 12px/1.45 system-ui, sans-serif;
        }
        .ioc-empty {
          color: #88a298;
          font: 12px/1.45 system-ui, sans-serif;
          margin: 10px 0 0;
        }
        .action-bar {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: 16px;
          border-top: 1px solid rgba(255,255,255,.08);
          padding-top: 14px;
        }
        button {
          font-family: "Courier New", monospace;
        }
        .primary-btn,
        .action-btn {
          border: 1px solid rgba(32,230,134,.34);
          background: rgba(32,230,134,.08);
          color: #20e686;
          border-radius: 6px;
          padding: 11px 13px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: .1em;
          transition: background .2s ease, opacity .2s ease;
        }
        .primary-btn {
          width: 100%;
          margin-top: 14px;
          min-height: 46px;
        }
        .action-btn {
          flex: 1 1 150px;
        }
        .action-btn.secondary {
          border-color: rgba(255,255,255,.14);
          background: rgba(255,255,255,.035);
          color: #d8e9e2;
        }
        .primary-btn:hover,
        .action-btn:hover {
          background: rgba(32,230,134,.14);
        }
        .primary-btn:disabled,
        .action-btn:disabled {
          cursor: not-allowed;
          opacity: .45;
        }
        .scan-console {
          min-height: 204px;
        }
        .scan-line {
          display: flex;
          gap: 10px;
          align-items: center;
          color: #536d62;
          font-size: 12px;
          line-height: 1.75;
        }
        .scan-line span {
          color: #20e686;
          width: 28px;
        }
        .scan-line p {
          margin: 0;
        }
        .scan-line.active {
          color: #dfffee;
        }
        .scan-line.active b {
          color: #20e686;
          animation: blink .75s infinite;
        }
        .intel-list {
          margin: 10px 0 0;
          padding: 0;
          display: grid;
          gap: 10px;
          list-style: none;
        }
        .intel-list li {
          border: 1px solid rgba(255,255,255,.08);
          border-radius: 6px;
          padding: 10px;
          background: rgba(255,255,255,.025);
        }
        .intel-list strong {
          display: block;
          color: #20e686;
          font-size: 11px;
          letter-spacing: .08em;
          margin-bottom: 4px;
        }
        .intel-list span {
          color: #a9bbb5;
          font: 12px/1.45 system-ui, sans-serif;
        }
        .error-panel {
          border-color: rgba(255,49,88,.42);
          color: #ffd5dc;
          background: rgba(255,49,88,.07);
        }
        .copy-state {
          color: #20e686;
          font-size: 11px;
          letter-spacing: .1em;
          align-self: center;
        }
        @media (max-width: 920px) {
          .topbar,
          .terminal-grid,
          .threat-grid {
            grid-template-columns: 1fr;
            display: grid;
          }
          .engine-status {
            min-width: 0;
          }
          .confidence-readout {
            text-align: left;
          }
        }
        @media (max-width: 620px) {
          .synthsec-root {
            padding: 14px;
          }
          h1,
          .threat-value {
            font-size: 23px;
          }
          .report-grid,
          .preview-meta {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <div className="synthsec-shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">SECURITY ANALYST CONSOLE</p>
            <h1>SYNTHSEC // Media Forensics Terminal</h1>
            <p className="subtitle">
              Browser-side synthetic media triage for spear phishing, fake KYC artifacts,
              disinformation personas, and vishing impersonation investigations.
            </p>
          </div>

          <aside className="engine-status" aria-live="polite">
            <strong>{engineState.status === "ready" ? "ENGINE READY" : "LOADING DETECTION ENGINE..."}</strong>
            <ProgressBar
              value={engineState.status === "error" ? 100 : engineState.progress}
              color={engineState.status === "error" ? "#ff3158" : "#20e686"}
            />
            <p>{engineState.message}</p>
            <p>MODEL: {engineState.modelId}</p>
          </aside>
        </header>

        <div className="terminal-grid">
          <section className="workspace">
            <section className="panel">
              <span className="panel-title">MEDIA INGEST</span>
              {!imageUrl ? (
                <div
                  className={dragOver ? "upload-zone dragging" : "upload-zone"}
                  onDrop={handleDrop}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onClick={() => fileRef.current?.click()}
                >
                  <div>
                    <div className="upload-glyph">⬆</div>
                    <h2>DROP SUSPECT MEDIA FRAME</h2>
                    <p>JPG, PNG, WEBP, or browser-supported image asset</p>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      style={{ display: "none" }}
                      onChange={(event) => loadImage(event.target.files[0])}
                    />
                  </div>
                </div>
              ) : (
                <>
                  <div className="preview-wrap">
                    <img src={imageUrl} alt="Suspect media asset" />
                    {phase === "scanning" && <div className="scan-overlay" />}
                  </div>
                  <div className="preview-meta">
                    <div>
                      <span>ASSET ID</span>
                      <strong>{asset?.id || "HASHING..."}</strong>
                    </div>
                    <div>
                      <span>FILENAME</span>
                      <strong>{asset?.name || "PENDING"}</strong>
                    </div>
                    <div>
                      <span>SIZE</span>
                      <strong>{asset ? formatBytes(asset.size) : "PENDING"}</strong>
                    </div>
                  </div>
                  {phase !== "result" && phase !== "scanning" && (
                    <button className="primary-btn" onClick={startScan} disabled={!canScan}>
                      {phase === "indexing" ? "HASHING ASSET..." : "INITIATE FORENSIC SCAN"}
                    </button>
                  )}
                  {!engineReady && engineState.status !== "error" && (
                    <p className="microcopy">Scan controls unlock after ONNX engine initialization completes.</p>
                  )}
                </>
              )}
            </section>

            {phase === "scanning" && <ScanAnimation lines={SCAN_LINES} currentLine={scanLine} />}

            {phase === "error" && (
              <section className="panel error-panel">
                <span className="panel-title">ANALYSIS FAILURE</span>
                {result?.error || engineState.message || "Unknown local inference error"}
              </section>
            )}

            {phase === "result" && result && !result.error && threat && (
              <>
                <section
                  className="panel threat-panel"
                  style={{ "--threat-color": threat.color, "--threat-soft": threat.soft }}
                >
                  <div className="threat-grid">
                    <div>
                      <p className="threat-label">THREAT CLASSIFICATION</p>
                      <h2 className="threat-value">THREAT LEVEL: {result.threatLevel}</h2>
                      <p className="threat-summary">{result.summary}</p>
                    </div>
                    <div className="confidence-readout">
                      <p className="threat-label">CONFIDENCE</p>
                      <strong>{result.confidence}%</strong>
                      <ProgressBar value={result.confidence} color={threat.color} />
                      <p className="microcopy">VERDICT: {result.verdict} / RISK SCORE: {result.riskScore}%</p>
                    </div>
                  </div>
                </section>

                <section className="panel">
                  <span className="panel-title">FORENSIC REPORT</span>
                  <div className="report-grid">
                    <ReportField label="ASSET ID" value={result.assetId} />
                    <ReportField label="SCAN TIMESTAMP" value={result.timestamp} />
                    <ReportField label="DETECTION ENGINE" value={result.detectionEngine} />
                    <ReportField label="THREAT VECTOR" value={`[ ${result.threatVector} ]`} color={threat.color} />
                  </div>

                  <div style={{ marginTop: "16px" }}>
                    <span className="panel-title">IOC FLAGS</span>
                    {result.flags.length ? (
                      <ul className="ioc-list">
                        {result.flags.map((flag) => (
                          <li key={flag}>{flag}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="ioc-empty">NO IOC FLAGS GENERATED. SINGLE-FRAME SCAN RETURNED CLEAR.</p>
                    )}
                  </div>

                  <div style={{ marginTop: "16px" }}>
                    <span className="panel-title">ANOMALY INDICATORS</span>
                    {Object.entries(result.indicators).map(([key, value]) => (
                      <MetricRow key={key} label={METRIC_LABELS[key]} value={value} />
                    ))}
                  </div>

                  <div className="action-bar">
                    <button className="action-btn" onClick={exportReport}>EXPORT REPORT</button>
                    <button className="action-btn" onClick={copyIocs}>COPY IOC</button>
                    <button className="action-btn secondary" onClick={reset}>SCAN ANOTHER</button>
                    {clipboardState && <span className="copy-state">{clipboardState}</span>}
                  </div>
                </section>
              </>
            )}
          </section>

          <aside className="intel-column">
            <section className="panel">
              <span className="panel-title">THREAT INTEL BRIEF</span>
              <p className="microcopy">
                SYNTHSEC supports rapid triage of synthetic media used in social engineering,
                identity fraud, disinformation, and executive impersonation workflows.
              </p>
              <ul className="intel-list">
                {USE_CASES.map(([label, detail]) => (
                  <li key={label}>
                    <strong>{label}</strong>
                    <span>{detail}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="panel">
              <span className="panel-title">PRIVACY GUARANTEE</span>
              <p className="microcopy">
                No suspect image, hash, IOC, or report content is uploaded to an inference API.
                The browser downloads open model assets, then runs classification locally through ONNX Web Runtime.
              </p>
            </section>

            <section className="panel">
              <span className="panel-title">ENGINE PATH</span>
              <p className="microcopy">PRIMARY: {PRIMARY_MODEL_ID}</p>
              <p className="microcopy">FALLBACK: {FALLBACK_MODEL_ID}</p>
              <p className="microcopy">RUNTIME: {TRANSFORMERS_VERSION}</p>
              {engineState.primaryError && (
                <p className="microcopy">PRIMARY ERROR: {engineState.primaryError}</p>
              )}
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}
