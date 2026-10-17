import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import DeepfakeDetector from "./DeepfakeDetector.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <DeepfakeDetector />
  </StrictMode>,
);
