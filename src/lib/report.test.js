import { describe, expect, it } from "vitest";
import { assess } from "./analysis.js";
import { buildReport, findingsToText, REPORT_SCHEMA, reportFilename, reportToText } from "./report.js";

const model = {
  id: "org/detector",
  revision: "ac6ee457bea904a373065754107451793b56db00",
  dtype: "uint8",
  name: "Detector",
  card: "https://example.test/card",
  paper: "https://example.test/paper",
  validation: { summary: "test set", realMax: "4%", cleanMissed: "4 of 19", degradedMissed: "17 of 19" },
};
const sha256 = "4cbf4417fbf81f6ca3ea3cbd6fb92301281f3ce751876bfcf068689a8deaeb45";
const metadata = {
  generatorMarkers: [],
  hasC2pa: false,
  camera: null,
  software: null,
  jpegQuality: 92,
  format: { name: "JPEG", lossy: true },
};

function makeReport(logits, image = { width: 1024, height: 1024 }) {
  const views = logits.map((logit, i) => ({
    name: i ? "Mirrored" : "Original",
    logit,
    fakeProbability: 1 / (1 + Math.exp(-logit)),
  }));
  const result = {
    ...assess({ views, image, metadata, model }),
    views,
    image,
    metadata,
    timestamp: "2026-10-17T07:54:14.382Z",
    durationMs: 812.4,
  };
  return buildReport({
    result,
    file: { name: "suspect.jpg", type: "image/jpeg", size: 520_704, sha256 },
    model,
    runtime: "@huggingface/transformers@3.7.5",
    appVersion: "2.0.0",
    generatedAt: "2026-10-17T08:00:00.000Z",
  });
}

describe("buildReport", () => {
  const report = makeReport([7.9, 7.1]);

  it("identifies the file, scan and model", () => {
    expect(report.schema).toBe(REPORT_SCHEMA);
    expect(report.file).toMatchObject({ name: "suspect.jpg", sha256, sizeBytes: 520_704, width: 1024, detectedFormat: "JPEG" });
    expect(report.scan).toEqual({ startedAt: "2026-10-17T07:54:14.382Z", durationMs: 812.4, preparedImage: { width: 1024, height: 1024 } });
    expect(report.model).toMatchObject({ id: "org/detector", revision: model.revision, dtype: "uint8" });
  });

  it("keeps raw scores unrounded", () => {
    expect(report.rawScores.views[0].logit).toBe(7.9);
    expect(report.rawScores.views[0].probability).toBe(1 / (1 + Math.exp(-7.9)));
  });

  it("includes the interpretation and the thresholds it used", () => {
    expect(report.interpretation.verdict).toBe("LIKELY_SYNTHETIC");
    expect(report.interpretation.thresholds).toEqual({
      noSignalAtOrBelow: 0.2,
      likelySyntheticAtOrAbove: 0.8,
      maxViewSpread: 0.25,
    });
    expect(report.findings[0]).toMatchObject({ severity: "risk" });
  });

  it("survives a JSON round trip unchanged", () => {
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("records the reduced analysis resolution while preserving the source dimensions", () => {
    const reduced = makeReport([-5, -6], { width: 30000, height: 400, preparedSize: { width: 4096, height: 55 } });
    expect(reduced.file).toMatchObject({ width: 30000, height: 400 });
    expect(reduced.scan.preparedImage).toEqual({ width: 4096, height: 55 });
    expect(reduced.interpretation.verdict).toBe("INCONCLUSIVE");
    expect(reduced.interpretation.reasons.some((r) => r.title.includes("4096×55"))).toBe(true);
    expect(reportToText(reduced)).toContain("4096x55 (before model preprocessing)");
  });
});

describe("text renderings", () => {
  it("text report contains every key field", () => {
    const text = reportToText(makeReport([7.9, 7.1]));
    for (const needle of [
      "suspect.jpg",
      sha256,
      "2026-10-17T07:54:14.382Z",
      "org/detector",
      "ac6ee457bea904a373065754107451793b56db00",
      "logit 7.9000",
      "LIKELY SYNTHETIC",
      "FINDINGS FOR REVIEW",
    ]) {
      expect(text).toContain(needle);
    }
  });

  it("describes classifier output without IOC language", () => {
    const report = makeReport([7.9, 7.1]);
    for (const text of [reportToText(report), findingsToText(report)]) {
      expect(text).not.toMatch(/\bIOC|indicator of compromise/i);
      expect(text).toMatch(/not the chance the verdict is correct/);
    }
  });

  it("never prints a near-certain raw score as 100%", () => {
    const text = reportToText(makeReport([12, 11]));
    expect(text).toContain(">99.99%");
    expect(text).not.toMatch(/100\.00%/);
  });

  it("copy-findings text says so when there is nothing to review", () => {
    expect(findingsToText(makeReport([-8, -9]))).toMatch(/None\. The scan raised no risk or review findings/);
  });
});

describe("reportFilename", () => {
  it("combines the hash prefix and scan time", () => {
    expect(reportFilename(makeReport([1, 1]), "json")).toBe("synthsec-4cbf4417fbf8-20261017T075414Z.json");
  });
});
