import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const key = "krono-theme";
type Theme = "light" | "dark";
const system = window.matchMedia("(prefers-color-scheme: dark)");

function savedTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(key);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  const color = getComputedStyle(root).backgroundColor;
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.setAttribute("content", color);
  });
}

function systemTheme(): Theme {
  return system.matches ? "dark" : "light";
}

applyTheme(savedTheme() ?? systemTheme());

export function ThemeToggle() {
  const [preferred, setPreferred] = useState(savedTheme);
  const [inferred, setInferred] = useState(systemTheme);
  const active = preferred ?? inferred;

  useEffect(() => {
    const change = () => setInferred(systemTheme());
    system.addEventListener("change", change);
    return () => system.removeEventListener("change", change);
  }, []);

  useEffect(() => applyTheme(active), [active]);

  const next = active === "dark" ? "light" : "dark";
  const label = `Switch to ${next} theme`;
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={label}
      title={label}
      onClick={() => {
        setPreferred(next);
        try {
          localStorage.setItem(key, next);
        } catch {
          // The current session still uses the selected palette.
        }
      }}
    >
      {active === "dark" ? (
        <Sun size={17} aria-hidden />
      ) : (
        <Moon size={17} aria-hidden />
      )}
    </button>
  );
}
