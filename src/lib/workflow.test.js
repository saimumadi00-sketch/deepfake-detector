import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeEngineError, describeScanError } from "./errors.js";
import { createValidatedPreview, LIMITS, validateFileInfo, validatePixels } from "./ingest.js";
import { readImageDimensions } from "./metadata.js";
import { createDownloadTracker } from "./progress.js";
import { createSerialQueue } from "./queue.js";

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

describe("validated previews", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const setup = () => {
    const url = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:validated");
    const bitmap = { width: 33, height: 17, close: vi.fn() };
    const decode = vi.fn().mockResolvedValue(bitmap);
    vi.stubGlobal("createImageBitmap", decode);
    return { url, bitmap, decode };
  };

  it("rejects an oversized header before decoding or exposing a URL", async () => {
    const { url, decode } = setup();
    const bytes = fixture("dims.png");
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    view.setUint32(16, 30000);
    view.setUint32(20, 30000);
    await expect(createValidatedPreview({ name: "large.png" }, bytes)).rejects.toThrow(/limit/);
    expect(decode).not.toHaveBeenCalled();
    expect(url).not.toHaveBeenCalled();
  });

  it("waits for decoding and validation before creating a preview", async () => {
    const { url, bitmap, decode } = setup();
    let finish;
    decode.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const file = { name: "small.png" };
    const pending = createValidatedPreview(file, fixture("dims.png"));
    expect(url).not.toHaveBeenCalled();
    finish(bitmap);
    await expect(pending).resolves.toEqual({ url: "blob:validated", width: 33, height: 17 });
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(url).toHaveBeenCalledWith(file);
  });

  it("rejects an oversized decoded image even without a known header", async () => {
    const { url, bitmap } = setup();
    bitmap.width = bitmap.height = 30000;
    await expect(createValidatedPreview({ name: "large.avif" }, new Uint8Array(64))).rejects.toThrow(/limit/);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(url).not.toHaveBeenCalled();
  });

  it("does not expose corrupt images", async () => {
    const { url, decode } = setup();
    decode.mockRejectedValue(new Error("decode failed"));
    await expect(createValidatedPreview({ name: "bad.png" }, fixture("dims.png"))).rejects.toThrow(/could not be decoded/);
    expect(url).not.toHaveBeenCalled();
  });

  it("closes stale decodes without creating a preview after reset or replacement", async () => {
    const { url, bitmap } = setup();
    let current = true;
    const pending = createValidatedPreview({ name: "small.png" }, fixture("dims.png"), () => current);
    current = false;
    await expect(pending).resolves.toBeNull();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(url).not.toHaveBeenCalled();
  });
});

describe("validateFileInfo", () => {
  it("accepts a normal image", () => {
    expect(validateFileInfo({ name: "a.jpg", size: 200_000, type: "image/jpeg" })).toBeNull();
  });

  it("accepts an unknown type so decoding can decide", () => {
    expect(validateFileInfo({ name: "a.heic", size: 200_000, type: "" })).toBeNull();
  });

  it("rejects non-images, empty files and oversized files", () => {
    expect(validateFileInfo({ name: "a.txt", size: 5, type: "text/plain" })).toMatch(/not an image/);
    expect(validateFileInfo({ name: "a.png", size: 0, type: "image/png" })).toMatch(/empty/);
    expect(validateFileInfo({ name: "a.png", size: LIMITS.maxFileBytes + 1, type: "image/png" })).toMatch(/limit is 50\.0 MB/);
  });
});

describe("validatePixels", () => {
  it("rejects canvases above the pixel limit", () => {
    expect(validatePixels("x.png", { width: 20000, height: 20000 })).toMatch(/400 MP/);
    expect(validatePixels("x.png", { width: 4000, height: 3000 })).toBeNull();
    expect(validatePixels("x.avif", null)).toBeNull();
  });
});

