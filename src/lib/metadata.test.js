import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assess } from "./analysis.js";
import { detectFormat, estimateJpegQuality, readImageDimensions, readJpegExif, scanMetadata } from "./metadata.js";

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

function pngText(key, value, unicode = false) {
  const data = Buffer.concat([Buffer.from(key), Buffer.from(unicode ? [0, 0, 0, 0, 0] : [0]), Buffer.from(value, unicode ? "utf8" : "latin1")]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(unicode ? "iTXt" : "tEXt", 4);
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  const image = fixture("dims.png");
  return Buffer.concat([image.subarray(0, 33), chunk, image.subarray(33)]);
}

function jpegSegment(marker, payload) {
  const image = fixture("q90.jpg");
  const length = payload.length + 2;
  return Buffer.concat([image.subarray(0, 2), Buffer.from([0xff, marker, length >> 8, length & 0xff]), payload, image.subarray(2)]);
}

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
    const bytes = pngText("parameters", "a portrait\nSteps: 30, Sampler: DPM++ 2M");
    expect(scanMetadata(bytes).generatorMarkers).toContain("Stable Diffusion WebUI generation parameters");
  });

  it("finds a UTF-8 encoded DALL·E software declaration", () => {
    expect(scanMetadata(pngText("Software", "DALL·E 3", true)).generatorMarkers).toContain("DALL-E marker");
  });

  it("distinguishes the two IPTC AI source types", () => {
    const xmp = (type) => `<rdf:Description Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/${type}"/>`;
    const composite = scanMetadata(pngText("XML:com.adobe.xmp", xmp("compositeWithTrainedAlgorithmicMedia"), true));
    expect(composite.generatorMarkers).toEqual(["IPTC source type: composite with AI-generated media"]);
    const full = scanMetadata(pngText("XML:com.adobe.xmp", xmp("trainedAlgorithmicMedia"), true));
    expect(full.generatorMarkers).toEqual(["IPTC source type: AI-generated media"]);
  });

  it.each([
    '<Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType>',
    '<Iptc4xmpExt:DigitalSourceType rdf:resource="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/>',
  ])("reads an IPTC source type from XMP elements", (xmp) => {
    expect(scanMetadata(pngText("XML:com.adobe.xmp", xmp, true)).generatorMarkers).toEqual(["IPTC source type: AI-generated media"]);
  });

  it("reads a generator from the EXIF software tag", () => {
    expect(scanMetadata(jpegWithExif({ make: "Canon", software: "Midjourney" })).generatorMarkers).toEqual(["Midjourney marker"]);
  });

  it("reads creator software from a JPEG XMP APP1 segment", () => {
    const payload = Buffer.from('http://ns.adobe.com/xap/1.0/\0<rdf:Description xmp:CreatorTool="Adobe Firefly"/>');
    expect(scanMetadata(jpegSegment(0xe1, payload)).generatorMarkers).toEqual(["Adobe Firefly marker"]);
  });

  it("reads creator software from a WebP XMP chunk", () => {
    const image = fixture("dims-lossy.webp");
    const payload = Buffer.from('<rdf:Description xmp:CreatorTool="Midjourney"/>');
    const chunk = Buffer.alloc(8 + payload.length + (payload.length % 2));
    chunk.write("XMP ");
    chunk.writeUInt32LE(payload.length, 4);
    payload.copy(chunk, 8);
    const bytes = Buffer.concat([image, chunk]);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    expect(scanMetadata(bytes).generatorMarkers).toEqual(["Midjourney marker"]);
  });

  it.each([
    ["prompt", { "3": { class_type: "KSampler", inputs: {} } }],
    ["workflow", { nodes: [{ type: "KSamplerAdvanced" }] }],
  ])("recognises ComfyUI generation nodes in the %s field", (key, workflow) => {
    expect(scanMetadata(pngText(key, JSON.stringify(workflow))).generatorMarkers).toEqual(["ComfyUI workflow embedded in file"]);
  });

  it("does not label a real photo synthetic because a JPEG comment mentions Midjourney", () => {
    const bytes = jpegSegment(0xfe, Buffer.from("Photo illustrating an article about Midjourney; no AI generation was used."));
    const metadata = scanMetadata(bytes);
    expect(metadata.generatorMarkers).toEqual([]);
    const result = assess({
      views: [{ name: "Original", fakeProbability: 0.01 }, { name: "Mirrored", fakeProbability: 0.02 }],
      image: { width: 1024, height: 1024 }, metadata,
      model: { validation: { summary: "test", cleanMissed: "4 of 19" } },
    });
    expect(result.verdict).toBe("NO_SIGNAL");
  });

  it.each(["Midjourney", "DALL-E 3", "Stable Diffusion", "Adobe Firefly", "NovelAI"])(
    "ignores %s in descriptive text and arbitrary bytes", (name) => {
      expect(scanMetadata(pngText("Description", `An article about ${name}.`)).generatorMarkers).toEqual([]);
      expect(scanMetadata(Buffer.from(name)).generatorMarkers).toEqual([]);
      expect(scanMetadata(pngText("Software", `Photo discussing ${name}.`)).generatorMarkers).toEqual([]);
    },
  );

  it("ignores generation-looking prose, JSON and IPTC links in descriptions", () => {
    const text = 'Steps: 30, Sampler: DPM++\n{"class_type":"KSampler"}\nhttp://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';
    expect(scanMetadata(pngText("Description", text)).generatorMarkers).toEqual([]);
    expect(scanMetadata(pngText("prompt", '{"text":"an article", "class_type":"example"}')).generatorMarkers).toEqual([]);
  });

  it("ignores descriptive XMP text and XML comments", () => {
    const xmp = `<dc:description>Midjourney trainedAlgorithmicMedia xmp:CreatorTool="Midjourney"</dc:description>
      <rdf:Description dc:description='an article about xmp:CreatorTool="Midjourney"'/>
      <!-- <rdf:Description xmp:CreatorTool="Midjourney"/> -->
      <![CDATA[<rdf:Description xmp:CreatorTool="Midjourney"/>]]>`;
    expect(scanMetadata(pngText("XML:com.adobe.xmp", xmp, true)).generatorMarkers).toEqual([]);
  });

  it("ignores bytes outside PNG chunks and truncated chunks", () => {
    expect(scanMetadata(Buffer.concat([fixture("dims.png"), Buffer.from('Software\0Midjourney')])).generatorMarkers).toEqual([]);
    const bytes = pngText("Software", "Midjourney");
    expect(scanMetadata(bytes.subarray(0, 52)).generatorMarkers).toEqual([]);
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
  const chunk = (type, data) => {
    const bytes = Buffer.alloc(8 + data.length + (data.length % 2));
    bytes.write(type);
    bytes.writeUInt32LE(data.length, 4);
    bytes.set(data, 8);
    return bytes;
  };
  const riff = (...chunks) => {
    const bytes = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP"), ...chunks]);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    return bytes;
  };
  const extendedHeader = () => {
    const data = Buffer.alloc(10);
    data[4] = 32;
    data[7] = 16;
    return chunk("VP8X", data);
  };

  it("tells lossy and lossless WebP apart", () => {
    expect(detectFormat(fixture("dims-lossy.webp"))).toEqual({ name: "WebP (lossy)", lossy: true });
    expect(detectFormat(fixture("dims-lossless.webp"))).toEqual({ name: "WebP (lossless)", lossy: false });
  });

  // extended-*.webp are real 400x400 RGBA images encoded by libwebp with
  // metadata, lossless:true / false. Tests only read the checked-in fixtures.
  it.each(["lossless", "lossy"])("recognises a %s bitstream after a VP8X header and metadata", (encoding) => {
    const bytes = fixture(`extended-${encoding}.webp`);
    expect(bytes.toString("ascii", 12, 16)).toBe("VP8X");
    expect(detectFormat(bytes)).toEqual({ name: `WebP (${encoding})`, lossy: encoding === "lossy" });
    // Also handle a Uint8Array backed by a larger buffer at a non-zero offset.
    const padded = Buffer.concat([Buffer.alloc(7), bytes]);
    expect(detectFormat(padded.subarray(7))).toEqual(detectFormat(bytes));
  });

  it.each([
    ["lossless", "NO_SIGNAL", "mild"],
    ["lossy", "INCONCLUSIVE", "severe"],
  ])("applies the correct quality rule to an extended %s WebP", (encoding, verdict, condition) => {
    const bytes = fixture(`extended-${encoding}.webp`);
    const image = readImageDimensions(bytes);
    expect(image).toEqual({ width: 400, height: 400 });
    const result = assess({
      views: [{ name: "Original", fakeProbability: 0.01 }, { name: "Mirrored", fakeProbability: 0.02 }],
      image,
      metadata: scanMetadata(bytes),
      model: { validation: { summary: "test", cleanMissed: "4 of 19", degradedMissed: "17 of 19" } },
    });
    expect(result.verdict).toBe(verdict);
    expect(result.degradation.level).toBe(condition);
    if (encoding === "lossless") {
      expect(result.degradation.causes.join(" ")).not.toMatch(/compression/);
    }
  });

  it("skips padded metadata chunks without mistaking their contents for a codec", () => {
    const bytes = riff(extendedHeader(), chunk("XMP ", Buffer.from("VP8 ignored")), fixture("dims-lossless.webp").subarray(12));
    expect(detectFormat(bytes)).toEqual({ name: "WebP (lossless)", lossy: false });
  });

  it("ignores codec-looking text without an image-data chunk", () => {
    const bytes = riff(extendedHeader(), chunk("XMP ", Buffer.from("VP8L")));
    expect(detectFormat(bytes).lossy).toBe(true);
  });

  it("does not scan beyond the declared RIFF size", () => {
    const bytes = Buffer.concat([riff(extendedHeader()), fixture("dims-lossless.webp").subarray(12)]);
    expect(detectFormat(bytes).lossy).toBe(true);
  });

  it("handles truncated chunk data conservatively", () => {
    const bytes = riff(extendedHeader(), chunk("VP8L", Buffer.from([0x2f, 0])));
    bytes.writeUInt32LE(0xffffffff, 34);
    expect(detectFormat(bytes).lossy).toBe(true);
    expect(detectFormat(bytes.subarray(0, 15)).lossy).toBe(true);
  });

  it.each([
    [["lossless", "lossless"], false],
    [["lossless", "lossy"], true],
    [["lossy", "lossless"], true],
  ])("detects compression across animation frames %j", (encodings, lossy) => {
    const header = extendedHeader();
    header[8] = 0x02;
    const frames = encodings.map((encoding) => {
      const frame = Buffer.alloc(16);
      frame[6] = 32;
      frame[9] = 16;
      frame[12] = 100;
      return chunk("ANMF", Buffer.concat([frame, fixture(`dims-${encoding}.webp`).subarray(12)]));
    });
    expect(detectFormat(riff(header, chunk("ANIM", Buffer.alloc(6)), ...frames)).lossy).toBe(lossy);
  });

  it("recognises AVIF and PNG from magic bytes", () => {
    expect(detectFormat(new Uint8Array([0, 0, 0, 0x1c, ...ascii("ftypavif")])).name).toBe("AVIF");
    expect(detectFormat(new Uint8Array([0x89, ...ascii("PNG")])).name).toBe("PNG");
  });
});
