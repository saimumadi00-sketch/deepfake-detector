// File checks that run before anything expensive (reading, hashing, decoding).
// Each returns null when the file is acceptable, or a message for the analyst.

export const LIMITS = {
  maxFileBytes: 50 * 1024 * 1024, // larger uploads are almost never single frames
  maxPixels: 100_000_000, // ~400 MB of RGBA once decoded; beyond this tabs crash
};

const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function validateFileInfo({ name, size, type }) {
  const label = `"${name || "unnamed file"}"`;
  // An empty type is common for formats the OS doesn't know (e.g. HEIC on
  // Windows), so only reject files that declare a non-image type; decoding
  // catches the rest.
  if (type && !type.startsWith("image/")) {
    return `${label} is not an image (${type}). Use a JPG, PNG, WebP, AVIF or other browser-supported image.`;
  }
  if (!size) return `${label} is empty (0 bytes).`;
  if (size > LIMITS.maxFileBytes) {
    return `${label} is ${mb(size)}; the limit is ${mb(LIMITS.maxFileBytes)}. Export a smaller copy or crop to the region of interest.`;
  }
  return null;
}

export function validatePixels(name, dimensions) {
  if (!dimensions) return null;
  const { width, height } = dimensions;
  if (width * height > LIMITS.maxPixels) {
    const mp = ((width * height) / 1e6).toFixed(0);
    return `"${name}" is ${width}×${height} (${mp} MP); the limit is ${LIMITS.maxPixels / 1e6} MP. Downscale or crop it before scanning.`;
  }
  return null;
}
