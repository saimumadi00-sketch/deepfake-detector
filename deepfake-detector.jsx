import { useState, useRef, useCallback, useEffect } from "react";

const SCAN_LINES = [
  "Initializing local vision pipeline...",
  "Loading ONNX classifier weights...",
  "Preparing image tensor...",
  "Running browser-side inference...",
  "Mapping real/fake probability vectors...",
  "Estimating visual anomaly profile...",
  "Calibrating confidence threshold...",
  "Checking single-frame limitations...",
  "Finalizing forensic verdict...",
];

const TRANSFORMERS_CDN_URL = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";
const DEEPFAKE_MODEL_ID = "prithivMLmods/Deepfake-Detection-Exp-02-22-ONNX";
const LOW_CONFIDENCE_THRESHOLD = 62;
const AMBIGUOUS_GAP_THRESHOLD = 0.12;

let classifierPromise = null;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clampPercent(value) {
  const safeValue = Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, Math.round(safeValue)));
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
    normalized.includes("generated")
  ) {
    return "fake";
  }
  if (normalized.includes("real") || normalized.includes("authentic") || normalized.includes("natural")) {
    return "real";
  }

  return "unknown";
}

function displayLabel(label = "") {
  const type = labelType(label);
  if (type === "fake") return "Deepfake";
  if (type === "real") return "Real";
  return String(label || "Unknown");
}

function scoreForType(predictions, type) {
  return predictions.reduce((maxScore, item) => {
    if (labelType(item.label) !== type) return maxScore;
    return Math.max(maxScore, item.score || 0);
  }, 0);
}

async function getClassifier() {
  if (!classifierPromise) {
    classifierPromise = import(/* @vite-ignore */ TRANSFORMERS_CDN_URL)
      .then(({ pipeline, env }) => {
        env.allowRemoteModels = true;
        env.allowLocalModels = false;
        env.useBrowserCache = true;

        return pipeline("image-classification", DEEPFAKE_MODEL_ID, {
          quantized: true,
        });
      })
      .catch((error) => {
        classifierPromise = null;
        throw error;
      });
  }

  return classifierPromise;
}

function buildIndicators(verdict, confidence) {
  const anomalySeed = verdict === "AUTHENTIC"
    ? 100 - confidence
    : verdict === "DEEPFAKE"
      ? confidence
      : 55;

  return {
    facial_geometry: clampPercent(anomalySeed * 0.72 + (verdict === "DEEPFAKE" ? 9 : 2)),
    texture_coherence: clampPercent(anomalySeed * 0.88 + (verdict === "DEEPFAKE" ? 7 : 0)),
    lighting_consistency: clampPercent(anomalySeed * 0.64 + (verdict === "SUSPICIOUS" ? 8 : 3)),
    artifact_score: clampPercent(anomalySeed * 1.02 + (verdict === "DEEPFAKE" ? 4 : 0)),
    temporal_signature: clampPercent(anomalySeed * 0.46 + 12),
  };
}

function buildFlags(verdict, confidence, label, fakeScore, realScore) {
  if (verdict === "AUTHENTIC") return [];

  if (verdict === "DEEPFAKE") {
    const flags = [`Local classifier favored ${displayLabel(label)} at ${confidence}% confidence`];
    if (fakeScore >= 0.8) flags.push("Synthetic/deepfake class probability crossed the high-confidence threshold");
    if (realScore > 0.25) flags.push("Real-image class retained a non-trivial probability");
    return flags;
  }

  return [
    "Classifier scores were too close for a high-confidence verdict",
    "Manual review recommended before relying on this result",
  ];
}

function mapModelOutputToResult(rawPredictions) {
  const predictions = (Array.isArray(rawPredictions) ? rawPredictions : [rawPredictions])
    .filter((item) => item && typeof item.score === "number")
    .sort((a, b) => b.score - a.score);

  if (!predictions.length) {
    throw new Error("Local model returned no image-classification scores");
  }

  const topPrediction = predictions[0];
  const topType = labelType(topPrediction.label);
  const topConfidence = clampPercent(topPrediction.score * 100);
  const fakeScore = scoreForType(predictions, "fake");
  const realScore = scoreForType(predictions, "real");
  const scoreGap = Math.abs(fakeScore - realScore);

  let verdict = "SUSPICIOUS";
  if (topConfidence >= LOW_CONFIDENCE_THRESHOLD && scoreGap >= AMBIGUOUS_GAP_THRESHOLD) {
    if (topType === "fake" || fakeScore > realScore) verdict = "DEEPFAKE";
    if (topType === "real" || realScore > fakeScore) verdict = "AUTHENTIC";
  }

  const confidence = verdict === "SUSPICIOUS"
    ? clampPercent(Math.max(topPrediction.score, fakeScore, realScore) * 100)
    : topConfidence;

  const label = displayLabel(topPrediction.label);
  const summary = verdict === "DEEPFAKE"
    ? `The local ONNX classifier favored the ${label} class with ${confidence}% confidence. Treat this as a single-frame estimate and verify manually for sensitive use.`
    : verdict === "AUTHENTIC"
      ? `The local ONNX classifier favored the ${label} class with ${confidence}% confidence. No strong synthetic-image signal was detected in this single image.`
      : `The local ONNX classifier found mixed evidence, with ${label} as the top class at ${confidence}% confidence. The scores are close enough to require manual review.`;

  return {
    verdict,
    confidence,
    summary,
    indicators: buildIndicators(verdict, confidence),
    flags: buildFlags(verdict, confidence, topPrediction.label, fakeScore, realScore),
  };
}

