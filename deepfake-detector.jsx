import { useState, useRef, useCallback } from "react";

const SCAN_LINES = [
  "Initializing neural mesh analysis...",
  "Scanning facial geometry vectors...",
  "Checking temporal consistency...",
  "Analyzing micro-expression patterns...",
  "Cross-referencing GAN artifact signatures...",
  "Validating pixel-level coherence...",
  "Running frequency domain analysis...",
  "Consulting deepfake signature database...",
  "Finalizing forensic verdict...",
];

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
  const [imageBase64, setImageBase64] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle | scanning | result | error
  const [scanLine, setScanLine] = useState(0);
  const [result, setResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef();
  const scanIntervalRef = useRef();

  const loadImage = useCallback((file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    setImage(url);
    setResult(null);
    setPhase("idle");

    const reader = new FileReader();
    reader.onload = (e) => {
      const b64 = e.target.result.split(",")[1];
      setImageBase64(b64);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    loadImage(file);
  };

  const startScan = async () => {
    if (!imageBase64) return;
    setPhase("scanning");
    setScanLine(0);
    setResult(null);

    // Animate scan lines
    let line = 0;
    scanIntervalRef.current = setInterval(() => {
      line++;
      setScanLine(line);
      if (line >= SCAN_LINES.length - 1) clearInterval(scanIntervalRef.current);
    }, 600);

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: imageBase64 }
              },
              {
                type: "text",
                text: `You are a forensic deepfake detection AI. Analyze this image and determine if it is AI-generated, a deepfake, or authentic. 

Respond ONLY with a JSON object (no markdown, no backticks) with these exact fields:
{
  "verdict": "AUTHENTIC" | "DEEPFAKE" | "SUSPICIOUS",
  "confidence": <number 0-100>,
  "summary": "<1-2 sentence plain English explanation>",
  "indicators": {
    "facial_geometry": <0-100, higher = more anomalous>,
    "texture_coherence": <0-100, higher = more anomalous>,
    "lighting_consistency": <0-100, higher = more anomalous>,
    "artifact_score": <0-100, higher = more anomalous>,
    "temporal_signature": <0-100, higher = more anomalous>
  },
  "flags": ["<flag1>", "<flag2>"] // list of specific anomalies found, or [] if none
}

Be honest. If the image is clearly a real photo, say AUTHENTIC. If it shows AI generation artifacts, say DEEPFAKE or SUSPICIOUS.`
              }
            ]
          }]
        })
      });

      const data = await response.json();
      const text = data.content?.find(b => b.type === "text")?.text || "";
      const cleaned = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);

      // Wait for scan animation to finish
      await new Promise(r => setTimeout(r, Math.max(0, (SCAN_LINES.length - scanLine) * 600 + 800)));
      clearInterval(scanIntervalRef.current);
      setScanLine(SCAN_LINES.length - 1);
      await new Promise(r => setTimeout(r, 400));

      setResult(parsed);
      setPhase("result");
    } catch (err) {
      clearInterval(scanIntervalRef.current);
      setPhase("error");
      setResult({ error: err.message });
    }
  };

  const reset = () => {
    setImage(null);
    setImageBase64(null);
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
          POWERED BY CLAUDE VISION · FOR EDUCATIONAL USE ONLY
        </p>
      </div>
    </div>
  );
}
