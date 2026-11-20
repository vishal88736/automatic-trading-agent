import * as THREE from "three";

const trackRadius = 2.18;
const trackDepth = 2.28;
const trackThickness = 0.09;
const coinRadius = 0.5;
const coinHalfWidth = 0.055;
const leftEnd = -1.2;
const rightEnd = 1.43;
const turn = 2 * Math.PI;

function trackPoint(angle: number, across: number, offset = 0) {
  const radius = trackRadius + offset;
  return new THREE.Vector3(
    radius * Math.sin(angle),
    trackRadius - radius * Math.cos(angle),
    across,
  );
}

function surface(offset: number, inside: boolean) {
  const steps = 144;
  const width = 18;
  const vertices = [];
  const uv = [];
  const faces = [];
  for (let row = 0; row <= steps; row++) {
    const angle = THREE.MathUtils.lerp(leftEnd, rightEnd, row / steps);
    for (let column = 0; column <= width; column++) {
      const across = trackDepth * (column / width - 0.5);
      vertices.push(...trackPoint(angle, across, offset));
      uv.push(row / steps, column / width);
      if (row === steps || column === width) continue;
      const a = row * (width + 1) + column;
      const b = a + 1;
      const c = a + width + 1;
      const d = c + 1;
      if (inside) faces.push(a, b, c, b, d, c);
      else faces.push(a, c, b, b, c, d);
    }
  }
  const mesh = new THREE.BufferGeometry();
  mesh.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  mesh.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  mesh.setIndex(faces);
  mesh.computeVertexNormals();
  return mesh;
}

function brushedSteel() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const context = canvas.getContext("2d")!;
  const pixels = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const groove = Math.cos((y * turn) / 3.6);
      const bead = Math.sin(x * 1.49 + (y % 2)) * (groove + 1);
      const height = 127 + groove * 24 + bead * 12;
      pixels.data.set(
        [height, height, height, 255],
        (y * canvas.width + x) * 4,
      );
    }
  }
  context.putImageData(pixels, 0, 0);
  return new THREE.CanvasTexture(canvas);
}

function rail(
  points: THREE.Vector3[],
  radius: number,
  material: THREE.Material,
) {
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.Mesh(
    new THREE.TubeGeometry(curve, 112, radius, 10),
    material,
  );
}

function makeTrack() {
  const texture = brushedSteel();
  const strip = new THREE.MeshPhysicalMaterial({
    color: 0xd4d8df,
    metalness: 0.94,
    roughness: 0.29,
    roughnessMap: texture,
    clearcoat: 0.3,
    clearcoatRoughness: 0.16,
    bumpMap: texture,
    bumpScale: 0.031,
    side: THREE.DoubleSide,
  });
  const outside = new THREE.MeshStandardMaterial({
    color: 0xa5adb9,
    metalness: 0.91,
    roughness: 0.28,
    bumpMap: texture,
    bumpScale: 0.017,
    side: THREE.DoubleSide,
  });
  const rim = new THREE.MeshStandardMaterial({
    color: 0xe9e7e6,
    metalness: 0.96,
    roughness: 0.11,
  });
  const track = new THREE.Group();
  track.add(new THREE.Mesh(surface(0, true), strip));
  track.add(new THREE.Mesh(surface(trackThickness, false), outside));

  for (const across of [-trackDepth / 2, trackDepth / 2]) {
    track.add(
      rail(
        Array.from({ length: 55 }, (_, index) =>
          trackPoint(
            THREE.MathUtils.lerp(leftEnd, rightEnd, index / 54),
            across,
            trackThickness / 2,
          ),
        ),
        trackThickness / 2 + 0.012,
        rim,
      ),
    );
  }

  for (const end of [leftEnd, rightEnd]) {
    const roll = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.069, trackDepth, 7, 20),
      rim,
    );
    roll.rotation.x = Math.PI / 2;
    roll.position.copy(trackPoint(end, 0, trackThickness / 2));
    track.add(roll);
  }
  return track;
}

