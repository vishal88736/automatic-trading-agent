import { useState } from "react";
import { Pause, Play } from "lucide-react";

export function HomeOrbit() {
  const [paused, setPaused] = useState(false);
  const label = paused ? "Play orbit animation" : "Pause orbit animation";

  return (
    <>
      <div className="home-orbit" data-paused={paused} aria-hidden="true">
        <div className="orbit-plane">
          <div className="orbit-rotor">
            <span className="orbit-track orbit-track-outer" />
            <span className="orbit-track orbit-track-middle" />
            <span className="orbit-track orbit-track-inner" />
            <span className="orbit-crosshair" />
          </div>
        </div>
        <div className="hero-art">
          <img src="/art/krono-orbit.webp" alt="" width="720" height="720" />
        </div>
      </div>
      <button
        type="button"
        className="orbit-toggle"
        aria-label={label}
        title={label}
        onClick={() => setPaused(!paused)}
      >
        {paused ? (
          <Play size={15} aria-hidden />
        ) : (
          <Pause size={15} aria-hidden />
        )}
      </button>
    </>
  );
}
