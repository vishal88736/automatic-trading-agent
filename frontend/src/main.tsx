import React from "react";
import ReactDOM from "react-dom/client";
import { Workspace } from "./platform/Workspace";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles/base.css";
import "./styles/theme.css";
import "./styles/palette.css";
import "./styles/shell.css";
import "./platform/product-design.css";
import "./platform/workspace-design.css";
import "./platform/dashboard.css";
import "./styles/app.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Workspace />
  </React.StrictMode>,
);
