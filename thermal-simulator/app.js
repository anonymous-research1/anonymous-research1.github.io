import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

window.__thermalAppStarted = true;
window.clearTimeout(window.__thermalLoadTimer);
document.querySelector("#loading-text").textContent = "Initializing WebGL";

const META_URL = "./assets/squarecup/meta.json";
const canvas = document.querySelector("#scene");
const viewport = document.querySelector("#viewport");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.001, 10000);
camera.up.set(-0.1049, 0.9878, -0.1148).normalize();
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

let metadata;
let positions;
let indptr;
let indices;
let data;
let temperatures;
let thermalPoints;
let pointMaterial;
let heatMarker;
let worker;
let playing = true;
let draggingHeat = false;
let heatTarget = new THREE.Vector3();
let heatRadius = 1;
let pointThreshold = 1;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

const palette = [
  [0.00, 10, 7, 35],
  [0.25, 87, 16, 110],
  [0.50, 187, 55, 84],
  [0.75, 249, 142, 9],
  [1.00, 252, 255, 164],
];

function inferno(value, out, offset) {
  const x = Math.max(0, Math.min(1, value));
  let upper = 1;
  while (upper < palette.length - 1 && x > palette[upper][0]) upper += 1;
  const a = palette[upper - 1];
  const b = palette[upper];
  const mix = (x - a[0]) / Math.max(b[0] - a[0], 1e-12);
  out[offset] = (a[1] + (b[1] - a[1]) * mix) / 255;
  out[offset + 1] = (a[2] + (b[2] - a[2]) * mix) / 255;
  out[offset + 2] = (a[3] + (b[3] - a[3]) * mix) / 255;
}

async function fetchTyped(url, Type, expectedLength) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load ${url}: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const array = new Type(buffer);
  if (array.length !== expectedLength) {
    throw new Error(`${url} has ${array.length} values; expected ${expectedLength}`);
  }
  return array;
}

function assetUrl(record, metaResponseUrl) {
  return new URL(record.path, metaResponseUrl).href;
}

function configureRange(id, min, max, value) {
  const input = document.querySelector(id);
  input.min = String(min);
  input.max = String(max);
  input.step = String(Math.max((max - min) / 1000, 1e-9));
  input.value = String(value);
}

function updateTargetUi() {
  const values = [heatTarget.x, heatTarget.y, heatTarget.z];
  ["x", "y", "z"].forEach((axis, index) => {
    document.querySelector(`#target-${axis}`).value = String(values[index]);
    document.querySelector(`#target-${axis}-number`).value = values[index].toFixed(3);
  });
}

function setHeatTarget(point, notify = true) {
  heatTarget.copy(point);
  heatMarker.position.copy(heatTarget);
  updateTargetUi();
  if (notify) worker.postMessage({ type: "heat-target", value: heatTarget.toArray() });
}

function pick(event, moveHeat) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(thermalPoints, false)[0];
  if (!hit) return false;
  const index = hit.index;
  const p = index * 3;
  const point = new THREE.Vector3(positions[p], positions[p + 1], positions[p + 2]);
  if (moveHeat) setHeatTarget(point);
  const temp = temperatures ? temperatures[index] : metadata.physics.initial_temp_c;
  document.querySelector("#hover-readout").textContent =
    `Point ${index.toLocaleString()} · ${temp.toFixed(2)} °C · ` +
    `(${point.x.toPrecision(4)}, ${point.y.toPrecision(4)}, ${point.z.toPrecision(4)})`;
  return true;
}

function updateColors(values) {
  temperatures = values;
  const colors = thermalPoints.geometry.attributes.color.array;
  const lo = metadata.colorbar.tmin_c;
  const scale = 1 / Math.max(metadata.colorbar.tmax_c - lo, 1e-9);
  for (let i = 0; i < values.length; i += 1) inferno((values[i] - lo) * scale, colors, i * 3);
  thermalPoints.geometry.attributes.color.needsUpdate = true;
}

function resize() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
}

function render() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

