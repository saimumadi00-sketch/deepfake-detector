// Runs async tasks one at a time. An ONNX Runtime session throws "Session
// already started" if run concurrently, which happens when an analyst replaces
// the file mid-scan and starts a new scan before the old inference finishes.
export function createSerialQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}
