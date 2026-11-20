import { useEffect, useRef } from "react";

const fullTurn = Math.PI * 2;

function drawOrbit(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  phase: number,
  light: boolean,
) {
  const x = width / 2;
  const y = height * 0.63;
  const horizontal = width * 0.482;
  const vertical = height * 0.335;
  const ink = light ? "52,66,63" : "174,191,169";
  const gold = light ? "136,86,31" : "239,169,98";
  const olive = light ? "99,108,51" : "205,214,133";
  const tint = (color: string, opacity: number) => `rgba(${color},${opacity})`;

  context.clearRect(0, 0, width, height);
  context.lineWidth = 0.8;

  function ellipse(
    scale: number,
    heightOffset: number,
    start = 0,
    end = fullTurn,
  ) {
    context.beginPath();
    context.ellipse(
      x,
      y - vertical * heightOffset,
      horizontal * scale,
      vertical * scale,
      0,
      start,
      end,
    );
  }

  // Light on the near side defines the shape without outlining the back at full strength.
  const edge = context.createLinearGradient(0, y - vertical, 0, y + vertical);
  edge.addColorStop(0, tint(ink, 0.035));
  edge.addColorStop(0.52, tint(ink, light ? 0.21 : 0.27));
  edge.addColorStop(1, tint(ink, light ? 0.45 : 0.5));
  context.strokeStyle = edge;
  for (const radius of [1, 0.923, 0.895, 0.72, 0.5, 0.25, 0.055]) {
    ellipse(radius, 0);
    context.stroke();
  }

  context.lineWidth = 0.65;
  context.strokeStyle = tint(ink, 0.15);
  for (let segment = 0; segment < 22; segment++) {
    const angle = (segment / 22) * fullTurn + phase * 0.25;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(
      x + Math.cos(angle) * horizontal * 0.905,
      y + Math.sin(angle) * vertical * 0.905,
    );
    context.stroke();
  }

  // Curves inside the disc move together, so they read as one surface.
  for (let band = 0; band < 9; band++) {
    const radius = 0.28 + band * 0.07;
    context.strokeStyle = tint(
      band % 3 === 0 ? olive : ink,
      band > 6 ? 0.31 : 0.19,
    );
    context.lineWidth = band % 3 === 0 ? 1.25 : 0.85;
    context.beginPath();
    for (let step = 0; step <= 180; step++) {
      const angle = (step / 180) * fullTurn;
      const offset =
        0.024 * Math.sin(angle * 7 + band * 0.55) +
        0.038 * Math.sin(angle * 3 - band * 0.7) +
        0.013 * Math.cos(angle * 17 + band);
      const pointX =
        x + Math.cos(angle + phase) * horizontal * (radius + offset);
      const pointY = y + Math.sin(angle + phase) * vertical * (radius + offset);
      if (step === 0) context.moveTo(pointX, pointY);
      else context.lineTo(pointX, pointY);
    }
    context.stroke();
  }

  for (let index = 0; index < 84; index++) {
    const angle = index * 2.399 + phase;
    const radius = 0.23 + ((index * 37) % 60) / 100;
    const pointX = x + Math.cos(angle) * horizontal * radius;
    const pointY = y + Math.sin(angle) * vertical * radius;
    const bright = index % 13 === 0;
    const size = bright ? 2.2 + (index % 3) : 0.7 + (index % 4) * 0.26;
    if (bright) {
      const glow = context.createRadialGradient(
        pointX,
        pointY,
        0,
        pointX,
        pointY,
        size * 5,
      );
      glow.addColorStop(0, tint(olive, 0.22));
      glow.addColorStop(1, tint(olive, 0));
      context.fillStyle = glow;
      context.fillRect(
        pointX - size * 5,
        pointY - size * 5,
        size * 10,
        size * 10,
      );
    }
    context.beginPath();
    context.ellipse(pointX, pointY, size * 1.45, size * 0.72, 0, 0, fullTurn);
    context.fillStyle = tint(olive, bright ? 0.68 : 0.16 + (index % 5) * 0.07);
    context.fill();
  }

  const centerGlow = context.createRadialGradient(x, y, 0, x, y, 28);
  centerGlow.addColorStop(0, tint(olive, 0.42));
  centerGlow.addColorStop(1, tint(olive, 0));
  context.fillStyle = centerGlow;
  context.fillRect(x - 28, y - 28, 56, 56);

  // The short translucent panels descend from the raised rails.
  const railRadius = 0.735;
  const upper = y - vertical * 0.7;
  const lower = y - vertical * 0.26;
  const glass = context.createLinearGradient(0, upper, 0, y + vertical);
  glass.addColorStop(0.27, tint(ink, 0.018));
  glass.addColorStop(0.7, tint(ink, light ? 0.09 : 0.13));
  glass.addColorStop(1, tint(ink, 0.035));
  context.fillStyle = glass;
  context.strokeStyle = tint(ink, 0.115);
  context.lineWidth = 0.7;
  for (const [start, end] of [
    [0.16, 0.44],
    [1.1, 1.49],
    [2.23, 2.64],
    [2.81, 3.02],
  ]) {
    context.beginPath();
    context.ellipse(
      x,
      upper,
      horizontal * railRadius,
      vertical * railRadius,
      0,
      start,
      end,
    );
    context.lineTo(
      x + Math.cos(end) * horizontal * railRadius,
      lower + Math.sin(end) * vertical * railRadius,
    );
    context.ellipse(
      x,
      lower,
      horizontal * railRadius,
      vertical * railRadius,
      0,
      end,
      start,
      true,
    );
    context.closePath();
    context.fill();
    context.stroke();
  }

  for (const [index, heightOffset] of [0.26, 0.7].entries()) {
    const radius = index ? 0.735 : 0.765;
    context.lineWidth = 1;
    context.strokeStyle = tint(gold, 0.12);
    ellipse(radius, heightOffset, Math.PI, fullTurn);
    context.stroke();
    const rail = context.createLinearGradient(
      x - horizontal,
      0,
      x + horizontal,
      0,
    );
    rail.addColorStop(0, tint(gold, 0.12));
    rail.addColorStop(0.45, tint(gold, light ? 0.64 : 0.55));
    rail.addColorStop(1, tint(gold, 0.12));
    context.strokeStyle = rail;
    ellipse(radius, heightOffset, 0, Math.PI);
    context.stroke();

    const travel = fullTurn + phase * 2.6 + index * 1.8;
    context.strokeStyle = tint(gold, 0.86);
    context.lineWidth = 1.8;
    ellipse(radius, heightOffset, travel, travel + 0.048);
    context.stroke();
  }
}