function bindUi() {
  const power = document.querySelector("#power");
  const radius = document.querySelector("#radius");
  const pointSize = document.querySelector("#point-size");
  const heatEnabled = document.querySelector("#heat-enabled");
  const pause = document.querySelector("#pause");

  power.value = String(metadata.heat_gun.power_c_per_s);
  document.querySelector("#power-output").value = `${Number(power.value).toFixed(1)} °C/s`;
  heatEnabled.checked = metadata.heat_gun.enabled;
  const diagonal = metadata.bounds.diagonal;
  radius.min = String(0.005 * diagonal);
  radius.max = String(0.35 * diagonal);
  radius.step = String(0.001 * diagonal);
  radius.value = String(heatRadius);
  document.querySelector("#radius-output").value = heatRadius.toPrecision(4);

  const pad = 0.75;
  ["x", "y", "z"].forEach((axis, index) => {
    const lo = metadata.bounds.min[index];
    const hi = metadata.bounds.max[index];
    const rangeMin = lo - pad * (hi - lo);
    const rangeMax = hi + pad * (hi - lo);
    const step = Math.max((rangeMax - rangeMin) / 500, 1e-9);
    const slider = document.querySelector(`#target-${axis}`);
    const number = document.querySelector(`#target-${axis}-number`);
    configureRange(`#target-${axis}`, rangeMin, rangeMax, heatTarget.getComponent(index));
    number.min = String(rangeMin);
    number.max = String(rangeMax);
    number.step = String(step);
    number.value = heatTarget.getComponent(index).toFixed(3);

    const updateAxis = (rawValue) => {
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed)) return;
      const value = THREE.MathUtils.clamp(parsed, rangeMin, rangeMax);
      const next = heatTarget.clone();
      next.setComponent(index, value);
      setHeatTarget(next);
    };
    slider.addEventListener("input", (event) => updateAxis(event.target.value));
    number.addEventListener("input", (event) => updateAxis(event.target.value));
    number.addEventListener("change", (event) => updateAxis(event.target.value));
  });
  document.querySelectorAll(".axis-nudge").forEach((button) => {
    button.addEventListener("click", () => {
      const axis = button.dataset.axis;
      const index = { x: 0, y: 1, z: 2 }[axis];
      const number = document.querySelector(`#target-${axis}-number`);
      const step = Number(number.step);
      const next = heatTarget.clone();
      next.setComponent(
        index,
        THREE.MathUtils.clamp(
          next.getComponent(index) + Number(button.dataset.direction) * step,
          Number(number.min),
          Number(number.max),
        ),
      );
      setHeatTarget(next);
    });
  });
  updateTargetUi();

  power.addEventListener("input", () => {
    document.querySelector("#power-output").value = `${Number(power.value).toFixed(1)} °C/s`;
    worker.postMessage({ type: "power", value: Number(power.value) });
  });
  radius.addEventListener("input", () => {
    heatRadius = Number(radius.value);
    heatMarker.scale.setScalar(heatRadius);
    document.querySelector("#radius-output").value = heatRadius.toPrecision(4);
    worker.postMessage({ type: "radius", value: heatRadius });
  });
  pointSize.addEventListener("input", () => {
    pointMaterial.size = Number(pointSize.value);
    document.querySelector("#point-output").value = `${pointSize.value} px`;
  });
  heatEnabled.addEventListener("change", () => {
    heatMarker.visible = heatEnabled.checked;
    worker.postMessage({ type: "heat-enabled", value: heatEnabled.checked });
  });
  pause.addEventListener("click", () => {
    playing = !playing;
    pause.textContent = playing ? "Pause" : "Resume";
    document.querySelector("#status-badge").textContent = playing ? "Running" : "Paused";
    worker.postMessage({ type: "play", value: playing });
  });
  document.querySelector("#reset").addEventListener("click", () => worker.postMessage({ type: "reset" }));

  canvas.addEventListener("pointerdown", (event) => {
    if (!event.ctrlKey || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    draggingHeat = true;
    controls.enabled = false;
    canvas.setPointerCapture(event.pointerId);
    pick(event, true);
  }, { capture: true });
  canvas.addEventListener("pointermove", (event) => {
    if (draggingHeat) {
      event.preventDefault();
      event.stopPropagation();
      pick(event, true);
    } else {
      pick(event, false);
    }
  }, { capture: true });
  canvas.addEventListener("pointerup", (event) => {
    if (!draggingHeat) return;
    event.preventDefault();
    event.stopPropagation();
    draggingHeat = false;
    controls.enabled = true;
    canvas.releasePointerCapture(event.pointerId);
  }, { capture: true });
}

