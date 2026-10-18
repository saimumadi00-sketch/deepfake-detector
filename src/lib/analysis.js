// Turns raw model scores + measured image facts into a verdict and a plain
// explanation. Pure and deterministic: the same inputs always give the same
// result, and every reason shown to the analyst cites a value measured here.
//
// The rules below come from the local validation run described in the README:
// high scores held up on degraded images (no false positives), but low scores
// did not — recompression and downscaling hid most diffusion images. So a low
// score only counts as "no signal" when the file is reasonably clean.

export const THRESHOLDS = {
  likelySynthetic: 0.8, // mean P(generated) at or above this -> LIKELY_SYNTHETIC
  noSignal: 0.2, // at or below this -> NO_SIGNAL (if the file is clean enough)
  maxViewSpread: 0.25, // views disagreeing by more than this -> unstable
  minTestedSide: 128, // below this nothing was validated -> always INCONCLUSIVE
  degradedSide: 320, // shortest side under this: low scores are not evidence
  degradedQuality: 70, // JPEG quality under this: low scores are not evidence
  softSide: 512, // under this side AND under softQuality: also degraded
  softQuality: 85,
  cleanQuality: 90, // under this (but not degraded): caveat only
};

// Processor geometry: shortest edge -> 440px, then a 384px centre crop.
const RESIZE_EDGE = 440;
const CROP = 384;

export const VERDICTS = {
  LIKELY_SYNTHETIC: {
    label: "LIKELY SYNTHETIC",
    level: "HIGH",
    color: "#ff3158",
    soft: "rgba(255,49,88,0.12)",
  },
  INCONCLUSIVE: {
    label: "INCONCLUSIVE",
    level: "REVIEW",
    color: "#ffb020",
    soft: "rgba(255,176,32,0.12)",
  },
  NO_SIGNAL: {
    label: "NO SYNTHETIC SIGNAL",
    level: "LOW",
    color: "#20e686",
    soft: "rgba(32,230,134,0.1)",
  },
};

const pct = (p) => `${Math.round(p * 100)}%`;