function makeCoin() {
  const metal = new THREE.MeshPhysicalMaterial({
    color: 0xf4c56a,
    metalness: 0.81,
    roughness: 0.23,
    emissive: 0x985413,
    emissiveIntensity: 0.19,
    clearcoat: 0.36,
  });
  const relief = new THREE.MeshStandardMaterial({
    color: 0xffdd91,
    metalness: 0.83,
    roughness: 0.18,
    emissive: 0x8d622b,
    emissiveIntensity: 0.12,
  });
  const profile = [
    [0, -coinHalfWidth],
    [coinRadius - 0.027, -coinHalfWidth],
    [coinRadius - 0.007, -0.043],
    [coinRadius, -0.028],
    [coinRadius, 0.028],
    [coinRadius - 0.007, 0.043],
    [coinRadius - 0.027, coinHalfWidth],
    [0, coinHalfWidth],
  ].map(([radius, depth]) => new THREE.Vector2(radius, depth));
  const body = new THREE.LatheGeometry(profile, 96);
  body.rotateX(Math.PI / 2);
  const coin = new THREE.Group();
  coin.add(new THREE.Mesh(body, metal));

  const detail = new THREE.Group();
  for (const [radius, thickness] of [
    [coinRadius - 0.026, 0.013],
    [coinRadius - 0.071, 0.006],
  ]) {
    detail.add(
      new THREE.Mesh(
        new THREE.TorusGeometry(radius, thickness, 10, 96),
        relief,
      ),
    );
  }
  const mark = new THREE.Group();
  for (const [start, end] of [
    [
      [-0.098, -0.185],
      [-0.098, 0.177],
    ],
    [
      [-0.083, -0.02],
      [0.093, 0.139],
    ],
    [
      [-0.055, -0.004],
      [0.103, -0.176],
    ],
  ]) {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const stroke = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.027, Math.hypot(dx, dy), 6, 12),
      relief,
    );
    stroke.position.set((start[0] + end[0]) / 2, (start[1] + end[1]) / 2, 0);
    stroke.rotation.z = Math.atan2(dy, dx) - Math.PI / 2;
    mark.add(stroke);
  }
  const stamp = new THREE.Mesh(new THREE.SphereGeometry(0.028, 18, 12), relief);
  stamp.position.set(0.15, 0.195, 0.003);
  mark.add(stamp);
  mark.scale.setScalar(1.22);
  detail.add(mark);
  detail.position.z = coinHalfWidth + 0.001;
  const back = detail.clone();
  back.rotation.y = Math.PI;
  back.position.z = -detail.position.z;
  coin.add(detail, back);
  return coin;
}

function softboxPattern() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 192;
  const context = canvas.getContext("2d")!;
  const pixels = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const u = (x / canvas.width) * 2 - 1;
      const v = (y / canvas.height) * 2 - 1;
      const diagonal = u * 0.62 + v * 0.78;
      const first = Math.exp(-Math.pow((diagonal + 0.26) / 0.07, 2));
      const second = Math.exp(-Math.pow((diagonal - 0.19) / 0.135, 2));
      const gain = Math.min(1, 0.19 + first * 0.84 + second * 0.61);
      const level = gain * 255;
      pixels.data.set([level, level, level, 255], (y * canvas.width + x) * 4);
    }
  }
  context.putImageData(pixels, 0, 0);
  return new THREE.CanvasTexture(canvas);
}

function groundReflections() {
  // Keep the long softbox streaks and contact shadows anchored to the floor.
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      lightStage: { value: false },
      coinCenter: { value: new THREE.Vector2() },
    },
    vertexShader: `
      varying vec2 ground;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        ground = world.xz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform bool lightStage;
      uniform vec2 coinCenter;
      varying vec2 ground;

      float gaussian(float distance) { return exp(-distance * distance); }

      void main() {
        vec2 p = ground;
        float taper = gaussian((p.x - 0.15) * 0.2) * gaussian(p.y * 0.38);
        float diagonal = p.y - 0.34 * p.x;
        float streakA = gaussian((diagonal - 1.24) * 2.7);
        float streakB = gaussian((diagonal + 1.08) * 1.75);
        float streakC = gaussian((diagonal + 2.72) * 1.5);
        float glare = (streakA * 0.6 + streakB * 0.52 + streakC * 0.4) * taper;
        float contact = gaussian((p.x - 0.28) * 2.15) * gaussian(p.y * 1.5) * 0.73;
        float longShadow = gaussian((p.y + 0.38 * p.x - 0.06) * 2.7)
          * gaussian((p.x - 1.24) * 0.42) * smoothstep(-0.3, 0.6, p.x) * 0.43;
        vec2 offset = p - coinCenter - vec2(0.44, -0.29);
        float coinShadow = gaussian(offset.x * 2.8) * gaussian(offset.y * 3.7) * 0.28;
        float shade = max(contact, max(longShadow, coinShadow));
        vec3 beam = lightStage ? vec3(0.87, 0.86, 0.82) : vec3(0.67, 0.57, 0.47);
        vec3 shadow = lightStage ? vec3(0.16, 0.14, 0.17) : vec3(0.015, 0.015, 0.021);
        float opacity = max(glare, shade);
        vec3 color = mix(beam, shadow, shade / max(0.01, glare + shade));
        gl_FragColor = vec4(color, opacity * (lightStage ? 0.63 : 0.74));
        #include <colorspace_fragment>
      }
    `,
  });
}

