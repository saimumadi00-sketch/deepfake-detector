import { describe, expect, it } from "vitest";
import { assess, cropCoverage, degradation, formatProbability } from "./analysis.js";

const model = {
  validation: { summary: "test set", realMax: "4%", cleanMissed: "4 of 19", degradedMissed: "17 of 19" },
};
const image = { width: 1024, height: 1024 };
const views = (...scores) => scores.map((fakeProbability, i) => ({ name: `v${i}`, fakeProbability }));
const run = (overrides) => assess({ views: views(0.5), image, metadata: { jpegQuality: 95 }, model, ...overrides });

describe("assess: score bands", () => {
  it("calls LIKELY_SYNTHETIC above the threshold when views agree", () => {
    expect(run({ views: views(0.93, 0.88) }).verdict).toBe("LIKELY_SYNTHETIC");
  });

  it("calls NO_SIGNAL below the threshold on a clean file", () => {
    expect(run({ views: views(0.05, 0.08) }).verdict).toBe("NO_SIGNAL");
  });

  it("calls INCONCLUSIVE in the middle band", () => {
    expect(run({ views: views(0.55, 0.6) }).verdict).toBe("INCONCLUSIVE");
  });

  it("rejects out-of-range scores", () => {
    expect(() => run({ views: views(1.5) })).toThrow(/out of range/);
  });
});

describe("assess: stability", () => {
  it("treats small noise inside one band as stable", () => {
    const result = run({ views: views(0.49, 0.51) });
    expect(result.unstable).toBe(false);
    expect(result.verdict).toBe("INCONCLUSIVE");
  });

  it("refuses a synthetic call when one view is below the threshold", () => {
    const result = run({ views: views(0.95, 0.72) });
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.reasons.some((r) => r.detail.includes("different bands (high vs middle)"))).toBe(true);
  });

  it("downgrades to INCONCLUSIVE when mirroring flips the answer", () => {
    const result = run({ views: views(0.95, 0.4) });
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.unstable).toBe(true);
  });
});

describe("assess: degradation is asymmetric", () => {
  it("does not let a low score clear a heavily compressed file", () => {
    const result = run({ views: views(0.01, 0.02), metadata: { jpegQuality: 55 } });
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.reasons.some((r) => r.title === "Low score is not evidence on this file")).toBe(true);
  });

  it("does not let a low score clear a small file", () => {
    expect(run({ views: views(0.01, 0.02), image: { width: 300, height: 400 } }).verdict).toBe("INCONCLUSIVE");
  });

  it("keeps a high score on a degraded file", () => {
    expect(run({ views: views(0.97, 0.95), metadata: { jpegQuality: 55 } }).verdict).toBe("LIKELY_SYNTHETIC");
  });

  it("treats anything under the tested size as INCONCLUSIVE, even a high score", () => {
    expect(run({ views: views(0.99, 0.99), image: { width: 100, height: 100 } }).verdict).toBe("INCONCLUSIVE");
  });

  it("only adds a caveat for mild quality loss", () => {
    const result = run({ views: views(0.02, 0.03), metadata: { jpegQuality: 88 } });
    expect(result.verdict).toBe("NO_SIGNAL");
    expect(result.caveats.join(" ")).toMatch(/quality ≈88/);
  });

  it("does not penalise lossless PNGs", () => {
    const png = { format: { name: "PNG", lossy: false } };
    expect(run({ views: views(0.02, 0.03), metadata: png }).verdict).toBe("NO_SIGNAL");
  });

  it("does not let a low score clear a small lossy WebP", () => {
    const webp = { format: { name: "WebP (lossy)", lossy: true } };
    const result = run({ views: views(0.02, 0.02), image: { width: 400, height: 500 }, metadata: webp });
    expect(result.verdict).toBe("INCONCLUSIVE");
  });

  it("flags unmeasurable compression on a large lossy WebP as a caveat", () => {
    const webp = { format: { name: "WebP (lossy)", lossy: true } };
    const result = run({ views: views(0.02, 0.02), image: { width: 1200, height: 1600 }, metadata: webp });
    expect(result.verdict).toBe("NO_SIGNAL");
    expect(result.caveats.join(" ")).toMatch(/cannot be measured/);
  });
});

describe("degradation", () => {
  it("classifies combined moderate loss as severe", () => {
    expect(degradation({ width: 480, height: 640 }, { jpegQuality: 80 }).level).toBe("severe");
  });

  it("classifies a clean large file as clean", () => {
    expect(degradation({ width: 2000, height: 1500 }, { jpegQuality: 95 })).toEqual({ level: "clean", causes: [] });
  });
});

describe("formatProbability", () => {
  it("shows a decimal when rounding would land on a threshold", () => {
    expect(formatProbability(0.204)).toBe("20.4%");
    expect(formatProbability(0.796)).toBe("79.6%");
  });

  it("never shows an inexact score as 0% or 100%", () => {
    expect(formatProbability(0.99993)).toBe(">99.9%");
    expect(formatProbability(0.0002)).toBe("<0.1%");
    expect(formatProbability(1)).toBe("100%");
    expect(formatProbability(0)).toBe("0%");
  });

  it.each([
    [0.001, "0.1%"], [0.004, "0.4%"], [0.996, "99.6%"], [0.999, "99.9%"],
    [0.1999, "<20%"], [0.2001, ">20%"], [0.7999, "<80%"], [0.8001, ">80%"],
    [0.2 - Number.EPSILON, "<20%"], [0.2 + Number.EPSILON, ">20%"],
    [0.8 - Number.EPSILON, "<80%"], [0.8 + Number.EPSILON, ">80%"],
  ])("keeps %s on the correct side of display boundaries", (p, label) => {
    expect(formatProbability(p)).toBe(label);
  });

  it("uses whole percents elsewhere and at exact thresholds", () => {
    expect(formatProbability(0.537)).toBe("54%");
    expect(formatProbability(0.8)).toBe("80%");
  });
});

describe("assess: metadata", () => {
  it("treats a declared AI generator as LIKELY_SYNTHETIC regardless of score", () => {
    const result = run({ views: views(0.05, 0.06), metadata: { generatorMarkers: ["Midjourney marker"] } });
    expect(result.verdict).toBe("LIKELY_SYNTHETIC");
    expect(result.findings.map((f) => f.detail).join(" ")).toMatch(/Midjourney/);
  });

  it("does not let camera EXIF move the verdict", () => {
    expect(run({ views: views(0.9, 0.9), metadata: { camera: "Canon EOS R5", jpegQuality: 95 } }).verdict).toBe(
      "LIKELY_SYNTHETIC",
    );
  });
});

describe("assess: explanation", () => {
  it("warns when the centre crop hides much of a wide image", () => {
    const result = run({ views: views(0.02, 0.02), image: { width: 3000, height: 1000 } });
    expect(result.caveats.join(" ")).toMatch(/centred square/);
  });

  it("states the size of the validation set", () => {
    expect(run({ views: views(0.01, 0.01) }).caveats.join(" ")).toMatch(/test set/);
  });

  it("produces no findings for a clean, stable result", () => {
    expect(run({ views: views(0.01, 0.02) }).findings).toEqual([]);
  });
});

describe("cropCoverage", () => {
  it("covers ~87% of both axes on a square image", () => {
    const { shortAxis, longAxis } = cropCoverage({ width: 500, height: 500 });
    expect(shortAxis).toBeCloseTo(0.873, 2);
    expect(longAxis).toBeCloseTo(0.873, 2);
  });
});
