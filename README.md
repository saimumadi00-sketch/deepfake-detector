# DeepfakeScan 🔍

Local, browser-side forensic image analyzer for deepfake screening.

## Features
- Upload any face image (JPG, PNG, WEBP)
- Animated terminal-style scan sequence
- Verdict: **AUTHENTIC / DEEPFAKE / SUSPICIOUS**
- Anomaly meters: facial geometry, texture coherence, lighting, GAN artifacts, temporal signature
- Confidence score + specific anomaly flags
- No paid API and no API key required

## Stack
- React (JSX)
- Transformers.js via CDN (`@xenova/transformers@2.17.2`)
- Local image-classification pipeline using `prithivMLmods/Deepfake-Detection-Exp-02-22-ONNX`
- CSS animations (no dependencies)

## Usage
Drop `deepfake-detector.jsx` into any React project and render the default export.

```jsx
import DeepfakeDetector from "./deepfake-detector.jsx";

export default function App() {
  return <DeepfakeDetector />;
}
```

The first scan downloads the Transformers.js runtime and ONNX model weights in the browser. Later scans reuse the cached classifier when the browser cache is available.

## Model Credit

This project uses `prithivMLmods/Deepfake-Detection-Exp-02-22-ONNX`, an Apache-2.0 Hugging Face image-classification model with `Deepfake` and `Real` labels. The model runs locally through Transformers.js/ONNX Runtime Web.

## Notes

- Uploaded images are passed to the local browser model through an object URL.
- The app does not call any paid inference API.
- The anomaly meters are derived from the classifier score so the UI schema stays unchanged.
- Deepfake detection can produce false positives and false negatives. Use this for educational and research workflows, not as a sole forensic authority.

> **For educational and research purposes only.**