function destroyScene(scene: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  scene.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    geometries.add(child.geometry);
    for (const material of Array.isArray(child.material)
      ? child.material
      : [child.material]) {
      materials.add(material);
      if ("bumpMap" in material && material.bumpMap instanceof THREE.Texture)
        textures.add(material.bumpMap);
      if (
        "roughnessMap" in material &&
        material.roughnessMap instanceof THREE.Texture
      )
        textures.add(material.roughnessMap);
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

function reflectionStudio(renderer: THREE.WebGLRenderer) {
  const studio = new THREE.Scene();
  studio.background = new THREE.Color(0x151620);
  for (const card of [
    { position: [-3.2, 4.6, 3.1], size: [6.5, 1.35], color: [7.6, 7.05, 6.35] },
    { position: [2.6, 3.9, 1.4], size: [3.9, 0.72], color: [7.9, 7.5, 7.1] },
    { position: [-2, 1.1, 5.1], size: [4.1, 0.78], color: [3.7, 3.55, 3.4] },
    { position: [-3.1, 2.1, 4.5], size: [3.8, 2.33], color: [4.2, 3.65, 2.8] },
    { position: [4.9, 1.7, -2.4], size: [2.3, 4.8], color: [2.2, 2.45, 3.5] },
    { position: [-2.9, 2.7, -4.4], size: [5.1, 1.2], color: [2.6, 2.2, 1.66] },
    { position: [0.3, 0.85, 5.9], size: [2.9, 1.2], color: [2.8, 2.35, 1.67] },
    { position: [0, 5.5, -1], size: [5.2, 0.6], color: [4.2, 4.35, 5.1] },
  ]) {
    const [width, height] = card.size;
    const [x, y, z] = card.position;
    const [red, green, blue] = card.color;
    const cardMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color().setRGB(red, green, blue),
        toneMapped: false,
      }),
    );
    cardMesh.position.set(x, y, z);
    cardMesh.lookAt(0, 0.85, 0);
    studio.add(cardMesh);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const reflection = pmrem.fromScene(studio, 0.012, 0.1, 25);
  pmrem.dispose();
  destroyScene(studio);
  return reflection;
}

