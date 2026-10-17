// Aggregates transformers.js per-file progress events into one overall figure.
// Each file reports its own loaded/total bytes. Small JSON configs arrive
// first and finish instantly, so counting them makes the bar hit 99% and then
// fall back when the weights start. Only weight-sized files drive the bar, and
// it never moves backwards within one load attempt.

const WEIGHT_FILE_BYTES = 1024 * 1024;
const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);

export function createDownloadTracker() {
  const files = new Map();
  let shown = 0;

  return function update(event) {
    if (!event?.file) {
      if (event?.status === "ready") return { progress: 100, message: "MODEL READY, STARTING RUNTIME" };
      return null;
    }
    const entry = files.get(event.file) || { loaded: 0, total: 0, done: false };
    if (event.status === "progress") {
      if (Number.isFinite(event.total) && event.total > 0) entry.total = event.total;
      if (Number.isFinite(event.loaded)) entry.loaded = event.loaded;
    }
    if (event.status === "done") {
      entry.done = true;
      if (entry.total) entry.loaded = entry.total;
    }
    files.set(event.file, entry);

    const weights = [...files.values()].filter((f) => f.total >= WEIGHT_FILE_BYTES);
    const total = weights.reduce((sum, f) => sum + f.total, 0);
    const loaded = weights.reduce((sum, f) => sum + Math.min(f.loaded, f.total), 0);
    const finished = [...files.values()].filter((f) => f.done).length;
    const name = event.file.split("/").pop();

    if (!total) {
      return { progress: shown, message: `FETCHING MODEL CONFIG · ${name} (${finished}/${files.size} FILES)` };
    }
    shown = Math.max(shown, Math.min(99, Math.round((loaded / total) * 100)));
    return {
      progress: shown,
      message: `DOWNLOADING MODEL ${mb(loaded)} / ${mb(total)} MB · ${name} (${finished}/${files.size} FILES)`,
    };
  };
}
