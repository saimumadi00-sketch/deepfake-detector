# SYNTHSEC — Synthetic Media Forensics Terminal

SYNTHSEC is a browser-side forensics terminal for triaging suspected AI-generated images in security investigations: fake executive photos in phishing, synthetic KYC selfies, AI-generated personas in influence operations, and captured frames from impersonation calls.

Everything runs locally in the browser. No image, hash, or report leaves the machine.

## Local setup

**Prerequisites:** Node.js 18 or newer (tested on Node 22) and npm. A current Chrome, Edge, Firefox or Safari with WebAssembly support. Internet access on first use, to download the model.

```bash
git clone <repo-url> synthsec
cd synthsec
npm ci              # exact versions from package-lock.json (use `npm install` to update the lockfile)
npm run dev         # development server at http://localhost:5173
```

Open the URL, wait for **ENGINE READY** in the top-right panel, then drop an image.

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with hot reload |
| `npm test` | Unit tests for the verdict rules and metadata parsing (no browser or network needed) |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serves `dist/` at http://localhost:4173 to check the production build |

**First run:** the browser downloads the detection model (~22 MB) from Hugging Face. It is cached in the browser's Cache Storage, so later visits load from cache. If the download fails, the engine panel shows **ENGINE OFFLINE** with the error and a **RETRY ENGINE LOAD** button. Scanning stays disabled, and no verdict is ever produced without the model.

**`npm audit` warnings:** the advisories come from `sharp` (used only by transformers.js under Node, never in the browser bundle) and from the test runner. Neither ships to users. Avoid `npm audit fix --force`, which installs breaking major versions.

## Deploying (static hosting)

The build is a fully static site, with no server code, API or environment variables. Any static host works.

```bash
npm run build       # writes dist/
```

`dist/` contains:

| File | Size | Notes |
|---|---|---|
| `index.html` | < 1 KB | Entry point |
| `assets/index-[hash].js` | ~1 MB (~290 KB gzip) | App + transformers.js |
| `assets/ort-wasm-simd-threaded.jsep-[hash].mjs` | 44 KB | ONNX Runtime loader |
| `assets/ort-wasm-simd-threaded.jsep-[hash].wasm` | 21.6 MB (~5 MB gzip) | ONNX Runtime engine |

Vite warns that the JS chunk is over 500 KB. That is expected (it is mostly transformers.js) and harmless.

**What the build relies on:**

- **Any path works.** Asset URLs are relative (`base: "./"` in `vite.config.js`), so `dist/` can be served from a domain root or a subpath such as `https://<user>.github.io/<repo>/`. No rewrite rules are needed; it's a single page with no client-side routes.
- **ONNX Runtime is self-hosted.** transformers.js would otherwise fetch the runtime from `cdn.jsdelivr.net`; `src/lib/engine.js` points it at the copy in `dist/assets/` instead. The only third-party requests the deployed site makes are to Hugging Face for the model: `huggingface.co` plus its file CDN (`*.hf.co`). No image data is sent.
- **MIME types.** The host must serve `.wasm` as `application/wasm` and `.mjs` as JavaScript. Current static hosts and Python's `http.server` do this by default. Older nginx or Apache configs may need both types added to their MIME map.
- **No special headers required.** ONNX Runtime runs single-threaded when the page isn't cross-origin isolated, which works everywhere. COOP/COEP headers (for multi-threading) have not been tested with Hugging Face's CDN, so they aren't recommended here.
- **File size limits.** The largest file is the 21.6 MB WASM, under Cloudflare Pages' 25 MiB per-file limit and well within the limits of the other hosts listed.

### Host settings

| Host | Build command | Output directory |
|---|---|---|
| Netlify | `npm run build` | `dist` |
| Vercel (framework preset: Vite) | `npm run build` | `dist` |
| Cloudflare Pages | `npm run build` | `dist` |
| Any web server (nginx, Apache, S3, …) | run locally | upload the contents of `dist/` |

**GitHub Pages** (repository Settings → Pages → Source: GitHub Actions), using `.github/workflows/pages.yml`:

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
      - id: deployment
        uses: actions/deploy-pages@v4
