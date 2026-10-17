// Byte-level metadata scan. Everything reported here is read directly from the
// file; nothing is inferred. Metadata is trivially stripped or forged, so these
// findings are context for the analyst, not proof.

const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 64 * 1024;

// Markers written by generators or by IPTC's "digital source type" vocabulary.
// Matching any of these means the file itself declares AI involvement.
const GENERATOR_MARKERS = [
  { pattern: /compositeWithTrainedAlgorithmicMedia/, label: "IPTC source type: composite with AI-generated media" },
  // Case-sensitive: the composite term above uses a capital "T".
  { pattern: /trainedAlgorithmicMedia/, label: "IPTC source type: AI-generated media" },
  { pattern: /Steps: \d+, Sampler: /, label: "Stable Diffusion WebUI generation parameters" },
  { pattern: /"class_type"\s*:/, label: "ComfyUI workflow embedded in file" },
  { pattern: /Midjourney/i, label: "Midjourney marker" },
  // The text is decoded as Latin-1, so a UTF-8 "·" (C2 B7) arrives as "Â·".
  { pattern: /DALL(?:-|·|Â·)?E/, label: "DALL-E marker" },
  { pattern: /Adobe Firefly/i, label: "Adobe Firefly marker" },
  { pattern: /NovelAI/i, label: "NovelAI marker" },
  { pattern: /Stable Diffusion/i, label: "Stable Diffusion marker" },
];

const C2PA_MARKER = /c2pa/;

function bytesToLatin1(bytes) {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return out;
}

function sampleText(bytes) {
  if (bytes.length <= HEAD_BYTES + TAIL_BYTES) return bytesToLatin1(bytes);
  return bytesToLatin1(bytes.subarray(0, HEAD_BYTES)) + bytesToLatin1(bytes.subarray(bytes.length - TAIL_BYTES));
}

function readAscii(view, offset, length) {
  let out = "";
  for (let i = 0; i < length && offset + i < view.byteLength; i += 1) {
    const code = view.getUint8(offset + i);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim();
}

// Minimal EXIF reader: finds the JPEG APP1 "Exif" segment and pulls the IFD0
// Make / Model / Software ASCII tags. Returns null if no EXIF block exists.
export function readJpegExif(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) return null; // start of scan / end of image
    const segmentLength = view.getUint16(offset + 2);

    if (marker === 0xe1 && readAscii(view, offset + 4, 4) === "Exif") {
      const tiff = offset + 10;
      const little = view.getUint16(tiff) === 0x4949;
      const u16 = (at) => view.getUint16(at, little);
      const u32 = (at) => view.getUint32(at, little);
      const tags = {};

      try {
        const ifd0 = tiff + u32(tiff + 4);
        const count = u16(ifd0);
        for (let i = 0; i < count; i += 1) {
          const entry = ifd0 + 2 + i * 12;
          const tag = u16(entry);
          const type = u16(entry + 2);
          const length = u32(entry + 4);
          if (type !== 2) continue; // ASCII only
          const valueOffset = length <= 4 ? entry + 8 : tiff + u32(entry + 8);
          if (tag === 0x010f) tags.make = readAscii(view, valueOffset, length);
          if (tag === 0x0110) tags.model = readAscii(view, valueOffset, length);
          if (tag === 0x0131) tags.software = readAscii(view, valueOffset, length);
        }
      } catch {
        // Truncated or malformed IFD: report the block exists but no tags.
      }
      return tags;
    }

    offset += 2 + segmentLength;
  }
  return null;
}

// IJG / libjpeg standard luminance quantization table (quality 50).
const STD_LUMA_SUM = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87,
  80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92,
  95, 98, 112, 100, 103, 99,
].reduce((a, b) => a + b, 0);

// Estimates the libjpeg-equivalent quality (1-100) from the luminance
// quantization table. Encoders scale the standard table by
// S = q < 50 ? 5000 / q : 200 - 2q, so the table-sum ratio inverts to q.
// Cameras that use custom tables still land close to their effective quality.
export function estimateJpegQuality(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const segmentLength = view.getUint16(offset + 2);

    if (marker === 0xdb) {
      let p = offset + 4;
      const end = offset + 2 + segmentLength;
      while (p < end) {
        const precision = bytes[p] >> 4;
        const tableId = bytes[p] & 0x0f;
        const entrySize = precision ? 2 : 1;
        let sum = 0;
        for (let i = 0; i < 64; i += 1) {
          sum += precision ? view.getUint16(p + 1 + i * 2) : bytes[p + 1 + i];
        }
        if (tableId === 0) {
          const scale = (sum * 100) / STD_LUMA_SUM;
          const quality = scale <= 100 ? (200 - scale) / 2 : 5000 / scale;
          return Math.max(1, Math.min(100, Math.round(quality)));
        }
        p += 1 + 64 * entrySize;
      }
    }

    offset += 2 + segmentLength;
  }
  return null;
}

// Pixel dimensions read from the file header, without decoding. Used to refuse
// decompression bombs (a small file declaring a huge canvas) before the
// browser allocates memory for them. Returns null for formats it can't read
// (AVIF, HEIC); those are checked after decoding instead.
export function readImageDimensions(bytes) {
  if (bytes.length < 30) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));

  if (ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (ascii(0, 3) === "GIF") {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      const u24 = (at) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
      return { width: u24(24) + 1, height: u24(27) + 1 };
    }
    return null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      // SOF0-SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) do not.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      if (marker === 0xda || marker === 0xd9) return null;
      offset += 2 + view.getUint16(offset + 2);
    }
  }
  return null;
}

// Container format from magic bytes (the browser's MIME type is just the file
// extension). Lossy formats other than JPEG have no quantization table to read,
// so their compression level is unknown rather than "clean".
export function detectFormat(bytes) {
  const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { name: "JPEG", lossy: true };
  if (ascii(1, 3) === "PNG") return { name: "PNG", lossy: false };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    return chunk === "VP8L" ? { name: "WebP (lossless)", lossy: false } : { name: "WebP (lossy)", lossy: true };
  }
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand.startsWith("avi")) return { name: "AVIF", lossy: true };
    if (["heic", "heix", "mif1", "msf1"].includes(brand)) return { name: "HEIC", lossy: true };
  }
  if (ascii(0, 3) === "GIF") return { name: "GIF", lossy: false };
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return { name: "BMP", lossy: false };
  return { name: "unknown", lossy: null };
}

export function scanMetadata(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const text = sampleText(bytes);

  const generatorMarkers = GENERATOR_MARKERS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
  const exif = readJpegExif(bytes);

  return {
    generatorMarkers,
    hasC2pa: C2PA_MARKER.test(text),
    exif,
    camera: exif?.make || exif?.model ? [exif.make, exif.model].filter(Boolean).join(" ") : null,
    software: exif?.software || null,
    jpegQuality: estimateJpegQuality(bytes),
    format: detectFormat(bytes),
  };
}
