// Maps raw browser / runtime errors to messages an analyst can act on. The raw
// text is always kept in `detail` so nothing is hidden when reporting a bug.

const raw = (error) => String(error?.message || error || "unknown error").trim();
const trimPeriod = (text) => text.replace(/\.+$/, "");

function matches(error, ...patterns) {
  const text = `${error?.name || ""} ${raw(error)}`;
  return patterns.some((pattern) => pattern.test(text));
}

export function describeEngineError(error) {
  const detail = trimPeriod(raw(error));
  if (matches(error, /failed to fetch/i, /networkerror/i, /load failed/i, /network request failed/i)) {
    return {
      title: "Couldn't download the detection model",
      hint: "The browser could not reach Hugging Face. Check your connection, VPN or proxy, and allow huggingface.co and *.hf.co.",
      detail,
    };
  }
  if (matches(error, /\b40[134]\b/, /could not locate file/i, /not found/i)) {
    return {
      title: "Model files not found",
      hint: "Hugging Face did not return the pinned model files. The repository may have moved or become private.",
      detail,
    };
  }
  if (matches(error, /quota/i)) {
    return {
      title: "Browser storage is full",
      hint: "The model could not be cached. Free up site storage for this page (browser settings) and retry.",
      detail,
    };
  }
  if (matches(error, /webassembly/i, /\bwasm\b/i, /mime/i, /no available backend/i)) {
    return {
      title: "The inference runtime couldn't start",
      hint: "WebAssembly failed to load. If this is a deployed copy, check that .wasm is served as application/wasm and that the CSP allows 'wasm-unsafe-eval'.",
      detail,
    };
  }
  return {
    title: "The detection engine failed to load",
    hint: "Retry. If it keeps failing, reload the page and check the browser console.",
    detail,
  };
}

export function describeScanError(error) {
  const detail = trimPeriod(raw(error));
  if (matches(error, /could not be decoded/i, /invalidstate/i, /encodingerror/i)) {
    return {
      title: "The image could not be decoded",
      hint: "The file may be corrupt or truncated. Re-export it or select another file.",
      detail,
    };
  }
  if (matches(error, /out of memory/i, /allocation/i, /rangeerror/i)) {
    return {
      title: "Not enough memory to analyse this image",
      hint: "Close other tabs, or downscale or crop the image and scan it again.",
      detail,
    };
  }
  return {
    title: "Analysis failed",
    hint: "Retry the scan. If it fails again, reload the page.",
    detail,
  };
}

export function describeReadError(error) {
  const detail = trimPeriod(raw(error));
  if (typeof crypto === "undefined" || !crypto.subtle) {
    return {
      title: "Hashing is unavailable on this connection",
      hint: "The browser only provides SHA-256 on secure pages. Open the app over HTTPS or via http://localhost, not a plain-HTTP network address.",
      detail,
    };
  }
  if (matches(error, /notreadable/i, /notfound/i, /permission/i)) {
    return {
      title: "The file could not be read",
      hint: "It may have been moved, deleted, or locked by another program. Select it again.",
      detail,
    };
  }
  return { title: "The file could not be read", hint: "Select it again.", detail };
}