async function start() {
  if (window.location.protocol === "file:") {
    throw new Error(
      "Do not open index.html directly. Run python -m http.server 8000 --directory web_simulator, " +
      "then visit http://localhost:8000/",
    );
  }
  const metaResponse = await fetch(META_URL);
  if (!metaResponse.ok) throw new Error(`Unable to load model metadata: HTTP ${metaResponse.status}`);
  metadata = await metaResponse.json();
  document.querySelector("#loading-text").textContent = "Loading point cloud and sparse operator";
  const files = metadata.files;
  [positions, indptr, indices, data] = await Promise.all([
    fetchTyped(assetUrl(files.positions, metaResponse.url), Float32Array, files.positions.length),
    fetchTyped(assetUrl(files.indptr, metaResponse.url), Uint32Array, files.indptr.length),
    fetchTyped(assetUrl(files.indices, metaResponse.url), Uint32Array, files.indices.length),
    fetchTyped(assetUrl(files.data, metaResponse.url), Float32Array, files.data.length),
  ]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const colors = new Float32Array(metadata.point_count * 3);
  const initial = new Float32Array(metadata.point_count).fill(metadata.physics.initial_temp_c);
  for (let i = 0; i < metadata.point_count; i += 1) {
    inferno(
      (initial[i] - metadata.colorbar.tmin_c) /
        (metadata.colorbar.tmax_c - metadata.colorbar.tmin_c),
      colors,
      i * 3,
    );
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  pointMaterial = new THREE.PointsMaterial({ size: 3, vertexColors: true, sizeAttenuation: false });
  thermalPoints = new THREE.Points(geometry, pointMaterial);
  scene.add(thermalPoints);

  heatRadius = metadata.heat_gun.radius;
  heatTarget.fromArray(metadata.heat_gun.target_xyz);
  const markerGeometry = new THREE.SphereGeometry(1, 24, 16);
  const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xff6b26, transparent: true, opacity: 0.38, depthWrite: false });
  heatMarker = new THREE.Mesh(markerGeometry, markerMaterial);
  heatMarker.position.copy(heatTarget);
  heatMarker.scale.setScalar(heatRadius);
  scene.add(heatMarker);

  const center = new THREE.Vector3();
  center.copy(geometry.boundingSphere.center);
  const radius = geometry.boundingSphere.radius;
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(1.45, -1.65, -1.15).normalize().multiplyScalar(radius * 3.4));
  camera.near = Math.max(radius / 1000, 1e-6);
  camera.far = radius * 20;
  camera.updateProjectionMatrix();
  controls.update();
  pointThreshold = metadata.bounds.diagonal * 0.012;
  raycaster.params.Points.threshold = pointThreshold;

  document.querySelector("#object-name").textContent = `${metadata.name} · ${metadata.point_count.toLocaleString()} points`;
  document.querySelector("#legend-min").textContent = `${metadata.colorbar.tmin_c.toFixed(0)} °C`;
  document.querySelector("#legend-max").textContent = `${metadata.colorbar.tmax_c.toFixed(0)} °C`;
  document.querySelector("#physics-info").textContent =
    `α = ${metadata.physics.alpha_m2_per_s.toExponential(4)} m²/s\n` +
    `h = ${metadata.physics.h_per_s.toExponential(4)} 1/s\n` +
    `dt = ${metadata.simulation.dt_s} s · substeps = ${metadata.simulation.substeps}\n` +
    `L nnz = ${metadata.laplacian_nnz.toLocaleString()}`;

  document.querySelector("#loading-text").textContent = "Starting thermal simulation solver";
  worker = new Worker("./solver-worker.js");
  const workerReadyTimer = window.setTimeout(
    () => showError("The thermal solver timed out. Force-refresh the page and try again."),
    15000,
  );
  worker.onmessage = (event) => {
    const message = event.data;
    if (message.type === "ready") {
      window.clearTimeout(workerReadyTimer);
      document.querySelector("#loading").classList.add("done");
      document.querySelector("#status-badge").textContent = "Running";
    } else if (message.type === "frame") {
      updateColors(new Float32Array(message.temperatures));
      document.querySelector("#time-value").textContent = `${message.elapsed.toFixed(2)} s`;
      document.querySelector("#min-value").textContent = `${message.min.toFixed(2)} °C`;
      document.querySelector("#max-value").textContent = `${message.max.toFixed(2)} °C`;
      document.querySelector("#mean-value").textContent = `${message.mean.toFixed(2)} °C`;
    }
  };
  worker.onerror = (event) => showError(event.message || "The Web Worker failed");
  worker.postMessage(
    {
      type: "init",
      metadata,
      positions: positions.slice().buffer,
      indptr: indptr.buffer,
      indices: indices.buffer,
      data: data.buffer,
    },
    [indptr.buffer, indices.buffer, data.buffer],
  );
  temperatures = initial;
  bindUi();
  resize();
  render();
}

function showError(message) {
  const error = document.querySelector("#error");
  error.hidden = false;
  error.textContent = message;
  document.querySelector("#loading-text").textContent = "Load failed; see the error message on the right";
  console.error(message);
}

window.addEventListener("resize", resize);
start().catch((error) => showError(error instanceof Error ? error.message : String(error)));
