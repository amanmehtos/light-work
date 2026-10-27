import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Diurnal UI: the stylesheet, then the runtime, which starts tracking the sky
// as soon as it is imported. It has to come before the app's own stylesheet so
// that app rules win where they overlap.
import "diurnal-ui/diurnal.css";
import "diurnal-ui/diurnal.mjs";

import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
