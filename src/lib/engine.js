import { AutoModelForImageClassification, AutoProcessor, env, RawImage } from "@huggingface/transformers";
// ONNX Runtime's WASM binary and its JS loader, served from this site. Without
// this, transformers.js fetches both from cdn.jsdelivr.net at runtime, which
// would mean executing third-party code in a tool that promises local analysis.
// The package has no subpath exports, hence the relative node_modules path.
import ortMjsUrl from "../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs?url";
import ortWasmUrl from "../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm?url";
import { createDownloadTracker } from "./progress.js";
import { createSerialQueue } from "./queue.js";

export const RUNTIME = "@huggingface/transformers@3.7.5";

// One model, pinned to a commit so results cannot drift when the repo changes.
// There is deliberately no fallback: a model that has not been validated here
// would produce verdicts nobody can vouch for.
//
// Chosen after a local check (see README "Validation"): on 24 real portraits
// and 35 generated images it raised no false positives, including on
// downscaled / recompressed copies. Two face-deepfake ViTs tested alongside it
// scored real photos *higher* than fakes.
export const MODEL = {
  id: "buildborderless/CommunityForensics-DeepfakeDet-ViT",
  revision: "ac6ee457bea904a373065754107451793b56db00",
  // int8/q8 uses ConvInteger, which onnxruntime-web cannot run; uint8 matches
  // fp32 on the validation set at a quarter of the download.
  dtype: "uint8",
  name: "CommunityForensics ViT-S/384",
  card: "https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT",
  paper: "https://huggingface.co/papers/2411.04125",
  // Figures quoted in explanations; see README "Validation" for the method.
  validation: {
    summary: "24 real portraits, 16 StyleGAN faces and 19 diffusion images, each also downscaled and recompressed",
    realMax: "4%",
    cleanMissed: "4 of 19 diffusion",
    degradedMissed: "17 of 19 diffusion",
  },
};

// Upper bound on the decoded canvas. The processor resizes to 440px / crops to
// 384px; this only keeps memory bounded on very large photos.
const MAX_DECODE_SIDE = 4096;

let enginePromise = null;

// One ONNX session, one inference at a time (see queue.js).
const inferenceQueue = createSerialQueue();

export function loadEngine(onProgress) {
  if (!enginePromise) {
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    env.backends.onnx.wasm.wasmPaths = {
      mjs: new URL(ortMjsUrl, document.baseURI).href,
      wasm: new URL(ortWasmUrl, document.baseURI).href,
    };
    const track = createDownloadTracker();
    const options = {
      revision: MODEL.revision,
      progress_callback: (event) => {
        const update = track(event);
        if (update) onProgress?.(update);
      },
    };
    enginePromise = Promise.all([
      AutoProcessor.from_pretrained(MODEL.id, options),
      AutoModelForImageClassification.from_pretrained(MODEL.id, { ...options, dtype: MODEL.dtype }),
    ])
      .then(([processor, model]) => ({ processor, model }))
      .catch((error) => {
        enginePromise = null;
        throw error;
      });
  }
  return enginePromise;
}

function drawView(bitmap, width, height, mirrored) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  // Flatten transparency onto black so PNG alpha does not change the score
  // between runs or browsers.
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  if (mirrored) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  return RawImage.fromCanvas(canvas).rgb();
}

// Decodes the file once and returns its true pixel size plus the two views fed
// to the model.
export async function decodeViews(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, MAX_DECODE_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    return {
      width: bitmap.width,
      height: bitmap.height,
      views: [
        { name: "Original", image: drawView(bitmap, w, h, false) },
        { name: "Mirrored", image: drawView(bitmap, w, h, true) },
      ],
    };
  } finally {
    bitmap.close();
  }
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// The model has a single output logit: sigmoid(logit) is P(generated). The
// generic image-classification pipeline would softmax that single logit to a
// constant 1.0, so the model is called directly.
export function scoreViews(engine, views) {
  return inferenceQueue(() => runViews(engine, views));
}

async function runViews({ processor, model }, views) {
  const scored = [];
  for (const view of views) {
    const inputs = await processor(view.image);
    const { logits } = await model(inputs);
    const logit = logits.data[0];
    if (logits.data.length !== 1 || !Number.isFinite(logit)) {
      throw new Error(`Model returned ${logits.data.length} outputs; expected one finite logit`);
    }
    scored.push({ name: view.name, fakeProbability: sigmoid(logit), logit });
  }
  return scored;
}
