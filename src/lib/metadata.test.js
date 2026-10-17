import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectFormat, estimateJpegQuality, readJpegExif, scanMetadata } from "./metadata.js";

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

// Builds a minimal big-endian JPEG with an APP1 EXIF block holding Make/Software.
function jpegWithExif({ make, software }) {
  const entries = [
    [0x010f, make],
    [0x0131, software],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  let dataOffset = 8 + ifdSize;
  const ifd = [entries.length >> 8, entries.length & 0xff];
  const data = [];
  for (const [tag, value] of entries) {
    const bytes = [...ascii(value), 0];
    ifd.push(tag >> 8, tag & 0xff, 0, 2, 0, 0, 0, bytes.length);
    ifd.push((dataOffset >> 24) & 0xff, (dataOffset >> 16) & 0xff, (dataOffset >> 8) & 0xff, dataOffset & 0xff);
    data.push(...bytes);
    dataOffset += bytes.length;
  }
  ifd.push(0, 0, 0, 0);
  const tiff = [...ascii("MM"), 0, 42, 0, 0, 0, 8, ...ifd, ...data];
  const payload = [...ascii("Exif"), 0, 0, ...tiff];
  const length = payload.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...payload, 0xff, 0xda, 0, 2]);
}

describe("readJpegExif", () => {
  it("reads Make and Software from IFD0", () => {
    expect(readJpegExif(jpegWithExif({ make: "Canon", software: "Adobe Photoshop 25.0" }))).toEqual({
      make: "Canon",
      software: "Adobe Photoshop 25.0",
    });
  });

  it("returns null for non-JPEG input", () => {
    expect(readJpegExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});

describe("scanMetadata", () => {
  it("finds Stable Diffusion WebUI parameters in PNG text", () => {
    const bytes = new Uint8Array(ascii("\x89PNG....tEXtparameters\0a portrait\nSteps: 30, Sampler: DPM++ 2M"));
    expect(scanMetadata(bytes).generatorMarkers).toContain("Stable Diffusion WebUI generation parameters");
  });

  it("finds a UTF-8 encoded DALL·E marker", () => {
    expect(scanMetadata(new TextEncoder().encode("Created with DALL·E 3")).generatorMarkers).toContain("DALL-E marker");
  });

  it("distinguishes the two IPTC AI source types", () => {
    const composite = scanMetadata(new Uint8Array(ascii("digitalsourcetype/compositeWithTrainedAlgorithmicMedia")));
    expect(composite.generatorMarkers).toEqual(["IPTC source type: composite with AI-generated media"]);
    const full = scanMetadata(new Uint8Array(ascii("digitalsourcetype/trainedAlgorithmicMedia")));
    expect(full.generatorMarkers).toEqual(["IPTC source type: AI-generated media"]);
  });

  it("reports camera and software from EXIF", () => {
    const result = scanMetadata(jpegWithExif({ make: "Nikon", software: "GIMP 2.10" }));
    expect(result.camera).toBe("Nikon");
    expect(result.software).toBe("GIMP 2.10");
    expect(result.generatorMarkers).toEqual([]);
  });

  it("reports nothing for a plain file", () => {
    expect(scanMetadata(new Uint8Array(1000))).toEqual({
      generatorMarkers: [],
      hasC2pa: false,
      exif: null,
      camera: null,
      software: null,
      jpegQuality: null,
      format: { name: "unknown", lossy: null },
    });
  });
});

describe("estimateJpegQuality", () => {
  // fixtures/qNN.jpg: a 32x32 gradient saved by Pillow (libjpeg) at quality NN.
  it("recovers the encoder quality setting", () => {
    for (const q of [55, 75, 90]) {
      const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/q${q}.jpg`, import.meta.url)));
      expect(Math.abs(estimateJpegQuality(bytes) - q)).toBeLessThanOrEqual(1);
    }
  });

  it("returns null for non-JPEG input", () => {
    expect(estimateJpegQuality(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});

describe("detectFormat", () => {
  const riff = (chunk) => new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii(chunk)]);

  it("tells lossy and lossless WebP apart", () => {
    expect(detectFormat(riff("VP8 "))).toEqual({ name: "WebP (lossy)", lossy: true });
    expect(detectFormat(riff("VP8L"))).toEqual({ name: "WebP (lossless)", lossy: false });
  });

  it("recognises AVIF and PNG from magic bytes", () => {
    expect(detectFormat(new Uint8Array([0, 0, 0, 0x1c, ...ascii("ftypavif")])).name).toBe("AVIF");
    expect(detectFormat(new Uint8Array([0x89, ...ascii("PNG")])).name).toBe("PNG");
  });
});
