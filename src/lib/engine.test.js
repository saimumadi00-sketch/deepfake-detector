import { afterEach, describe, expect, it, vi } from "vitest";
import { assess } from "./analysis.js";
import { decodeViews, MODEL, scoreViews } from "./engine.js";

// Exercise the real view sizing and assessment together without downloading
// weights or allocating the large source images used by the regression cases.
vi.mock("@huggingface/transformers", () => ({
  AutoModelForImageClassification: {},
  AutoProcessor: {},
  env: {},
  RawImage: {
    fromCanvas: (canvas) => ({ width: canvas.width, height: canvas.height, rgb() { return this; } }),
  },
}));

afterEach(() => vi.unstubAllGlobals());

async function scanSize(width, height, score) {
  const bitmap = { width, height, close: vi.fn() };
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  vi.stubGlobal("document", {
    createElement: () => ({ getContext: () => ({ fillRect() {}, translate() {}, scale() {}, drawImage() {} }) }),
  });
  const decoded = await decodeViews({});
  const image = { width: decoded.width, height: decoded.height, preparedSize: decoded.preparedSize };
  const assessment = assess({
    image,
    views: decoded.views.map((view) => ({ name: view.name, fakeProbability: score })),
    metadata: { format: { name: "PNG", lossy: false } },
    model: MODEL,
  });
  expect(bitmap.close).toHaveBeenCalledOnce();
  for (const view of decoded.views) {
    expect({ width: view.image.width, height: view.image.height }).toEqual(decoded.preparedSize);
  }
  return { decoded, assessment };
}

describe("quality checks after engine resizing", () => {
  it.each([0.01, 0.99])("treats a panorama reduced below 128px as inconclusive at score %s", async (score) => {
    const { decoded, assessment } = await scanSize(30000, 400, score);
    expect(decoded).toMatchObject({ width: 30000, height: 400, preparedSize: { width: 4096, height: 55 } });
    expect(assessment.verdict).toBe("INCONCLUSIVE");
    expect(assessment.reasons.some((r) => r.title === "Image too small after resizing (4096×55)")).toBe(true);
    expect(assessment.caveats.join(" ")).toContain("30000×400 to 4096×55");
  });

  it("applies the same minimum to a tall image", async () => {
    const { decoded, assessment } = await scanSize(400, 30000, 0.01);
    expect(decoded.preparedSize).toEqual({ width: 55, height: 4096 });
    expect(assessment.verdict).toBe("INCONCLUSIVE");
  });

  it("does not clear a source reduced into the degraded size band", async () => {
    const { decoded, assessment } = await scanSize(16000, 1000, 0.01);
    expect(decoded.preparedSize).toEqual({ width: 4096, height: 256 });
    expect(assessment.degradation.level).toBe("severe");
    expect(assessment.verdict).toBe("INCONCLUSIVE");
    expect(assessment.degradation.causes.join(" ")).toContain("shortest side 256px");
  });

  it("keeps a high score when the prepared image is still within the tested sizes", async () => {
    const { assessment } = await scanSize(16000, 1000, 0.99);
    expect(assessment.verdict).toBe("LIKELY_SYNTHETIC");
  });

  it("keeps a low score when resizing preserves sufficient resolution", async () => {
    const { decoded, assessment } = await scanSize(8000, 1000, 0.01);
    expect(decoded.preparedSize).toEqual({ width: 4096, height: 512 });
    expect(assessment.verdict).toBe("NO_SIGNAL");
    expect(assessment.degradation.level).toBe("clean");
  });

  it("preserves the behaviour of images that do not need resizing", async () => {
    const { decoded, assessment } = await scanSize(1024, 1024, 0.01);
    expect(decoded.preparedSize).toEqual({ width: 1024, height: 1024 });
    expect(assessment.verdict).toBe("NO_SIGNAL");
    expect(assessment.caveats.join(" ")).not.toContain("The engine resized");
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const scoringViews = (id) => [
  { name: "Original", image: `${id}:original` },
  { name: "Mirrored", image: `${id}:mirrored` },
];
const modelOutput = () => ({ logits: { data: [-1] } });

describe("scan cancellation in the inference queue", () => {
  it("skips replaced queued scans and remaining views while keeping inference serial", async () => {
    const started = deferred();
    const release = deferred();
    const calls = [];
    let activeToken = 0;
    let running = 0;
    let maxRunning = 0;
    const engine = {
      processor: vi.fn(async (image) => image),
      model: vi.fn(async (input) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        calls.push(input);
        if (input === "first:original") {
          started.resolve();
          await release.promise;
        }
        running--;
        return modelOutput();
      }),
    };

    const first = scoreViews(engine, scoringViews("first"), () => activeToken === 0);
    await started.promise;
    activeToken = 1;
    const cancelled = scoreViews(engine, scoringViews("cancelled"), () => activeToken === 1);
    activeToken = 2;
    const current = scoreViews(engine, scoringViews("current"), () => activeToken === 2);
    release.resolve();

    const results = await Promise.all([first, cancelled, current]);
    expect(results[0]).toBeNull();
    expect(results[1]).toBeNull();
    expect(results[2].map((view) => view.name)).toEqual(["Original", "Mirrored"]);
    expect(calls).toEqual(["first:original", "current:original", "current:mirrored"]);
    expect(engine.processor.mock.calls.map(([input]) => input)).toEqual(calls);
    expect(maxRunning).toBe(1);
  });

  it("skips inference when cancelled during preprocessing", async () => {
    const started = deferred();
    const release = deferred();
    let current = true;
    const engine = {
      processor: vi.fn(async (image) => { started.resolve(); await release.promise; return image; }),
      model: vi.fn(modelOutput),
    };
    const result = scoreViews(engine, scoringViews("cancelled"), () => current);
    await started.promise;
    current = false;
    release.resolve();
    await expect(result).resolves.toBeNull();
    expect(engine.processor).toHaveBeenCalledOnce();
    expect(engine.model).not.toHaveBeenCalled();
  });

  it("discards all scores if cancelled during the final view", async () => {
    const started = deferred();
    const release = deferred();
    let current = true;
    const engine = {
      processor: async (image) => image,
      model: vi.fn(async (input) => {
        if (input.endsWith(":mirrored")) { started.resolve(); await release.promise; }
        return modelOutput();
      }),
    };
    const result = scoreViews(engine, scoringViews("cancelled"), () => current);
    await started.promise;
    current = false;
    release.resolve();
    await expect(result).resolves.toBeNull();
  });

  it("continues with the next scan after an inference failure", async () => {
    const engine = {
      processor: async (image) => image,
      model: vi.fn().mockRejectedValueOnce(new Error("inference failed")).mockImplementation(modelOutput),
    };
    const failed = scoreViews(engine, scoringViews("failed"));
    const next = scoreViews(engine, scoringViews("next"));
    await expect(failed).rejects.toThrow("inference failed");
    await expect(next).resolves.toHaveLength(2);
  });

  it("preserves scoring for callers without a cancellation predicate", async () => {
    const engine = { processor: async (image) => image, model: vi.fn(modelOutput) };
    const results = await scoreViews(engine, scoringViews("normal"));
    expect(results).toEqual([
      { name: "Original", logit: -1, fakeProbability: 1 / (1 + Math.exp(1)) },
      { name: "Mirrored", logit: -1, fakeProbability: 1 / (1 + Math.exp(1)) },
    ]);
  });
});
