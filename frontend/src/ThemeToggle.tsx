import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type Theme = "light" | "dark";

export function ThemeToggle() {
  const [active, setActive] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = active;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", getComputedStyle(root).backgroundColor);
  }, [active]);

  const next = active === "dark" ? "light" : "dark";
  const label = `Switch to ${next} theme`;
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={label}
      title={label}
      onClick={() => {
        setActive(next);
        try {
          localStorage.setItem("krono-theme", next);
        } catch {
          // The selected theme still applies when browser storage is unavailable.
        }
      }}
    >
      {active === "dark" ? (
        <Sun size={15} aria-hidden />
      ) : (
        <Moon size={15} aria-hidden />
      )}
      <span aria-hidden>{active === "dark" ? "Dark" : "Light"}</span>
    </button>
  );
}