// Keep rounded values on the same side of the verdict thresholds, and never
// round an inexact probability to 0% or 100%.
export function formatProbability(p) {
  const value = p * 100;
  if (p === 0 || p === 1) return `${value}%`;
  if (value < 0.1) return "<0.1%";
  if (value > 99.9) return ">99.9%";
  const threshold = [THRESHOLDS.noSignal, THRESHOLDS.likelySynthetic].find(
    (t) => Math.abs(value - t * 100) < 0.5 && p !== t,
  );
  if (threshold !== undefined) {
    const rounded = value.toFixed(1);
    if (Number(rounded) === threshold * 100) {
      return `${p < threshold ? "<" : ">"}${threshold * 100}%`;
    }
    return `${rounded}%`;
  }
  return value < 0.5 || value >= 99.5 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

export function band(p) {
  if (p >= THRESHOLDS.likelySynthetic) return "LIKELY_SYNTHETIC";
  if (p <= THRESHOLDS.noSignal) return "NO_SIGNAL";
  return "INCONCLUSIVE";
}

const BAND_NAMES = { LIKELY_SYNTHETIC: "high", INCONCLUSIVE: "middle", NO_SIGNAL: "low" };

// How much of the image the model actually looks at, per axis.
export function cropCoverage({ width, height }) {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const shortAxis = Math.min(1, CROP / RESIZE_EDGE);
  const longAxis = Math.min(1, (CROP / RESIZE_EDGE) * (short / long));
  return { shortAxis, longAxis };
}

// `metadata.format.lossy` with no JPEG quality means a lossy format whose
// compression cannot be measured (WebP, AVIF, HEIC). That is treated as
// possibly compressed: severe at small sizes, a caveat otherwise.
export function degradation({ width, height }, metadata = {}) {
  const side = Math.min(width, height);
  const q = Number.isFinite(metadata.jpegQuality) ? metadata.jpegQuality : null;
  const unmeasuredLossy = q === null && metadata.format?.lossy === true ? metadata.format.name : null;
  const causes = [];
  if (side < THRESHOLDS.degradedSide) causes.push(`shortest side ${side}px < ${THRESHOLDS.degradedSide}px`);
  if (q !== null && q < THRESHOLDS.degradedQuality) causes.push(`JPEG quality ≈${q} < ${THRESHOLDS.degradedQuality}`);
  if (!causes.length && side < THRESHOLDS.softSide) {
    if (q !== null && q < THRESHOLDS.softQuality) causes.push(`JPEG quality ≈${q} at only ${side}px`);
    if (unmeasuredLossy) causes.push(`${unmeasuredLossy} with unmeasurable compression at only ${side}px`);
  }
  if (causes.length) return { level: "severe", causes };

  const mild = [];
  if (side < THRESHOLDS.softSide) mild.push(`shortest side ${side}px`);
  if (q !== null && q < THRESHOLDS.cleanQuality) mild.push(`JPEG quality ≈${q}`);
  if (unmeasuredLossy) mild.push(`${unmeasuredLossy} compression level cannot be measured`);
  return { level: mild.length ? "mild" : "clean", causes: mild };
}

export function assess({ views, image, metadata, model }) {
  if (!views?.length) throw new Error("No model scores to assess");

  const scores = views.map((view) => view.fakeProbability);
  if (scores.some((s) => !Number.isFinite(s) || s < 0 || s > 1)) throw new Error("Model scores out of range");
  const probability = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const spread = Math.max(...scores) - Math.min(...scores);
  // Views must land in the same verdict band. 0.95 vs 0.72 is not a confident
  // call; 0.49 vs 0.51 is noise inside one band, not instability.
  const bandsDisagree = new Set(scores.map(band)).size > 1;
  const unstable = spread > THRESHOLDS.maxViewSpread || bandsDisagree;
  // Quality gates apply to the pixels prepared for the processor, rather than
  // the source dimensions that may have been reduced by the canvas limit.
  const prepared = image.preparedSize || image;
  const resized = prepared.width !== image.width || prepared.height !== image.height;
  const shortSide = Math.min(prepared.width, prepared.height);
  const degraded = degradation(prepared, metadata || {});
  const generatorMarkers = metadata?.generatorMarkers || [];
  const viewList = views.map((v) => `${v.name} ${formatProbability(v.fakeProbability)}`);

  const reasons = [];
  const caveats = [];

  // 1. Model score band.
  let verdict;
  if (probability >= THRESHOLDS.likelySynthetic) {
    verdict = "LIKELY_SYNTHETIC";
    reasons.push({
      tone: "risk",
      title: `Generated-image probability ${formatProbability(probability)}`,
      detail: `At or above the ${pct(THRESHOLDS.likelySynthetic)} threshold. In local validation no real photo scored above ${model.validation.realMax}, even after recompression.`,
    });
  } else if (probability <= THRESHOLDS.noSignal) {
    verdict = "NO_SIGNAL";
    reasons.push({
      tone: "clear",
      title: `Generated-image probability ${formatProbability(probability)}`,
      detail: `At or below the ${pct(THRESHOLDS.noSignal)} threshold; the model does not see a generated image.`,
    });
  } else {
    verdict = "INCONCLUSIVE";
    reasons.push({
      tone: "review",
      title: `Generated-image probability ${formatProbability(probability)}`,
      detail: `Between ${pct(THRESHOLDS.noSignal)} and ${pct(THRESHOLDS.likelySynthetic)}: the model is not confident either way.`,
    });
  }

  // 2. Stability across views. A real signal should not depend on mirroring.
  if (unstable) {
    verdict = "INCONCLUSIVE";
    reasons.push({
      tone: "review",
      title: `Unstable score (spread ${pct(spread)})`,
      detail: `${viewList.join(" vs ")}. ${
        bandsDisagree
          ? `The views fall in different bands (${scores.map((s) => BAND_NAMES[band(s)]).join(" vs ")}), so mirroring changed the answer.`
          : "Mirroring moved the score this much, so neither value is trustworthy."
      }`,
    });
  } else if (views.length > 1) {
    reasons.push({
      tone: "neutral",
      title: `Stable across ${views.length} views (spread ${pct(spread)})`,
      detail: `${viewList.join(", ")}.`,
    });
  }

  // 3. Image quality. Asymmetric on purpose: degradation hides generated
  // images but did not create false positives.
  if (resized) {
    caveats.push(
      `The engine resized the source from ${image.width}×${image.height} to ${prepared.width}×${prepared.height} before model preprocessing. Resolution checks use this prepared image; crop to the region of interest and rescan to preserve more detail.`,
    );
  }
  if (shortSide < THRESHOLDS.minTestedSide) {
    verdict = "INCONCLUSIVE";
    reasons.push({
      tone: "review",
      title: `Image too small${resized ? " after resizing" : ""} (${prepared.width}×${prepared.height})`,
      detail: `Shortest side under ${THRESHOLDS.minTestedSide}px is outside anything validated; no score at this size can be trusted.`,
    });
  } else if (degraded.level === "severe") {
    if (verdict === "NO_SIGNAL") {
      verdict = "INCONCLUSIVE";
      reasons.push({
        tone: "review",
        title: "Low score is not evidence on this file",
        detail: `Degraded input (${degraded.causes.join("; ")}). In validation, downscaling and recompression hid up to ${model.validation.degradedMissed} images, so a low score here does not clear the image.`,
      });
    } else {
      reasons.push({
        tone: "neutral",
        title: "Degraded input",
        detail: `${degraded.causes.join("; ")}. Degradation tends to lower scores, not raise them, so a high score still counts.`,
      });
    }
  } else if (degraded.level === "mild") {
    caveats.push(`Some quality loss (${degraded.causes.join(", ")}). Low scores are somewhat less reliable than on a clean original.`);
  }

  // 4. Metadata. A generator marker is the file declaring itself AI-made,
  // which is stronger evidence than any classifier score.
  if (generatorMarkers.length) {
    verdict = "LIKELY_SYNTHETIC";
    reasons.push({
      tone: "risk",
      title: "File declares AI generation",
      detail: `${generatorMarkers.join("; ")}. This overrides the pixel-based score. Metadata can be forged, but rarely to falsely claim AI origin.`,
    });
  }
  if (metadata?.hasC2pa) {
    reasons.push({
      tone: "neutral",
      title: "Content Credentials (C2PA) manifest present",
      detail: "Not verified here. Inspect it with a C2PA verifier to see who signed it and what edits it records.",
    });
  }
  if (metadata?.software) {
    reasons.push({
      tone: "neutral",
      title: `Editing software tag: ${metadata.software}`,
      detail: "Shows the file passed through this software; it does not show what was changed.",
    });
  }
  if (metadata?.camera) {
    reasons.push({
      tone: "neutral",
      title: `Camera EXIF: ${metadata.camera}`,
      detail: "Not counted toward the verdict. EXIF is easily copied onto synthetic images.",
    });
  }

  // 5. What the model actually saw.
  const coverage = cropCoverage(image);
  if (coverage.longAxis < 0.7) {
    caveats.push(
      `The model only sees a centred square: about ${pct(coverage.longAxis)} of the image's long side and ${pct(coverage.shortAxis)} of the short side. Content near the edges was not analysed; crop to the region of interest and rescan if it matters.`,
    );
  }

  // Standing limits that apply to every result from this model.
  caveats.push(
    "The model detects fully generated images (GAN, diffusion). Local edits to a real photo, such as face swaps, inpainting or retouching, were not validated and may go undetected.",
    `Local validation was small (${model.validation.summary}). Treat it as a sanity check, not a benchmark; new generators may evade the model.`,
    "Screenshots, filters and repeated re-sharing strip the traces the model relies on.",
  );

  const summary = {
    LIKELY_SYNTHETIC: generatorMarkers.length
      ? "The file's own metadata declares AI generation. Treat it as synthetic unless the source can prove otherwise."
      : "The detector strongly associates this image with AI generation. Corroborate with provenance (reverse image search, account history, original source) before acting.",
    INCONCLUSIVE:
      "This scan cannot decide. Do not treat the image as authentic or as fake on this basis; rely on provenance checks.",
    NO_SIGNAL: `The detector found no sign of AI generation. This is not proof of authenticity: ${model.validation.cleanMissed} images in validation also scored this low.`,
  }[verdict];

  return {
    verdict,
    ...VERDICTS[verdict],
    probability,
    spread,
    unstable,
    degradation: degraded,
    summary,
    reasons,
    caveats,
    // Reasons that need an analyst's attention: model risk signals and anything
    // that made the result inconclusive. Neutral context is left out.
    findings: reasons.filter((r) => r.tone === "risk" || r.tone === "review"),
  };
}