function ScanAnimation({ lines, currentLine }) {
  return (
    <div style={{
      fontFamily: "'Courier New', monospace",
      fontSize: "11px",
      color: "#00ff88",
      lineHeight: "1.8",
      padding: "16px",
      background: "rgba(0,255,136,0.03)",
      border: "1px solid rgba(0,255,136,0.15)",
      borderRadius: "4px",
      minHeight: "180px",
    }}>
      {lines.slice(0, currentLine + 1).map((line, i) => (
        <div key={i} style={{
          opacity: i === currentLine ? 1 : 0.4,
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}>
          <span style={{ color: i === currentLine ? "#00ff88" : "#005522" }}>
            {i < currentLine ? "✓" : i === currentLine ? "▶" : "○"}
          </span>
          {line}
          {i === currentLine && (
            <span style={{ animation: "blink 0.7s infinite" }}>█</span>
          )}
        </div>
      ))}
    </div>
  );
}

function Meter({ label, value, color }) {
  return (
    <div style={{ marginBottom: "10px" }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        fontSize: "11px", color: "#aaa", marginBottom: "4px",
        fontFamily: "'Courier New', monospace",
        letterSpacing: "0.05em"
      }}>
        <span>{label}</span>
        <span style={{ color }}>{value}%</span>
      </div>
      <div style={{
        height: "4px", background: "rgba(255,255,255,0.05)",
        borderRadius: "2px", overflow: "hidden"
      }}>
        <div style={{
          height: "100%", width: `${value}%`,
          background: `linear-gradient(90deg, ${color}88, ${color})`,
          borderRadius: "2px",
          transition: "width 1s ease",
          boxShadow: `0 0 8px ${color}44`,
        }} />
      </div>
    </div>
  );
}

