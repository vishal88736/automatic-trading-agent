import React from "react";
import ReactDOM from "react-dom/client";
import { legacyFixture } from "./platform/navigation";
import { Workspace } from "./platform/Workspace";
import "@fontsource-variable/inter/wght.css";
import "./styles.css";
import "./theme.css";
import "./palette.css";
import "./workspace.css";
import "./platform/product-design.css";
import "./platform/landing.css";

function mount(App: typeof Workspace) {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

if (import.meta.env.DEV && legacyFixture) {
  void import("./App").then(({ default: App }) => mount(App));
} else {
  mount(Workspace);
}
