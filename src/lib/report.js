// Builds the scan report. One structured object is the single source of truth;
// the text report, the JSON export and the "copy findings" summary are all
// rendered from it, so they can never disagree.
//
// Wording matters here: the classifier produces a probability and a verdict,
// not indicators of compromise. Findings are reasons for an analyst to look
// closer, and every number is labelled as model output.

import { formatProbability, THRESHOLDS } from "./analysis.js";

export const REPORT_SCHEMA = "synthsec.report/v1";

const DISCLAIMER =
  "Automated triage only. The probability is the model's output, not the chance the verdict is correct. " +
  "Corroborate with provenance checks before acting; do not use as the sole basis for legal, employment, " +
  "financial or identity-verification decisions.";

export function buildReport({ result, file, model, runtime, appVersion, generatedAt = new Date().toISOString() }) {
  return {
    schema: REPORT_SCHEMA,
    generatedAt,
    generator: { name: "SYNTHSEC", version: appVersion },
    file: {
      name: file.name,
      declaredMediaType: file.type || null,
      detectedFormat: result.metadata.format?.name ?? null,
      sizeBytes: file.size,
      sha256: file.sha256,
      width: result.image.width,
      height: result.image.height,
      jpegQualityEstimate: result.metadata.jpegQuality ?? null,
    },
    scan: {
      startedAt: result.timestamp,
      durationMs: result.durationMs ?? null,
      preparedImage: result.image.preparedSize || { width: result.image.width, height: result.image.height },
    },
    model: {
      id: model.id,
      revision: model.revision,
      dtype: model.dtype,
      name: model.name,
      runtime,
      card: model.card,
      paper: model.paper,
    },
    rawScores: {
      output: "sigmoid(logit) = model probability that the image is generated",
      views: result.views.map((view) => ({
        view: view.name,
        logit: view.logit,
        probability: view.fakeProbability,
      })),
      meanProbability: result.probability,
      spread: result.spread,
    },
    interpretation: {
      verdict: result.verdict,
      label: result.label,
      level: result.level,
      summary: result.summary,
      thresholds: {
        noSignalAtOrBelow: THRESHOLDS.noSignal,
        likelySyntheticAtOrAbove: THRESHOLDS.likelySynthetic,
        maxViewSpread: THRESHOLDS.maxViewSpread,
      },
      stableAcrossViews: !result.unstable,
      inputCondition: result.degradation,
      reasons: result.reasons,
      caveats: result.caveats,
    },
    metadata: {
      generatorMarkers: result.metadata.generatorMarkers,
      c2paManifestPresent: result.metadata.hasC2pa,
      camera: result.metadata.camera,
      software: result.metadata.software,
    },
    findings: result.findings.map(({ tone, title, detail }) => ({ severity: tone, title, detail })),
    disclaimer: DISCLAIMER,
  };
}

// Raw scores keep two decimals, but never print an inexact value as 0% / 100%.
export const formatRawProbability = (p) => {
  const text = `${(p * 100).toFixed(2)}%`;
  if (text === "100.00%" && p < 1) return ">99.99%";
  if (text === "0.00%" && p > 0) return "<0.01%";
  return text;
};
const bytes = (n) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(2)} MB`);

function findingLines(report) {
  return report.findings.length
    ? report.findings.map((f) => `  - [${f.severity.toUpperCase()}] ${f.title}: ${f.detail}`)
    : ["  - None. The scan raised no risk or review findings."];
}

export function reportToText(report) {
  const { file, scan, model, rawScores, interpretation: it, metadata } = report;
  const t = it.thresholds;
  return [
    "===== SYNTHSEC SCAN REPORT =====",
    `Report schema  : ${report.schema}`,
    `Generated      : ${report.generatedAt} by SYNTHSEC ${report.generator.version}`,
    "",
    "FILE",
    `  Name         : ${file.name}`,
    `  SHA-256      : ${file.sha256}`,
    `  Size         : ${bytes(file.sizeBytes)} (${file.sizeBytes} bytes)`,
    `  Format       : ${file.detectedFormat ?? "unknown"} (browser-declared: ${file.declaredMediaType ?? "none"})`,
    `  Dimensions   : ${file.width}x${file.height}`,
    `  JPEG quality : ${file.jpegQualityEstimate ?? "n/a"}${file.jpegQualityEstimate ? " (estimated)" : ""}`,
    "",
    "SCAN",
    `  Started      : ${scan.startedAt}`,
    `  Duration     : ${scan.durationMs == null ? "n/a" : `${Math.round(scan.durationMs)} ms`}`,
    `  Prepared image: ${scan.preparedImage.width}x${scan.preparedImage.height} (before model preprocessing)`,
    "",
    "MODEL",
    `  ID           : ${model.id}`,
    `  Revision     : ${model.revision}`,
    `  Weights      : ${model.dtype}`,
    `  Runtime      : ${model.runtime}`,
    `  Model card   : ${model.card}`,
    "",
    "RAW MODEL OUTPUT",
    `  Output       : ${rawScores.output}`,
    ...rawScores.views.map((v) => `  ${v.view.padEnd(12)} : logit ${v.logit.toFixed(4)} -> ${formatRawProbability(v.probability)}`),
    `  Mean         : ${formatRawProbability(rawScores.meanProbability)}`,
    `  View spread  : ${formatRawProbability(rawScores.spread)}`,
    "",
    "INTERPRETATION",
    `  Verdict      : ${it.label} (threat level ${it.level})`,
    `  Rule         : <= ${formatProbability(t.noSignalAtOrBelow)} no signal, >= ${formatProbability(t.likelySyntheticAtOrAbove)} likely synthetic, between is inconclusive; views must agree`,
    `  Input        : ${it.inputCondition.level}${it.inputCondition.causes.length ? ` (${it.inputCondition.causes.join("; ")})` : ""}`,
    `  Summary      : ${it.summary}`,
    "",
    "  Why this verdict:",
    ...it.reasons.map((r) => `    - ${r.title}: ${r.detail}`),
    "",
    "  Limits of this result:",
    ...it.caveats.map((c) => `    - ${c}`),
    "",
    "EMBEDDED METADATA",
    `  Generator markers : ${metadata.generatorMarkers.length ? metadata.generatorMarkers.join("; ") : "none found"}`,
    `  C2PA manifest     : ${metadata.c2paManifestPresent ? "present (not verified)" : "not found"}`,
    `  Camera EXIF       : ${metadata.camera ?? "none"}`,
    `  Software EXIF     : ${metadata.software ?? "none"}`,
    "",
    "FINDINGS FOR REVIEW",
    ...findingLines(report),
    "",
    report.disclaimer,
    "================================",
  ].join("\n");
}

// Short plain-text summary for pasting into a ticket or chat.
export function findingsToText(report) {
  const { file, scan, model, rawScores, interpretation: it } = report;
  return [
    `SYNTHSEC findings: ${file.name}`,
    `SHA-256: ${file.sha256}`,
    `Verdict: ${it.label} (threat level ${it.level})`,
    `Model probability (generated image): ${formatRawProbability(rawScores.meanProbability)}, mean of ${rawScores.views.length} views. This is model output, not the chance the verdict is correct.`,
    `Model: ${model.id}@${model.revision.slice(0, 7)} (${model.dtype})`,
    `Scanned: ${scan.startedAt}`,
    "",
    "Findings for review:",
    ...findingLines(report),
    "",
    `Summary: ${it.summary}`,
  ].join("\n");
}

export function reportFilename(report, extension) {
  const stamp = report.scan.startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `synthsec-${report.file.sha256.slice(0, 12)}-${stamp}.${extension}`;
}