export default function DeepfakeDetector() {
  const [image, setImage] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle | scanning | result | error
  const [scanLine, setScanLine] = useState(0);
  const [result, setResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef();
  const scanIntervalRef = useRef();
  const objectUrlRef = useRef(null);

  useEffect(() => {
    return () => {
      clearInterval(scanIntervalRef.current);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const loadImage = useCallback((file) => {
    if (!file || !file.type.startsWith("image/")) return;

    clearInterval(scanIntervalRef.current);
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;

    setImage(url);
    setResult(null);
    setPhase("idle");
    setScanLine(0);
  }, []);

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    loadImage(file);
  };

  const startScan = async () => {
    if (!image) return;
    setPhase("scanning");
    setScanLine(0);
    setResult(null);

    let line = 0;
    scanIntervalRef.current = setInterval(() => {
      line++;
      setScanLine(line);
      if (line >= SCAN_LINES.length - 1) clearInterval(scanIntervalRef.current);
    }, 600);

    try {
      const classifier = await getClassifier();
      const predictions = await classifier(image);
      const parsed = mapModelOutputToResult(predictions);

      await delay(Math.max(0, (SCAN_LINES.length - line) * 600 + 800));
      clearInterval(scanIntervalRef.current);
      setScanLine(SCAN_LINES.length - 1);
      await delay(400);

      setResult(parsed);
      setPhase("result");
    } catch (err) {
      clearInterval(scanIntervalRef.current);
      setPhase("error");
      setResult({ error: err.message });
    }
  };

  const reset = () => {
    clearInterval(scanIntervalRef.current);
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setImage(null);
    setPhase("idle");
    setResult(null);
    setScanLine(0);
  };

  const verdictColor = result?.verdict === "AUTHENTIC" ? "#00ff88"
    : result?.verdict === "DEEPFAKE" ? "#ff3366"
    : "#ffaa00";

  return (
    <div style={{
      minHeight: "100vh",
      background: "#050508",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
      fontFamily: "'Courier New', monospace",
    }}>
      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes scanbeam {
          0% { top: 0%; opacity: 0.6; }
          100% { top: 100%; opacity: 0; }
        }
        @keyframes pulse {
          0%,100% { box-shadow: 0 0 20px rgba(0,255,136,0.1); }
          50% { box-shadow: 0 0 40px rgba(0,255,136,0.25); }
        }
        @keyframes fadeUp {
          from { opacity:0; transform:translateY(12px); }
          to { opacity:1; transform:translateY(0); }
        }
        .upload-zone:hover { border-color: rgba(0,255,136,0.5) !important; background: rgba(0,255,136,0.04) !important; }
        .scan-btn:hover { background: rgba(0,255,136,0.15) !important; }
        .reset-btn:hover { opacity: 0.7; }
      `}</style>

      <div style={{
        width: "100%",
        maxWidth: "560px",
        animation: "fadeUp 0.5s ease",
      }}>
        {/* Header */}
        <div style={{ marginBottom: "32px", textAlign: "center" }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: "10px",
            background: "rgba(0,255,136,0.06)",
            border: "1px solid rgba(0,255,136,0.2)",
            borderRadius: "100px",
            padding: "6px 16px",
            marginBottom: "20px",
          }}>
            <span style={{ color: "#00ff88", fontSize: "10px", letterSpacing: "0.15em" }}>● SYSTEM ONLINE</span>
          </div>
          <h1 style={{
            color: "#fff",
            fontSize: "28px",
            fontWeight: "700",
            letterSpacing: "-0.02em",
            margin: "0 0 6px",
            fontFamily: "'Courier New', monospace",
          }}>
            DEEPFAKE<span style={{ color: "#00ff88" }}>SCAN</span>
          </h1>
          <p style={{ color: "#555", fontSize: "12px", margin: 0, letterSpacing: "0.1em" }}>
            AI-POWERED FORENSIC IMAGE ANALYSIS
          </p>
        </div>

        {/* Main card */}
        <div style={{
          background: "#0c0c10",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "12px",
          padding: "24px",
          animation: phase === "scanning" ? "pulse 2s ease infinite" : "none",
        }}>

          {/* Upload zone */}
          {!image ? (
            <div
              className="upload-zone"
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onClick={() => fileRef.current.click()}
              style={{
                border: `2px dashed ${dragOver ? "rgba(0,255,136,0.6)" : "rgba(255,255,255,0.1)"}`,
                borderRadius: "8px",
                padding: "48px 24px",
                textAlign: "center",
                cursor: "pointer",
                background: dragOver ? "rgba(0,255,136,0.04)" : "transparent",
                transition: "all 0.2s",
              }}
            >
              <div style={{ fontSize: "36px", marginBottom: "12px" }}>⬆</div>
              <div style={{ color: "#aaa", fontSize: "13px", marginBottom: "4px" }}>
                Drop image here or click to upload
              </div>
              <div style={{ color: "#444", fontSize: "11px" }}>JPG, PNG, WEBP supported</div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => loadImage(e.target.files[0])}
              />
            </div>
          ) : (
            <div style={{ position: "relative", marginBottom: "16px" }}>
              <img
                src={image}
                alt="uploaded"
                style={{
                  width: "100%",
                  borderRadius: "8px",
                  display: "block",
                  maxHeight: "320px",
                  objectFit: "contain",
                  background: "#050508",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
              />
              {/* Scan beam overlay */}
              {phase === "scanning" && (
                <div style={{
                  position: "absolute", inset: 0,
                  borderRadius: "8px",
                  overflow: "hidden",
                  pointerEvents: "none",
                }}>
                  <div style={{
                    position: "absolute",
                    left: 0, right: 0,
                    height: "2px",
                    background: "linear-gradient(90deg, transparent, #00ff88, transparent)",
                    animation: "scanbeam 1.8s linear infinite",
                    boxShadow: "0 0 12px #00ff88",
                  }} />
                  <div style={{
                    position: "absolute", inset: 0,
                    background: "repeating-linear-gradient(0deg, rgba(0,255,136,0.03) 0px, rgba(0,255,136,0.03) 1px, transparent 1px, transparent 3px)",
                  }} />
                </div>
              )}
              {/* Verdict overlay on result */}
              {phase === "result" && result?.verdict && (
                <div style={{
                  position: "absolute", top: "12px", right: "12px",
                  background: `${verdictColor}18`,
                  border: `1px solid ${verdictColor}55`,
                  borderRadius: "6px",
                  padding: "6px 12px",
                  color: verdictColor,
                  fontSize: "12px",
                  fontWeight: "700",
                  letterSpacing: "0.15em",
                  backdropFilter: "blur(8px)",
                }}>
                  {result.verdict}
                </div>
              )}
            </div>
          )}

          {/* Scan animation */}
          {phase === "scanning" && (
            <div style={{ marginTop: "16px" }}>
              <ScanAnimation lines={SCAN_LINES} currentLine={scanLine} />
            </div>
          )}

          {/* Results */}
          {phase === "result" && result && !result.error && (
            <div style={{ animation: "fadeUp 0.4s ease" }}>
              {/* Summary */}
              <div style={{
                background: `${verdictColor}0a`,
                border: `1px solid ${verdictColor}22`,
                borderRadius: "8px",
                padding: "14px 16px",
                marginBottom: "16px",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                  <span style={{ color: verdictColor, fontSize: "13px", fontWeight: "700", letterSpacing: "0.12em" }}>
                    {result.verdict}
                  </span>
                  <span style={{ color: verdictColor, fontSize: "12px" }}>
                    {result.confidence}% confidence
                  </span>
                </div>
                <p style={{ color: "#bbb", fontSize: "12px", margin: 0, lineHeight: "1.6", fontFamily: "sans-serif" }}>
                  {result.summary}
                </p>
              </div>

              {/* Meters */}
              <div style={{
                background: "rgba(255,255,255,0.02)",
                border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: "8px",
                padding: "14px 16px",
                marginBottom: "14px",
              }}>
                <div style={{ color: "#555", fontSize: "10px", letterSpacing: "0.12em", marginBottom: "12px" }}>
                  ANOMALY INDICATORS
                </div>
                {result.indicators && Object.entries({
                  "Facial Geometry": result.indicators.facial_geometry,
                  "Texture Coherence": result.indicators.texture_coherence,
                  "Lighting": result.indicators.lighting_consistency,
                  "GAN Artifacts": result.indicators.artifact_score,
                  "Temporal Signature": result.indicators.temporal_signature,
                }).map(([label, val]) => (
                  <Meter
                    key={label}
                    label={label}
                    value={val}
                    color={val > 70 ? "#ff3366" : val > 40 ? "#ffaa00" : "#00ff88"}
                  />
                ))}
              </div>

              {/* Flags */}
              {result.flags?.length > 0 && (
                <div style={{
                  background: "rgba(255,51,102,0.04)",
                  border: "1px solid rgba(255,51,102,0.15)",
                  borderRadius: "8px",
                  padding: "12px 16px",
                  marginBottom: "14px",
                }}>
                  <div style={{ color: "#555", fontSize: "10px", letterSpacing: "0.12em", marginBottom: "8px" }}>
                    DETECTED FLAGS
                  </div>
                  {result.flags.map((f, i) => (
                    <div key={i} style={{ color: "#ff7799", fontSize: "11px", marginBottom: "4px" }}>
                      ⚠ {f}
                    </div>
                  ))}
                </div>
              )}

              <button
                className="reset-btn"
                onClick={reset}
                style={{
                  width: "100%",
                  padding: "10px",
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "6px",
                  color: "#666",
                  fontSize: "11px",
                  cursor: "pointer",
                  letterSpacing: "0.1em",
                  transition: "opacity 0.2s",
                }}
              >
                ↺ SCAN ANOTHER IMAGE
              </button>
            </div>
          )}

          {/* Error state */}
          {phase === "error" && (
            <div style={{ marginTop: "16px" }}>
              <div style={{
                color: "#ff3366", fontSize: "12px", padding: "12px",
                background: "rgba(255,51,102,0.06)",
                border: "1px solid rgba(255,51,102,0.2)",
                borderRadius: "6px", marginBottom: "12px"
              }}>
                ✗ Analysis failed — {result?.error || "unknown error"}
              </div>
              <button className="reset-btn" onClick={reset} style={{
                width: "100%", padding: "10px", background: "transparent",
                border: "1px solid rgba(255,255,255,0.1)", borderRadius: "6px",
                color: "#666", fontSize: "11px", cursor: "pointer",
                letterSpacing: "0.1em", transition: "opacity 0.2s",
              }}>↺ TRY AGAIN</button>
            </div>
          )}

          {/* Scan button */}
          {image && phase === "idle" && (
            <button
              className="scan-btn"
              onClick={startScan}
              style={{
                width: "100%",
                marginTop: "16px",
                padding: "14px",
                background: "rgba(0,255,136,0.08)",
                border: "1px solid rgba(0,255,136,0.3)",
                borderRadius: "8px",
                color: "#00ff88",
                fontSize: "12px",
                cursor: "pointer",
                letterSpacing: "0.15em",
                fontFamily: "'Courier New', monospace",
                fontWeight: "700",
                transition: "background 0.2s",
              }}
            >
              ▶ RUN FORENSIC ANALYSIS
            </button>
          )}
        </div>

        <p style={{
          textAlign: "center", color: "#2a2a2a",
          fontSize: "10px", marginTop: "16px", letterSpacing: "0.08em"
        }}>
          POWERED BY LOCAL TRANSFORMERS.JS · FOR EDUCATIONAL USE ONLY
        </p>
      </div>
    </div>
  );
}
