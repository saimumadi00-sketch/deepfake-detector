import { useCallback, useEffect, useRef, useState } from "react";
import { assess, formatProbability, THRESHOLDS } from "./lib/analysis.js";
import { decodeViews, loadEngine, MODEL, RUNTIME, scoreViews } from "./lib/engine.js";
import { describeEngineError, describeReadError, describeScanError } from "./lib/errors.js";
import { createValidatedPreview, LIMITS, validateFileInfo } from "./lib/ingest.js";
import { scanMetadata } from "./lib/metadata.js";
import { buildReport, findingsToText, formatRawProbability, reportFilename, reportToText } from "./lib/report.js";
import packageInfo from "../package.json";

// Each line is a real pipeline stage; the console advances as stages finish.
const SCAN_LINES = [
  "Reading embedded metadata...",
  "Decoding image and building original + mirrored views...",
  "Running generated-image detector on both views...",
  "Applying verdict thresholds and stability check...",
  "Compiling analyst report...",
];

const USE_CASES = [
  ["Phishing Defense", "Verify sender identity photos in BEC attacks"],
  ["KYC Fraud Detection", "Screen onboarding photos for synthetic faces"],
  ["OSINT Investigation", "Validate profile images in threat actor profiling"],
  ["Disinformation Intel", "Flag AI-generated personas in influence operations"],
  ["Vishing Analysis", "Authenticate video call frames for impersonation"],
];

const TONE_COLORS = {
  risk: "#ff3158",
  review: "#ffb020",
  clear: "#20e686",
  neutral: "#8aa39a",
};

function clampPercent(value) {
  const safeValue = Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, Math.round(safeValue)));
}