```

The Netlify, Vercel, Cloudflare and GitHub Pages settings are the standard ones for a Vite build. They were not deployed as part of this project. What was tested is the build itself: served from a `/synthsec/` subpath with a plain static server, with jsdelivr blocked, in a fresh browser profile (model download, scan, verdict), and again under the CSP below.

### Recommended headers (optional)

Hashed files in `assets/` never change, so they can be cached forever. `index.html` should always be revalidated so new deploys are picked up:

```text
/assets/*     Cache-Control: public, max-age=31536000, immutable
/index.html   Cache-Control: no-cache
```

A Content-Security-Policy that the production build was tested against (full scan, zero violations):

```text
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

Each part is needed for a reason:

- `'wasm-unsafe-eval'` lets ONNX Runtime compile its WebAssembly.
- `style-src 'unsafe-inline'` is for the component's inline `<style>` block.
- `blob:` in `img-src` is for the image preview.
- `connect-src` covers the model download. If the model ever fails to load under this policy, check the browser console for the blocked Hugging Face host and add it.

On Netlify or Cloudflare Pages, these go in a `_headers` file in `public/`. Vite copies it into `dist/`.

### Troubleshooting a deployment

| Symptom | Likely cause |
|---|---|
| Blank page, 404s for `assets/...` | Files uploaded without the `assets/` folder, or `base` changed from `"./"` |
| ENGINE OFFLINE: "Failed to fetch" | Network, proxy or CSP blocking Hugging Face; check the console for the blocked host |
| ENGINE OFFLINE mentioning WebAssembly or a MIME type | `.wasm` not served as `application/wasm`, or CSP missing `'wasm-unsafe-eval'` |
| Works locally, fails behind a corporate proxy | The proxy blocks `huggingface.co` / `*.hf.co`; allowlist them or mirror the model (see below) |

**Fully offline / air-gapped use** isn't set up yet. It would mean mirroring the pinned model revision (`buildborderless/CommunityForensics-DeepfakeDet-ViT@ac6ee45`, `onnx/model_uint8.onnx` plus the config files) onto your own host, and setting `env.remoteHost` / `env.allowLocalModels` in `src/lib/engine.js`.

## Scanning workflow

1. **Load an image:** drag it onto the ingest panel, or click (or Tab + Enter) the drop zone to open the file picker. Dropping or picking a new file at any point replaces the current one.
2. **Validation** runs before anything is scanned, cheapest checks first:

   | Check | Limit |
   |---|---|
   | File type | must be an image (or an unknown type the browser can decode) |
   | File size | 1 byte – 50 MB |
   | Declared pixel count, read from the file header before decoding | ≤ 100 MP (stops decompression bombs) |
   | Decoding | the browser must be able to decode it; corrupt files are rejected here |

   A rejected replacement leaves the current image and result untouched.
3. **Preview and SHA-256:** the preview appears after hashing, decoding and dimension checks finish. No preview URL is created for an oversized or undecodable image. The SHA-256 of the exact file bytes becomes the report's asset ID. Hashing needs a secure context, so open the app over HTTPS or via `localhost`, not a plain-HTTP LAN address.
4. **Scan:** available once the engine shows **ENGINE READY**. The top-right panel shows overall model download progress in MB.
5. **Controls:**
   - **REPLACE FILE** and **CLEAR** before a scan
   - **CANCEL SCAN** and **REPLACE FILE** during one
   - **RETRY SCAN** after a failure
   - **EXPORT TEXT**, **EXPORT JSON**, **COPY FINDINGS** and **SCAN ANOTHER** after a result
   - **RETRY ENGINE LOAD** if the model download fails

**Stale work never reaches the screen.** Loading or replacing a file, starting or cancelling a scan, and clearing each start a new generation. Queued scans check this generation before preprocessing and inference, so cancelled or replaced scans are skipped. A preprocessing or model call already in progress finishes in the background, but remaining views are skipped and no partial result is reported. Inference runs one scan at a time (the ONNX session cannot run two at once), so scanning a replacement immediately after cancelling is safe.

## How a verdict is reached

1. **Metadata scan.** Generator declarations come from specific metadata fields: EXIF software tags, uncompressed PNG text fields and XMP in PNG, JPEG or WebP. Recognised declarations include IPTC digital source types, Stable Diffusion WebUI parameters, ComfyUI sampling nodes and complete generator names in software/creator fields. Tool names in captions, JPEG comments or arbitrary bytes do not affect the verdict. Compressed PNG text and unsupported metadata containers are skipped. The scan also checks for a C2PA marker (not verified), camera/software EXIF, the real container format (from magic bytes, not the file extension), and JPEG quality estimated from the quantization table.
2. **Detector.** [CommunityForensics ViT-S/384](https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT) (MIT, CVPR 2025, trained on 2.7M images from 4,803 generators) scores the image and a mirrored copy. Output is `P(generated)`. The model is pinned to commit `ac6ee45`.
3. **Rules** (`src/lib/analysis.js`, unit tested):

| Condition | Verdict |
|---|---|
| Mean score ≥ 80% | **LIKELY SYNTHETIC** |
| Mean score ≤ 20% on a reasonably clean file | **NO SYNTHETIC SIGNAL** |
| Score between 20% and 80% | INCONCLUSIVE |
| Original and mirrored views land in different bands (low / middle / high), or differ by > 25 points | INCONCLUSIVE |
| Low score on a degraded file (short side < 320px, JPEG quality < 70, or quality < 85 at < 512px) | INCONCLUSIVE |
| Low score on a lossy WebP / AVIF / HEIC under 512px (compression can't be measured) | INCONCLUSIVE |
| Short side < 128px (outside anything validated) | INCONCLUSIVE |
| File declares an AI generator in its metadata | **LIKELY SYNTHETIC** |

Resolution checks use the image prepared for the model. The engine limits its longest side to 4096px, which can reduce a panorama's short side below the tested minimum even when the original is large. Results explain any such resize; reports retain both the original dimensions and the prepared dimensions before model preprocessing.

The degradation rule is deliberately asymmetric: compression hides generated images but did not create false positives (see below). So a high score on a poor file still counts, but a low score does not clear it.

Every result shows **why** it was reached (each reason cites a measured value), the per-view scores against the thresholds, and the **limits** that apply to that specific image, for example when the 384px centre crop leaves the edges of a wide image unanalysed.

## Validation

The previous version of this app loaded `Xenova/deepfake-detection`, which does not exist, so every scan silently fell back to a generic ImageNet classifier. Its verdicts and "anomaly indicators" were not real measurements. Before choosing a replacement, candidate detectors were scored in the browser on a small labelled set:

- **Real:** 24 portrait photographs from Wikimedia Commons
- **GAN:** 16 StyleGAN faces from thispersondoesnotexist.com
- **Diffusion:** 19 images from Wikimedia Commons' AI-generated categories
- Each image was also tested in degraded copies (320px, 512px, JPEG quality 55/70/75/85, and combinations)

| Detector | AUC (real vs GAN) | Real photos flagged ≥ 80% |
|---|---|---|
| **CommunityForensics ViT-S/384 (chosen)** | **1.00** | **0 / 192** (originals + all degraded copies) |
| dima806 deepfake_vs_real (ONNX) | 0.94 | 2 / 24 |
| SMOGY AI-images detector | 0.59 | 2 / 24 |
| Deep-Fake-Detector-v2 | 0.18 (inverted) | 8 / 24 |
| AI-vs-Deepfake-vs-Real | 0.20 (inverted) | 1 / 24 |

What the chosen model missed:

- 4 of 19 diffusion images even at full quality
- 17 of 19 diffusion images after downscaling to 320px plus JPEG quality 55; quality 55 alone dropped detection from 14/19 to 6/19

These numbers set the rules above. They come from a **small sample**: a sanity check, not a benchmark.

## Limitations

- Detects **fully generated** images. Face swaps, inpainting, and retouching on a real photo were not validated and may go undetected.
- NO SYNTHETIC SIGNAL is not proof of authenticity. New generators may evade the model.
- Screenshots, filters, and repeated re-sharing strip the traces the model relies on.
- Metadata is trivially stripped or forged; it is reported as context, and only a generator declaration affects the verdict.
- Analyst review, provenance checks, reverse image search, and account-history correlation are still required for high-impact decisions.

## Project layout

```text
src/
  DeepfakeDetector.jsx   UI
  lib/engine.js          model loading, image decoding, inference
  lib/analysis.js        verdict rules and explanations (pure)
  lib/metadata.js        generator markers, C2PA, EXIF, JPEG quality, header dimensions (pure)
  lib/ingest.js          file size / type / pixel-count validation (pure)
  lib/errors.js          raw errors -> actionable messages (pure)
  lib/progress.js        overall model-download progress (pure)
  lib/queue.js           one-at-a-time inference queue (pure)
  lib/report.js          report object, text/JSON/findings renderings (pure)
  lib/*.test.js          unit tests
  lib/fixtures/          tiny generated images used by the tests
```

## Reports

Every result can be exported as a **text report** (for people) or a **JSON report** (for tools and case files). Both are rendered from the same object (`src/lib/report.js`), so they always agree. Files are named `synthsec-<first 12 hex of SHA-256>-<scan time>.txt|json`.

**COPY FINDINGS** copies a short plain-text summary for a ticket or chat: file, SHA-256, verdict, model probability, model identity, scan time, findings and summary.

*Findings* are the reasons that need an analyst's attention: model risk signals, and anything that made a result inconclusive. They used to be labelled "IOC flags". They are classifier observations, not indicators of compromise.

Every report states that the probability is the model's output, not the chance the verdict is correct. Inexact scores are never printed as 0% or 100%: `>99.9%` means the model is very confident, not certain.

JSON report (`synthsec.report/v1`):

```json
{
  "schema": "synthsec.report/v1",
  "generatedAt": "2026-10-17T08:39:34.258Z",
  "generator": { "name": "SYNTHSEC", "version": "2.0.0" },
  "file": {
    "name": "suspect.jpg",
    "declaredMediaType": "image/jpeg",
    "detectedFormat": "JPEG",
    "sizeBytes": 520702,
    "sha256": "4cbf4417…aeb45",
    "width": 1024,
    "height": 1024,
    "jpegQualityEstimate": 99
  },
  "scan": { "startedAt": "2026-10-17T08:39:32.193Z", "durationMs": 1977 },
  "model": {
    "id": "buildborderless/CommunityForensics-DeepfakeDet-ViT",
    "revision": "ac6ee457bea904a373065754107451793b56db00",
    "dtype": "uint8",
    "name": "CommunityForensics ViT-S/384",
    "runtime": "@huggingface/transformers@3.7.5",
    "card": "https://huggingface.co/…",
    "paper": "https://huggingface.co/papers/2411.04125"
  },
  "rawScores": {
    "output": "sigmoid(logit) = model probability that the image is generated",
    "views": [
      { "view": "Original", "logit": 10.638, "probability": 0.99997 },
      { "view": "Mirrored", "logit": 9.1196, "probability": 0.99989 }
    ],
    "meanProbability": 0.99993,
    "spread": 0.00009
  },
  "interpretation": {
    "verdict": "LIKELY_SYNTHETIC | INCONCLUSIVE | NO_SIGNAL",
    "label": "LIKELY SYNTHETIC",
    "level": "HIGH | REVIEW | LOW",
    "summary": "string",
    "thresholds": { "noSignalAtOrBelow": 0.2, "likelySyntheticAtOrAbove": 0.8, "maxViewSpread": 0.25 },
    "stableAcrossViews": true,
    "inputCondition": { "level": "clean | mild | severe", "causes": ["string"] },
    "reasons": [{ "tone": "risk | review | clear | neutral", "title": "string", "detail": "string" }],
    "caveats": ["string"]
  },
  "metadata": { "generatorMarkers": [], "c2paManifestPresent": false, "camera": null, "software": null },
  "findings": [{ "severity": "risk | review", "title": "string", "detail": "string" }],
  "disclaimer": "string"
}
```

Raw scores in the JSON are unrounded. The file identity is captured when the scan runs, so a report can never pair a result with a file loaded afterwards.

## Disclaimer

SYNTHSEC is for educational, research, and defensive security workflows. It must not be the sole basis for legal, employment, financial, or identity-verification decisions.
