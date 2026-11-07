import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { startBeacon } from "@stride/shared";
import { App } from "../../../src/components/App";
import "../../../src/components/styles.css";

startBeacon();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
