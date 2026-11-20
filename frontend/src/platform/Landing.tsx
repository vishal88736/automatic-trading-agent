import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { createLandingScene } from "./LandingScene";
import "@fontsource/instrument-serif/latin-400.css";

type Scene = ReturnType<typeof createLandingScene>;

export function Landing() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<Scene | null>(null);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    function update() {
      setReduced(preference.matches);
      if (preference.matches) scene.current?.setPaused(true);
    }
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let active = true;
    void import("./LandingScene")
      .then(({ createLandingScene: mount }) => {
        if (!active || !canvas.current) return;
        scene.current = mount(canvas.current, setReady);
      })
      .catch(() => {
        if (active) setReady(false);
      });
    return () => {
      active = false;
      scene.current?.destroy();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    if (ready) scene.current?.setPaused(paused || reduced);
  }, [paused, ready, reduced]);

  return (
    <section className="krono-landing" aria-labelledby="landing-title">
      <div className="landing-scene" aria-hidden="true">
        <canvas ref={canvas} data-ready={ready} />
      </div>
      <div className="landing-copy">
        <div>
          <p className="landing-eyebrow">Autonomous crypto research</p>
          <h1 id="landing-title">
            Trade with <span>Krono.</span>
          </h1>
        </div>
        <div className="landing-description">
          <p>
            Build and backtest strategies. Run autonomous agents with virtual
            funds.
          </p>
          {ready && !reduced && (
            <button
              className="landing-motion"
              type="button"
              aria-label={
                paused ? "Play landing animation" : "Pause landing animation"
              }
              title={paused ? "Play animation" : "Pause animation"}
              onClick={() => setPaused((value) => !value)}
            >
              {paused ? (
                <Play size={15} aria-hidden />
              ) : (
                <Pause size={15} aria-hidden />
              )}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
