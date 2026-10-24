import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@light/diurnal/diurnal.css";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