const toPercent = (p) => clampPercent(p * 100);

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function downloadFile(filename, contents, type) {
  const blob = new Blob([contents], { type });
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

function ReasonList({ items }) {
  return (
    <ul className="reason-list">
      {items.map((item) => (
        <li key={item.title} style={{ "--tone": TONE_COLORS[item.tone] }}>
          <strong>{item.title}</strong>
          <span>{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function ViewScore({ view }) {
  const value = toPercent(view.fakeProbability);
  const color =
    view.fakeProbability >= THRESHOLDS.likelySynthetic
      ? TONE_COLORS.risk
      : view.fakeProbability > THRESHOLDS.noSignal
        ? TONE_COLORS.review
        : TONE_COLORS.clear;

  return (
    <div className="metric-row">
      <div className="metric-head">
        <span>{view.name.toUpperCase()} VIEW · GENERATED-IMAGE PROBABILITY</span>
        <strong style={{ color }}>{formatProbability(view.fakeProbability)}</strong>
      </div>
      <div className="threshold-track">
        <ProgressBar value={value} color={color} />
        <i style={{ left: `${toPercent(THRESHOLDS.noSignal)}%` }} />
        <i style={{ left: `${toPercent(THRESHOLDS.likelySynthetic)}%` }} />
      </div>
    </div>
  );
}

export default function DeepfakeDetector() {
  // phase: empty -> reading -> ready -> scanning -> result | failed
  const [phase, setPhase] = useState("empty");
  const [asset, setAsset] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [scanLine, setScanLine] = useState(0);
  const [result, setResult] = useState(null);
  const [scanError, setScanError] = useState(null);
  const [ingestError, setIngestError] = useState(null);
  const [notice, setNotice] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [clipboardState, setClipboardState] = useState("");
  const [engineState, setEngineState] = useState({
    status: "loading",
    progress: 0,
    message: "LOADING DETECTION ENGINE...",
  });

  const classifierRef = useRef(null);
  const fileInputRef = useRef(null);
  const fileObjectRef = useRef(null);
  const objectUrlRef = useRef(null);
  const clipboardTimerRef = useRef(null);
  const mountedRef = useRef(true);

  // Every async flow (reading a file, scanning) captures a token. Loading or
  // replacing a file, starting or cancelling a scan, and resetting all issue a
  // new one, so work started earlier can still finish but can no longer touch
  // the screen.
  const tokenRef = useRef(0);
  const nextToken = () => ++tokenRef.current;
  const isCurrent = (token) => mountedRef.current && tokenRef.current === token;

  // loadEngine() clears its cached promise on failure, so calling this again
  // after an error performs a genuine retry.
  const startEngine = useCallback(() => {
    setEngineState({ status: "loading", progress: 0, message: "LOADING DETECTION ENGINE..." });
    loadEngine((update) => {
      if (!mountedRef.current) return;
      setEngineState((current) => (current.status === "loading" ? { ...current, ...update } : current));
    })
      .then((classifier) => {
        if (!mountedRef.current) return;
        classifierRef.current = classifier;
        setEngineState({ status: "ready", progress: 100, message: "DETECTION ENGINE ONLINE" });
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        setEngineState({ status: "error", progress: 0, error: describeEngineError(error) });
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    startEngine();
    return () => {
      mountedRef.current = false;
      clearTimeout(clipboardTimerRef.current);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, [startEngine]);

  const clearImage = () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    fileObjectRef.current = null;
    setAsset(null);
    setImageUrl(null);
    setResult(null);
    setScanError(null);
    setScanLine(0);
    setPhase("empty");
  };

  const flashClipboard = (message) => {
    clearTimeout(clipboardTimerRef.current);
    setClipboardState(message);
    clipboardTimerRef.current = setTimeout(() => setClipboardState(""), 1800);
  };

  const rejectFile = (token, problem) => {
    if (!isCurrent(token)) return;
    clearImage();
    setIngestError(typeof problem === "string" ? { title: problem } : problem);
  };

  const loadImage = async (file) => {
    if (!file) return;
    // Cheap checks first. A rejected replacement leaves the current image,
    // scan and result untouched.
    const problem = validateFileInfo(file);
    if (problem) {
      setIngestError({ title: problem });
      return;
    }

    const token = nextToken();
    setIngestError(null);
    clearTimeout(clipboardTimerRef.current);
    setClipboardState("");
    clearImage();
    fileObjectRef.current = file;
    setPhase("reading");

    let buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (error) {
      rejectFile(token, describeReadError(error));
      return;
    }
    if (!isCurrent(token)) return;

    const name = file.name || "unnamed file";
    let hash;
    try {
      hash = await sha256Hex(buffer);
    } catch (error) {
      rejectFile(token, describeReadError(error));
      return;
    }
    if (!isCurrent(token)) return;

    try {
      const preview = await createValidatedPreview(file, buffer, () => isCurrent(token));
      if (!preview) return;
      // Reset/replacement can run between the helper resolving and this turn.
      if (!isCurrent(token)) {
        URL.revokeObjectURL(preview.url);
        return;
      }
      objectUrlRef.current = preview.url;
      setImageUrl(preview.url);
      setAsset({ id: hash, name, type: file.type || "unknown", size: file.size, buffer, width: preview.width, height: preview.height });
      setPhase("ready");
    } catch (error) {
      rejectFile(token, error.message);
    }
  };

  const takeFiles = (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setNotice(list.length > 1 ? `${list.length} files received; only "${list[0].name}" was loaded.` : "");
    loadImage(list[0]);
  };

  const openPicker = () => fileInputRef.current?.click();

  const dragHandlers = {
    onDragOver: (event) => {
      event.preventDefault();
      setDragOver(true);
    },
    onDragLeave: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setDragOver(false);
    },
    onDrop: (event) => {
      event.preventDefault();
      setDragOver(false);
      takeFiles(event.dataTransfer.files);
    },
  };

  const startScan = async () => {
    const file = fileObjectRef.current;
    const scanned = asset;
    if (!file || !scanned || !classifierRef.current) return;

    const token = nextToken();
    const step = (line) => isCurrent(token) && setScanLine(line);
    setPhase("scanning");
    setScanLine(0);
    setResult(null);
    setScanError(null);
    clearTimeout(clipboardTimerRef.current);
    setClipboardState("");

    try {
      const timestamp = new Date().toISOString();
      const started = performance.now();
      const metadata = scanMetadata(scanned.buffer);

      step(1);
      const decoded = await decodeViews(file);
      if (!isCurrent(token)) return;

      step(2);
      const views = await scoreViews(classifierRef.current, decoded.views, () => isCurrent(token));
      if (!isCurrent(token) || !views) return;

      step(3);
      const image = { width: decoded.width, height: decoded.height, preparedSize: decoded.preparedSize };
      const assessment = assess({ views, image, metadata, model: MODEL });

      step(4);
      setResult({
        ...assessment,
        // Snapshot of the scanned file, so a report can never pair this result
        // with a different file loaded later.
        file: { name: scanned.name, type: scanned.type, size: scanned.size, sha256: scanned.id },
        timestamp,
        durationMs: performance.now() - started,
        image,
        views,
        metadata,
        engine: `${MODEL.id}@${MODEL.revision.slice(0, 7)} (${MODEL.dtype}) via ${RUNTIME}`,
      });
      setPhase("result");
    } catch (error) {
      if (!isCurrent(token)) return;
      setScanError(describeScanError(error));
      setPhase("failed");
    }
  };

  // Keeps the file. A running model call finishes in the background; queued
  // work and remaining views are skipped once their token is stale.
  const cancelScan = () => {
    nextToken();
    setScanLine(0);
    setPhase("ready");
  };

  const reset = () => {
    nextToken();
    clearImage();
    setIngestError(null);
    setNotice("");
    clearTimeout(clipboardTimerRef.current);
    setClipboardState("");
  };

  // Built at export time so generatedAt reflects when the report was produced.
  const currentReport = () =>
    buildReport({ result, file: result.file, model: MODEL, runtime: RUNTIME, appVersion: packageInfo.version });

  const exportText = () => {
    if (!result) return;
    const report = currentReport();
    downloadFile(reportFilename(report, "txt"), reportToText(report), "text/plain;charset=utf-8");
  };

  const exportJson = () => {
    if (!result) return;
    const report = currentReport();
    downloadFile(reportFilename(report, "json"), `${JSON.stringify(report, null, 2)}\n`, "application/json");
  };

  const copyFindings = async () => {
    if (!result) return;
    try {
      await copyText(findingsToText(currentReport()));
      flashClipboard("FINDINGS COPIED");
    } catch {
      flashClipboard("COPY FAILED");
    }
  };

  const engineReady = engineState.status === "ready";
  const canScan = Boolean(asset) && engineReady && (phase === "ready" || phase === "failed");
  const threat = result?.verdict ? result : null;

  const ingestMessages = (
    <>
      {ingestError && (
        <div className="ingest-error" role="alert">
          <strong>{ingestError.title}</strong>
          {ingestError.hint && <span>{ingestError.hint}</span>}
          {ingestError.detail && <span className="error-detail">DETAIL: {ingestError.detail}</span>}
        </div>
      )}
      {notice && <p className="microcopy">{notice}</p>}
    </>
  );

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
        .findings-list {
          display: grid;
          gap: 8px;
          padding: 0;
          margin: 12px 0 0;
          list-style: none;
        }
        .findings-list li {
          display: grid;
          gap: 3px;
          border-left: 2px solid var(--tone);
          background: rgba(255,255,255,.03);
          padding: 8px 10px;
        }
        .findings-list strong {
          color: var(--tone);
          font-size: 12px;
          letter-spacing: .04em;
        }
        .findings-list span {
          color: #c8d8d2;
          font: 12px/1.5 system-ui, sans-serif;
        }
        .findings-empty {
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
        .reason-list,
        .caveat-list {
          display: grid;
          gap: 8px;
          padding: 0;
          margin: 12px 0 0;
          list-style: none;
        }
        .reason-list li {
          border-left: 2px solid var(--tone);
          background: rgba(255,255,255,.03);
          padding: 8px 10px;
        }
        .reason-list strong {
          display: block;
          color: var(--tone);
          font-size: 12px;
          letter-spacing: .04em;
          margin-bottom: 3px;
        }
        .reason-list span,
        .caveat-list li {
          color: #c8d8d2;
          font: 12px/1.5 system-ui, sans-serif;
        }
        .caveat-list li {
          padding-left: 14px;
          position: relative;
          color: #9fb3ac;
        }
        .caveat-list li::before {
          content: "!";
          position: absolute;
          left: 0;
          color: #ffb020;
          font-family: "Courier New", monospace;
          font-weight: 700;
        }
        .threshold-track {
          position: relative;
        }
        .threshold-track i {
          position: absolute;
          top: -3px;
          width: 1px;
          height: 13px;
          background: rgba(255,255,255,.55);
        }
        .microcopy a {
          color: #20e686;
        }
        .ingest-error {
          display: grid;
          gap: 4px;
          margin: 12px 0 0;
          border-left: 2px solid #ff3158;
          background: rgba(255,49,88,.07);
          color: #ffd5dc;
          padding: 9px 11px;
          font: 12px/1.5 system-ui, sans-serif;
        }
        .ingest-error strong {
          color: #ffd5dc;
          font-weight: 600;
        }
        .error-detail {
          color: #b88d95;
          font: 11px/1.45 "Courier New", monospace;
          word-break: break-word;
        }
        .error-title,
        .engine-error-title {
          color: #ff8fa3 !important;
          font-weight: 700;
        }
        .error-panel p {
          margin: 6px 0 0;
          font: 13px/1.5 system-ui, sans-serif;
        }
        .ingest-panel.dragging {
          border-color: rgba(32,230,134,.75);
        }
        .drop-overlay {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          background: rgba(5,6,8,.78);
          border: 2px dashed rgba(32,230,134,.8);
          border-radius: 8px;
          color: #20e686;
          font-size: 14px;
          letter-spacing: .14em;
          pointer-events: none;
        }
        .upload-zone:focus-visible,
        button:focus-visible {
          outline: 2px solid #20e686;
          outline-offset: 2px;
        }
        .upload-limits {
          margin-top: 10px !important;
          font-size: 11px !important;
          color: #5f746b !important;
        }
        .control-row {
          display: flex;
          gap: 8px;
          margin-top: 8px;
        }
        .control-row .action-btn {
          flex: 1 1 0;
        }
        .retry-btn {
          width: 100%;
          margin-top: 10px;
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
            <strong>
              {engineState.status === "ready"
                ? "ENGINE READY"
                : engineState.status === "error"
                  ? "ENGINE OFFLINE"
                  : "LOADING DETECTION ENGINE..."}
            </strong>
            <ProgressBar
              value={engineState.status === "error" ? 100 : engineState.progress}
              color={engineState.status === "error" ? "#ff3158" : "#20e686"}
            />
            {engineState.status === "error" ? (
              <>
                <p className="engine-error-title">{engineState.error.title}</p>
                <p>{engineState.error.hint}</p>
                <p>DETAIL: {engineState.error.detail}</p>
                <button className="action-btn retry-btn" onClick={startEngine}>
                  RETRY ENGINE LOAD
                </button>
              </>
            ) : (
              <p>
                {engineState.message}
                {engineState.status === "loading" && engineState.progress > 0 && ` · ${engineState.progress}%`}
              </p>
            )}
            <p>MODEL: {MODEL.id}</p>
          </aside>
        </header>

        <div className="terminal-grid">
          <section className="workspace">
            <section className={dragOver ? "panel ingest-panel dragging" : "panel ingest-panel"} {...dragHandlers}>
              <span className="panel-title">MEDIA INGEST</span>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                  takeFiles(event.target.files);
                  // Clear so choosing the same file again still fires onChange.
                  event.target.value = "";
                }}
              />
              {!imageUrl && (
                <div
                  className={dragOver ? "upload-zone dragging" : "upload-zone"}
                  role="button"
                  tabIndex={0}
                  aria-label="Select or drop an image to scan"
                  onClick={openPicker}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openPicker();
                    }
                  }}
                >
                  <div>
                    <div className="upload-glyph">⬆</div>
                    <h2>DROP SUSPECT MEDIA FRAME</h2>
                    <p>or click / press Enter to choose a file</p>
                    <p className="upload-limits">
                      JPG, PNG, WebP, AVIF, GIF or BMP · up to {LIMITS.maxFileBytes / (1024 * 1024)} MB and{" "}
                      {LIMITS.maxPixels / 1e6} MP
                    </p>
                  </div>
                </div>
              )}
              {!imageUrl && ingestMessages}
              {!imageUrl && phase === "reading" && (
                <div>
                  <p className="microcopy" role="status">VALIDATING &amp; HASHING: {fileObjectRef.current?.name}</p>
                  <button className="action-btn secondary" onClick={reset}>CLEAR</button>
                </div>
              )}
              {imageUrl && (
                <>
                  <div className="preview-wrap">
                    <img src={imageUrl} alt={`Preview of ${asset?.name || "the selected image"}`} />
                    {phase === "scanning" && <div className="scan-overlay" />}
                    {dragOver && <div className="drop-overlay">DROP TO REPLACE</div>}
                  </div>
                  <div className="preview-meta">
                    <div>
                      <span>ASSET ID (SHA-256)</span>
                      <strong>{asset?.id || "HASHING..."}</strong>
                    </div>
                    <div>
                      <span>FILENAME</span>
                      <strong>{asset?.name || fileObjectRef.current?.name || "PENDING"}</strong>
                    </div>
                    <div>
                      <span>SIZE · DIMENSIONS</span>
                      <strong>{asset ? `${formatBytes(asset.size)} · ${asset.width}×${asset.height}` : "READING..."}</strong>
                    </div>
                  </div>

                  {(phase === "reading" || phase === "ready" || phase === "failed") && (
                    <>
                      <button className="primary-btn" onClick={startScan} disabled={!canScan}>
                        {phase === "reading" ? "VALIDATING & HASHING..." : phase === "failed" ? "RETRY SCAN" : "INITIATE FORENSIC SCAN"}
                      </button>
                      <div className="control-row">
                        <button className="action-btn secondary" onClick={openPicker}>
                          REPLACE FILE
                        </button>
                        <button className="action-btn secondary" onClick={reset}>
                          CLEAR
                        </button>
                      </div>
                    </>
                  )}
                  {phase === "scanning" && (
                    <div className="control-row">
                      <button className="action-btn secondary" onClick={cancelScan}>
                        CANCEL SCAN
                      </button>
                      <button className="action-btn secondary" onClick={openPicker}>
                        REPLACE FILE
                      </button>
                    </div>
                  )}
                  {/* Next to the controls, so a rejected replacement is seen where the user acted. */}
                  {ingestMessages}
                  {engineState.status === "loading" && phase !== "reading" && (
                    <p className="microcopy">Scanning unlocks when the detection engine finishes loading.</p>
                  )}
                  {engineState.status === "error" && (
                    <p className="microcopy">Scanning is disabled because the detection model failed to load. Use RETRY ENGINE LOAD above.</p>
                  )}
                </>
              )}
            </section>

            {phase === "scanning" && <ScanAnimation lines={SCAN_LINES} currentLine={scanLine} />}

            {phase === "failed" && scanError && (
              <section className="panel error-panel" role="alert">
                <span className="panel-title">ANALYSIS FAILURE · NO VERDICT PRODUCED</span>
                <p className="error-title">{scanError.title}</p>
                <p>{scanError.hint}</p>
                <p className="error-detail">DETAIL: {scanError.detail}</p>
              </section>
            )}

            {phase === "result" && threat && (
              <>
                <section
                  className="panel threat-panel"
                  style={{ "--threat-color": threat.color, "--threat-soft": threat.soft }}
                >
                  <div className="threat-grid">
                    <div>
                      <p className="threat-label">VERDICT · THREAT LEVEL {result.level}</p>
                      <h2 className="threat-value">{result.label}</h2>
                      <p className="threat-summary">{result.summary}</p>
                    </div>
                    <div className="confidence-readout">
                      <p className="threat-label">GENERATED-IMAGE PROBABILITY</p>
                      <strong>{formatProbability(result.probability)}</strong>
                      <ProgressBar value={toPercent(result.probability)} color={threat.color} />
                      <p className="microcopy">
                        Mean of {result.views.length} views. ≤{toPercent(THRESHOLDS.noSignal)}% no signal ·
                        ≥{toPercent(THRESHOLDS.likelySynthetic)}% likely synthetic · between is inconclusive.
                        This is the model's output, not the chance the verdict is correct.
                      </p>
                    </div>
                  </div>
                </section>

                <section className="panel">
                  <span className="panel-title">WHY THIS VERDICT</span>
                  <ReasonList items={result.reasons} />

                  <div style={{ marginTop: "16px" }}>
                    <span className="panel-title">MODEL SCORES BY VIEW</span>
                    <p className="microcopy">
                      The image is scored as-is and mirrored. A genuine signal should survive mirroring;
                      if the views disagree, the verdict is held at INCONCLUSIVE. Tick marks show the thresholds.
                    </p>
                    {result.views.map((view) => (
                      <ViewScore key={view.name} view={view} />
                    ))}
                  </div>

                  <div style={{ marginTop: "16px" }}>
                    <span className="panel-title">LIMITS OF THIS RESULT</span>
                    <ul className="caveat-list">
                      {result.caveats.map((caveat) => (
                        <li key={caveat}>{caveat}</li>
                      ))}
                    </ul>
                  </div>
                </section>

                <section className="panel">
                  <span className="panel-title">SCAN REPORT</span>
                  <div className="report-grid">
                    <ReportField label="FILENAME" value={result.file.name} />
                    <ReportField label="SHA-256" value={result.file.sha256} />
                    <ReportField label="SCAN STARTED" value={result.timestamp} />
                    <ReportField label="SCAN DURATION" value={`${Math.round(result.durationMs)} ms`} />
                    <ReportField label="DETECTION ENGINE" value={result.engine} />
                    <ReportField label="MODEL REVISION" value={MODEL.revision} />
                    <ReportField
                      label="RAW OUTPUT (LOGIT → PROBABILITY)"
                      value={result.views
                        .map((v) => `${v.name}: ${v.logit.toFixed(3)} → ${formatRawProbability(v.fakeProbability)}`)
                        .join(" · ")}
                    />
                    <ReportField label="DIMENSIONS" value={`${result.image.width} × ${result.image.height} px`} />
                    <ReportField label="FORMAT (FROM FILE BYTES)" value={result.metadata.format.name} />
                    <ReportField
                      label="JPEG QUALITY (EST.)"
                      value={result.metadata.jpegQuality ?? "N/A (NOT A JPEG)"}
                    />
                    <ReportField label="INPUT CONDITION" value={{ severe: "DEGRADED", mild: "SOME QUALITY LOSS", clean: "CLEAN" }[result.degradation.level]} />
                  </div>

                  <div style={{ marginTop: "16px" }}>
                    <span className="panel-title">FINDINGS FOR REVIEW</span>
                    <p className="microcopy">
                      Reasons to look closer, taken from the verdict above. These are classifier observations,
                      not indicators of compromise.
                    </p>
                    {result.findings.length ? (
                      <ul className="findings-list">
                        {result.findings.map((finding) => (
                          <li key={finding.title} style={{ "--tone": TONE_COLORS[finding.tone] }}>
                            <strong>
                              [{finding.tone.toUpperCase()}] {finding.title}
                            </strong>
                            <span>{finding.detail}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="findings-empty">NONE. THE SCAN RAISED NO RISK OR REVIEW FINDINGS.</p>
                    )}
                  </div>

                  <div className="action-bar">
                    <button className="action-btn" onClick={exportText}>EXPORT TEXT</button>
                    <button className="action-btn" onClick={exportJson}>EXPORT JSON</button>
                    <button className="action-btn" onClick={copyFindings}>COPY FINDINGS</button>
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
                No image, hash, finding or report content is uploaded to an inference API.
                The browser downloads open model assets, then runs classification locally through ONNX Web Runtime.
              </p>
            </section>

            <section className="panel">
              <span className="panel-title">ENGINE</span>
              <p className="microcopy">MODEL: {MODEL.id}</p>
              <p className="microcopy">REVISION: {MODEL.revision.slice(0, 12)} ({MODEL.dtype})</p>
              <p className="microcopy">RUNTIME: {RUNTIME}</p>
              <p className="microcopy">
                {MODEL.name}, trained on 2.7M images from 4,803 generators (CVPR 2025). Detects fully
                generated images, not edits to real photos. Local check: {MODEL.validation.summary}; no real
                photo scored above {MODEL.validation.realMax}.{" "}
                <a href={MODEL.card} target="_blank" rel="noreferrer">
                  Model card
                </a>{" "}
                ·{" "}
                <a href={MODEL.paper} target="_blank" rel="noreferrer">
                  Paper
                </a>
              </p>
            </section>

            <section className="panel">
              <span className="panel-title">HOW TO READ RESULTS</span>
              <ul className="intel-list">
                <li>
                  <strong style={{ color: TONE_COLORS.risk }}>LIKELY SYNTHETIC</strong>
                  <span>Strong, stable detector signal, or the file declares AI generation. Corroborate before acting.</span>
                </li>
                <li>
                  <strong style={{ color: TONE_COLORS.review }}>INCONCLUSIVE</strong>
                  <span>Middle-band score, unstable across views, too small, or a low score on a degraded file. Tells you nothing either way.</span>
                </li>
                <li>
                  <strong style={{ color: TONE_COLORS.clear }}>NO SYNTHETIC SIGNAL</strong>
                  <span>Low score on a reasonably clean file. Not proof of authenticity.</span>
                </li>
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}