describe("readImageDimensions", () => {
  it.each(["dims.png", "dims.gif", "dims.bmp", "dims-lossy.webp", "dims-lossless.webp", "dims.jpg"])(
    "reads 33x17 from %s",
    (name) => {
      expect(readImageDimensions(fixture(name))).toEqual({ width: 33, height: 17 });
    },
  );

  it("reads the declared size of a decompression bomb without decoding", () => {
    const bytes = fixture("dims.png");
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    view.setUint32(16, 30000);
    view.setUint32(20, 30000);
    expect(readImageDimensions(bytes)).toEqual({ width: 30000, height: 30000 });
  });

  it("returns null for unreadable headers", () => {
    expect(readImageDimensions(new Uint8Array(64))).toBeNull();
  });
});

describe("createDownloadTracker", () => {
  it("reports overall progress across files instead of per file", () => {
    const track = createDownloadTracker();
    track({ status: "initiate", file: "config.json" });
    track({ status: "progress", file: "config.json", loaded: 500, total: 500 });
    track({ status: "done", file: "config.json" });
    const mid = track({ status: "progress", file: "onnx/model_uint8.onnx", loaded: 10_000_000, total: 20_000_000 });
    expect(mid.progress).toBe(50);
    expect(mid.message).toMatch(/9\.5 \/ 19\.1 MB · model_uint8\.onnx \(1\/2 FILES\)/);
  });

  it("does not jump to 99% on small config files and fall back when the weights start", () => {
    const track = createDownloadTracker();
    const config = track({ status: "progress", file: "config.json", loaded: 500, total: 500 });
    expect(config.progress).toBe(0);
    expect(config.message).toMatch(/FETCHING MODEL CONFIG/);
    track({ status: "done", file: "config.json" });
    const seen = [0, 10, 40, 100].map((pct) =>
      track({ status: "progress", file: "m.onnx", loaded: pct * 200_000, total: 20_000_000 }).progress,
    );
    expect(seen).toEqual([0, 10, 40, 99]);
  });

  it("never moves backwards within one load", () => {
    const track = createDownloadTracker();
    track({ status: "progress", file: "a.onnx", loaded: 9_000_000, total: 10_000_000 });
    // A second large file starting would lower the raw ratio.
    expect(track({ status: "progress", file: "b.onnx", loaded: 0, total: 10_000_000 }).progress).toBe(90);
  });

  it("never reports 100% until the model is ready", () => {
    const track = createDownloadTracker();
    expect(track({ status: "progress", file: "m.onnx", loaded: 5_000_000, total: 5_000_000 }).progress).toBe(99);
    expect(track({ status: "ready" }).progress).toBe(100);
  });
});

describe("createSerialQueue", () => {
  it("runs tasks one at a time, in order, even after a failure", async () => {
    const queue = createSerialQueue();
    const log = [];
    let running = 0;
    const task = (name, ms, fail) => () =>
      new Promise((resolve, reject) => {
        running += 1;
        log.push(`start ${name} (running ${running})`);
        setTimeout(() => {
          running -= 1;
          log.push(`end ${name}`);
          fail ? reject(new Error(name)) : resolve(name);
        }, ms);
      });
    const a = queue(task("a", 20, true));
    const b = queue(task("b", 5));
    await expect(a).rejects.toThrow("a");
    await expect(b).resolves.toBe("b");
    expect(log).toEqual(["start a (running 1)", "end a", "start b (running 1)", "end b"]);
  });
});

describe("error descriptions", () => {
  it("explains network failures with what to allow", () => {
    const e = describeEngineError(new TypeError("Failed to fetch"));
    expect(e.title).toMatch(/download the detection model/);
    expect(e.hint).toMatch(/huggingface\.co/);
    expect(e.detail).toBe("Failed to fetch");
  });

  it("points WebAssembly failures at hosting config", () => {
    expect(describeEngineError(new Error("no available backend found. ERR: [wasm] ...")).hint).toMatch(/application\/wasm/);
  });

  it("recognises decode failures during a scan", () => {
    expect(describeScanError(new Error("The source image could not be decoded.")).title).toMatch(/could not be decoded/);
  });
});
