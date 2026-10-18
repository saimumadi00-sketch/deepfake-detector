// Byte-level metadata scan. Everything reported here is read directly from the
// file; nothing is inferred. Metadata is trivially stripped or forged, so these
// findings are context for the analyst, not proof.

const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 64 * 1024;

// Only match complete tool names in software/creator fields. A caption or
// JPEG comment discussing a generator does not declare how the image was made.
const GENERATOR_TOOLS = [
  { pattern: /^Midjourney(?:\s+v?\d[\w.-]*)?$/i, label: "Midjourney marker" },
  { pattern: /^DALL(?:-|\u00b7)?E(?:\s+\d[\w.-]*)?$/i, label: "DALL-E marker" },
  { pattern: /^Adobe Firefly(?:\s+\d[\w.-]*)?$/i, label: "Adobe Firefly marker" },
  { pattern: /^NovelAI(?:\s+\d[\w.-]*)?$/i, label: "NovelAI marker" },
  { pattern: /^Stable Diffusion(?: WebUI)?(?:\s+(?:XL|v?\d[\w.-]*))?$/i, label: "Stable Diffusion marker" },
  { pattern: /^ComfyUI(?:\s+v?\d[\w.-]*)?$/i, label: "ComfyUI software tag" },
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

// Read bounded, uncompressed text fields from actual image containers. Image
// data, JPEG comments, and arbitrary trailing bytes are never generator fields.
function readTextFields(bytes) {
  const fields = [];
  let remaining = HEAD_BYTES + TAIL_BYTES;
  const utf8 = new TextDecoder();
  const add = (key, value, unicode = false) => {
    if (value.length > remaining) return;
    remaining -= value.length;
    fields.push({ key, value: unicode ? utf8.decode(value) : bytesToLatin1(value) });
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start, end) => bytesToLatin1(bytes.subarray(start, end));

  if (bytes.length >= 8 && ascii(0, 8) === "\x89PNG\r\n\x1a\n") {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      const start = offset + 8;
      const end = start + length;
      if (end + 4 > bytes.length) break;
      const type = ascii(offset + 4, start);
      if (type === "tEXt" || type === "iTXt") {
        const data = bytes.subarray(start, end);
        const separator = data.indexOf(0);
        if (separator > 0 && separator <= 79) {
          const key = bytesToLatin1(data.subarray(0, separator));
          if (type === "tEXt") {
            add(key, data.subarray(separator + 1));
          } else if (data[separator + 1] === 0 && data[separator + 2] === 0) {
            // iTXt: keyword, flag, method, language, translated keyword, text.
            const languageEnd = data.indexOf(0, separator + 3);
            const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1);
            if (translatedEnd >= 0) add(key, data.subarray(translatedEnd + 1), true);
          }
        }
      }
      if (type === "IEND") break;
      offset = end + 4;
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(offset + 2);
      const end = offset + 2 + length;
      if (length < 2 || end > bytes.length) break;
      const prefix = "http://ns.adobe.com/xap/1.0/\0";
      if (marker === 0xe1 && ascii(offset + 4, offset + 4 + prefix.length) === prefix) {
        add("XMP", bytes.subarray(offset + 4 + prefix.length, end), true);
      }
      offset = end;
    }
  } else if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = view.getUint32(offset + 4, true);
      const end = offset + 8 + length;
      if (end > bytes.length) break;
      if (ascii(offset, offset + 4) === "XMP ") add("XMP", bytes.subarray(offset + 8, end), true);
      offset = end + (length % 2);
    }
  }
  return fields;
}

