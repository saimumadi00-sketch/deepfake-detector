# SYNTHSEC — Synthetic Media Forensics Terminal

SYNTHSEC is a browser-side digital media forensics terminal for triaging suspected synthetic image assets in security investigations. It is designed for security analysts, OSINT investigators, fraud teams, and threat intelligence workflows where manipulated profile images or generated identity artifacts may be part of an attack chain.

## Threat Model

SYNTHSEC focuses on static image frames that may be used in:

- Social engineering and spear phishing with fake executive or employee photos
- Identity fraud and KYC abuse using synthetic onboarding images
- Disinformation campaigns using AI-generated news personas or profile photos
- Deepfake-assisted vishing and impersonation investigations using captured video-call frames

## Use Cases

```text
USE CASES
─────────────────────────────────────
• Phishing Defense       Verify sender identity photos in BEC attacks
• KYC Fraud Detection    Screen onboarding photos for synthetic faces
• OSINT Investigation    Validate profile images in threat actor profiling
• Disinformation Intel   Flag AI-generated personas in influence operations
• Vishing Analysis       Authenticate video call frames for impersonation
```

## Stack

- React JSX single-component interface
- Transformers.js CDN runtime: `@xenova/transformers@2.17.2`
- Primary model: [`Xenova/deepfake-detection`](https://huggingface.co/Xenova/deepfake-detection)
- Fallback model: [`Xenova/vit-base-patch16-224`](https://huggingface.co/Xenova/vit-base-patch16-224)
- ONNX Web Runtime in the browser
- No backend, no API key, no paid inference service

The app attempts to load the primary model first and falls back to `Xenova/vit-base-patch16-224` if the primary model cannot initialize.

## Privacy Guarantee

No suspect image, SHA-256 asset hash, IOC flag, or generated report is uploaded to an inference API. Uploaded images are processed through an in-memory object URL, hashed with `crypto.subtle.digest("SHA-256", ...)`, and classified locally in the browser.

The browser still downloads public runtime/model files from the CDN and Hugging Face model hosting during first use. After that, normal browser cache behavior may reuse those assets.

## Features

- Drag/drop or file-picker media ingest for browser-supported images
- SHA-256 `ASSET ID` generation for incident correlation
- Detection-engine loading state with progress bar
- Threat classification panel:
  - `DEEPFAKE` → `THREAT LEVEL: CRITICAL`
  - `SUSPICIOUS` → `THREAT LEVEL: ELEVATED`
  - `AUTHENTIC` → `THREAT LEVEL: CLEAR`
- Forensic report fields:
  - `ASSET ID`
  - `SCAN TIMESTAMP`
  - `DETECTION ENGINE`
  - `THREAT VECTOR`
  - `IOC FLAGS`
  - `CONFIDENCE`
- Cybersecurity-context anomaly indicators:
  - `BIOMETRIC INTEGRITY`
  - `PIXEL ENTROPY`
  - `PHOTOMETRIC CONSISTENCY`
  - `GAN SIGNATURE SCORE`
  - `SYNTHESIS FINGERPRINT`
- `EXPORT REPORT` plaintext incident report download
- `COPY IOC` clipboard action for flags array

## Usage

Drop `deepfake-detector.jsx` into a React project and render the default export.

```jsx
import DeepfakeDetector from "./deepfake-detector.jsx";

export default function App() {
  return <DeepfakeDetector />;
}
```

The first load downloads the Transformers.js runtime and model files. The scan itself runs locally in the browser.

## Result Schema

The UI still preserves the original core result schema while adding forensic metadata:

```json
{
  "verdict": "AUTHENTIC | DEEPFAKE | SUSPICIOUS",
  "confidence": 0,
  "summary": "string",
  "indicators": {
    "facial_geometry": 0,
    "texture_coherence": 0,
    "lighting_consistency": 0,
    "artifact_score": 0,
    "temporal_signature": 0
  },
  "flags": ["string"]
}
```

## Limitations

- Single-frame analysis cannot prove authenticity or manipulation by itself.
- The fallback model is a generic image classifier, so its risk score should be treated as a degraded-mode triage signal.
- Deepfake detectors can produce false positives and false negatives.
- Adversarial examples, compression, screenshots, crops, and distribution shift can reduce accuracy.
- Analyst review, provenance checks, reverse image search, account-history correlation, and campaign context are still required for high-impact decisions.

## Disclaimer

SYNTHSEC is for educational, research, and defensive security workflows. It should not be used as the sole basis for legal, employment, financial, or identity-verification decisions.
