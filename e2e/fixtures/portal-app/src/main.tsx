import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PortalWidget } from "./portalWidget.js";

/** The app's own wrapper around a third-party component that portals. */
const App = () => (
  <main>
    <section id="portal-slot">
      <PortalWidget />
    </section>
  </main>
);

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