// XMP properties can be attributes, text elements, or rdf:resource elements.
// Only these named properties are considered; descriptive prose is ignored.
function xmpValues(packet, property) {
  const xml = packet.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const values = [];
  const tags = /<[A-Za-z_][\w:.-]*(?:"[^"]*"|'[^']*'|[^'">])*?>/g;
  const attributes = /\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const [tag] of xml.matchAll(tags)) {
    for (const match of tag.matchAll(attributes)) {
      if (match[1].split(":").pop() === property) values.push((match[2] ?? match[3]).trim());
    }
  }
  const elements = new RegExp(`<((?:[\\w.-]+:)?${property})\\b([^>]*?)(?:/>|>([\\s\\S]*?)</\\1\\s*>)`, "g");
  for (const match of xml.matchAll(elements)) {
    const resource = /\brdf:resource\s*=\s*["']([^"']+)["']/.exec(match[2]);
    if (resource) values.push(resource[1].trim());
    else if (match[3] && !match[3].includes("<")) values.push(match[3].trim());
  }
  return values;
}

function generatorDeclarations(fields, exif) {
  const markers = new Set();
  const tool = (value) => {
    for (const { pattern, label } of GENERATOR_TOOLS) {
      if (pattern.test(value.trim())) markers.add(label);
    }
  };
  if (exif?.software) tool(exif.software);
  for (const { key, value } of fields) {
    if (/^(Software|Source|Generator|CreatorTool)$/i.test(key)) tool(value);
    if (key === "parameters" && /(?:^|\r?\n)Steps: \d+, Sampler: [^\r\n]+/.test(value)) {
      markers.add("Stable Diffusion WebUI generation parameters");
    }
    if (key === "prompt" || key === "workflow") {
      try {
        const workflow = JSON.parse(value);
        const nodes = key === "workflow" ? workflow?.nodes : Object.values(workflow || {});
        if (Array.isArray(nodes) && nodes.some((node) => /^(KSampler(?:Advanced)?|SamplerCustom(?:Advanced)?)$/.test(node?.class_type || node?.type))) {
          markers.add("ComfyUI workflow embedded in file");
        }
      } catch {
        // Ordinary prompts and malformed JSON are not generator declarations.
      }
    }
    if (key === "XMP" || key === "XML:com.adobe.xmp") {
      for (const creator of xmpValues(value, "CreatorTool")) tool(creator);
      for (const source of xmpValues(value, "DigitalSourceType")) {
        if (source === "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia") {
          markers.add("IPTC source type: AI-generated media");
        } else if (source === "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia") {
          markers.add("IPTC source type: composite with AI-generated media");
        }
      }
    }
  }
  return [...markers];
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

// VP8X describes container features, not compression. Walk the padded RIFF
// chunks to find the actual VP8/VP8L bitstream, including animation frames.
// https://developers.google.com/speed/webp/docs/riff_container
function webpIsLossless(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = Math.min(bytes.length, 8 + view.getUint32(4, true));
  const scan = (start, limit, allowFrames) => {
    let lossless = false;
    for (let offset = start; offset + 8 <= limit;) {
      const type = bytesToLatin1(bytes.subarray(offset, offset + 4));
      const length = view.getUint32(offset + 4, true);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      const next = dataEnd + (length % 2);
      // Unknown/truncated data keeps the existing conservative lossy treatment.
      if (next > limit) return false;
      if (type === "VP8 ") return false;
      if (type === "VP8L") lossless = true;
      if (type === "ANMF") {
        // Only one frame nesting level is valid. Its fixed header is 16 bytes.
        if (!allowFrames || length < 16 || !scan(dataStart + 16, dataEnd, false)) return false;
        lossless = true;
      }
      offset = next;
    }
    return lossless;
  };
  // An animation is only lossless if every frame's bitstream is lossless.
  return scan(12, end, true);
}

// Container format from magic bytes (the browser's MIME type is just the file
// extension). Lossy formats other than JPEG have no quantization table to read,
// so their compression level is unknown rather than "clean".
export function detectFormat(bytes) {
  const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { name: "JPEG", lossy: true };
  if (ascii(1, 3) === "PNG") return { name: "PNG", lossy: false };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    return webpIsLossless(bytes) ? { name: "WebP (lossless)", lossy: false } : { name: "WebP (lossy)", lossy: true };
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

  const exif = readJpegExif(bytes);
  const generatorMarkers = generatorDeclarations(readTextFields(bytes), exif);

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