export function OrbitScene({ paused }: { paused: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const phase = useRef(0);

  useEffect(() => {
    const node = canvas.current;
    const context = node?.getContext("2d");
    if (!node || !context) return;
    const root = document.documentElement;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let frame = 0;
    let previous: number | undefined;

    function paint() {
      if (!context || !width || !height) return;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      drawOrbit(
        context,
        width,
        height,
        phase.current,
        root.dataset.theme === "light",
      );
    }

    function animate(at: number) {
      previous ??= at;
      const elapsed = at - previous;
      if (elapsed >= 45) {
        phase.current += Math.min(elapsed, 100) * 0.000095;
        previous = at;
        paint();
      }
      frame = requestAnimationFrame(animate);
    }

    function updateMotion() {
      cancelAnimationFrame(frame);
      previous = undefined;
      if (!paused && !preference.matches)
        frame = requestAnimationFrame(animate);
      paint();
    }

    const resize = new ResizeObserver(([{ contentRect }]) => {
      width = contentRect.width;
      height = contentRect.height;
      pixelRatio = Math.min(window.devicePixelRatio, 1.6);
      node.width = Math.round(width * pixelRatio);
      node.height = Math.round(height * pixelRatio);
      paint();
    });
    const theme = new MutationObserver(paint);
    resize.observe(node);
    theme.observe(root, { attributeFilter: ["data-theme"] });
    preference.addEventListener("change", updateMotion);
    updateMotion();

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      theme.disconnect();
      preference.removeEventListener("change", updateMotion);
    };
  }, [paused]);

  return <canvas ref={canvas} className="orbit-plane" />;
}