export function createLandingScene(
  canvas: HTMLCanvasElement,
  onReadyChange: (ready: boolean) => void,
) {
  const context = canvas.getContext("webgl2", {
    antialias: true,
    alpha: false,
    powerPreference: "low-power",
  });
  if (!context) return null;
  const renderer = new THREE.WebGLRenderer({ canvas, context });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.04;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 70);
  const reflection = reflectionStudio(renderer);
  scene.environment = reflection.texture;
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x26272d,
    metalness: 0.08,
    roughness: 0.66,
  });
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    floorMaterial,
  );
  floor.position.y = -(trackThickness + 0.006);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const groundMaterial = groundReflections();
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    groundMaterial,
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = floor.position.y + 0.004;
  scene.add(ground);

  scene.add(new THREE.HemisphereLight(0xe3e8fc, 0x373038, 0.8));
  const key = new THREE.SpotLight(0xffe2bd, 260, 23, 0.8, 0.68, 2);
  const pattern = softboxPattern();
  key.map = pattern;
  key.position.set(-4.75, 3.4, 3.2);
  key.target.position.set(0.4, 0, -0.5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.00013;
  key.shadow.normalBias = 0.008;
  key.shadow.radius = 4;
  scene.add(key, key.target);
  const fill = new THREE.SpotLight(0xd5dbff, 43, 23, 0.79, 0.76, 2);
  fill.position.set(4.4, 3.8, -3.3);
  fill.target.position.set(0, 0, 1.2);
  scene.add(fill, fill.target);
  const glint = new THREE.PointLight(0xffd494, 0.72, 1.45, 2);
  scene.add(glint);

  const sculpture = new THREE.Group();
  const track = makeTrack();
  const coin = makeCoin();
  sculpture.add(track, coin);
  scene.add(sculpture);
  sculpture.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });

  const background = new THREE.Color();
  scene.background = background;
  const fog = new THREE.FogExp2(background, 0.081);
  scene.fog = fog;
  let width = 0;
  let height = 0;
  let frame = 0;
  let previous = 0;
  let elapsed = 0;
  let paused = true;
  let lost = false;
  let ready = false;

  function render() {
    if (!width || !height || lost) return;
    const stageTime = (elapsed / 5.2) * turn;
    const cycle = THREE.MathUtils.euclideanModulo(stageTime - 0.54, turn);
    const swing = Math.sin(cycle);
    const angle = swing * (swing < 0 ? 1.13 : 1.34);
    const lift = THREE.MathUtils.smoothstep(Math.abs(swing), 0.76, 1);
    const flip =
      turn *
      THREE.MathUtils.smoothstep(cycle % Math.PI, 0.93, Math.PI - 0.93) *
      Math.sign(swing);
    const turnRadius = trackRadius - coinRadius;
    coin.position.set(
      turnRadius * Math.sin(angle) + swing * lift * 0.34,
      trackRadius - turnRadius * Math.cos(angle) + lift * 0.49 + 0.025,
      0.37 + Math.sin(stageTime + 1.1) * 0.12,
    );
    coin.rotation.set(
      0.02 + flip,
      0.12 + lift * Math.cos(stageTime * 2 - 0.8) * 0.61,
      ((Math.sin(-0.54) * 1.13 - angle) * turnRadius) / coinRadius - 0.08,
    );
    sculpture.rotation.y = 0.08 + Math.sin(stageTime - 0.3) * 0.11;
    glint.position.copy(coin.position);
    glint.position.z += 0.14;
    glint.position.y -= 0.27;
    groundMaterial.uniforms.coinCenter.value.set(
      coin.position.x + sculpture.position.x,
      coin.position.z,
    );

    renderer.render(scene, camera);
    if (!ready) {
      ready = true;
      onReadyChange(true);
    }
  }

  const resize = new ResizeObserver(([entry]) => {
    width = entry.contentRect.width;
    height = entry.contentRect.height;
    if (!width || !height) return;
    const aspect = width / height;
    const scale = Math.max(1, 1.47 / aspect);
    const wide = THREE.MathUtils.smoothstep(aspect, 0.74, 1.45);
    const short = 1 - THREE.MathUtils.smoothstep(height, 420, 600);
    camera.position.set(-3 * scale, 2.4 * scale, 6.5 * scale);
    camera.lookAt(0.02, THREE.MathUtils.lerp(0.57, 1.14, wide), 0.03);
    camera.zoom = THREE.MathUtils.lerp(1.26, 1.24, wide) - 0.1 * wide * short;
    const verticalOffset = THREE.MathUtils.lerp(0.046, -0.007, wide);
    camera.setViewOffset(
      width,
      height,
      0,
      height * verticalOffset,
      width,
      height,
    );
    sculpture.position.x =
      0.37 * THREE.MathUtils.smoothstep(aspect, 1.26, 1.64);
    fog.density = 0.081 / scale;
    renderer.setPixelRatio(
      Math.min(devicePixelRatio, 1.6, Math.sqrt(1800000 / (width * height))),
    );
    renderer.setSize(width, height, false);
    render();
  });
  resize.observe(canvas);

  function tick(now: number) {
    if (!previous || now - previous >= 30) {
      if (previous) elapsed += Math.min(now - previous, 120) / 1000;
      previous = now;
      render();
    }
    frame = requestAnimationFrame(tick);
  }

  function setPaused(value: boolean) {
    cancelAnimationFrame(frame);
    paused = value;
    previous = 0;
    if (!paused && !lost) frame = requestAnimationFrame(tick);
    else render();
  }

  function followTheme() {
    const isLight = document.documentElement.dataset.theme === "light";
    background.set(isLight ? 0xe8eaed : 0x23262b);
    fog.color.copy(background);
    groundMaterial.uniforms.lightStage.value = isLight;
    floorMaterial.color.set(isLight ? 0xb1b8be : 0x383c45);
    render();
  }
  const theme = new MutationObserver(followTheme);
  theme.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  followTheme();

  function contextLost(event: Event) {
    event.preventDefault();
    lost = true;
    cancelAnimationFrame(frame);
    onReadyChange(false);
  }

  canvas.addEventListener("webglcontextlost", contextLost);
  return {
    setPaused,
    destroy() {
      cancelAnimationFrame(frame);
      resize.disconnect();
      theme.disconnect();
      canvas.removeEventListener("webglcontextlost", contextLost);
      destroyScene(scene);
      for (const light of [key, fill, glint]) light.dispose();
      reflection.dispose();
      pattern.dispose();
      renderer.dispose();
    },
  };
}
