let positions;
let indptr;
let indices;
let laplacianData;
let temperatures;
let nextTemperatures;
let heatWeights;
let metadata;
let elapsed = 0;
let playing = true;
let heatEnabled = true;
let heatPower = 0;
let heatRadius = 1;
let heatTarget = [0, 0, 0];
let timer = null;
let frame = 0;

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function recomputeHeatWeights() {
  if (!positions || !heatWeights) return;
  const radius2 = Math.max(heatRadius * heatRadius, 1e-18);
  let maximum = 0;
  for (let i = 0; i < heatWeights.length; i += 1) {
    const p = i * 3;
    const dx = positions[p] - heatTarget[0];
    const dy = positions[p + 1] - heatTarget[1];
    const dz = positions[p + 2] - heatTarget[2];
    const value = Math.exp(-0.5 * (dx * dx + dy * dy + dz * dz) / radius2);
    heatWeights[i] = value;
    if (value > maximum) maximum = value;
  }
  if (maximum > 1e-12) {
    for (let i = 0; i < heatWeights.length; i += 1) heatWeights[i] /= maximum;
  }
}

function advance() {
  if (!metadata || !playing) return;
  const simulation = metadata.simulation;
  const physics = metadata.physics;
  const dt = simulation.dt_s / simulation.substeps;
  const n = temperatures.length;
  for (let substep = 0; substep < simulation.substeps; substep += 1) {
    for (let row = 0; row < n; row += 1) {
      let diffusion = 0;
      for (let cursor = indptr[row]; cursor < indptr[row + 1]; cursor += 1) {
        diffusion += laplacianData[cursor] * temperatures[indices[cursor]];
      }
      let rhs = -physics.alpha_m2_per_s * diffusion;
      rhs -= physics.h_per_s * (temperatures[row] - physics.ambient_temp_c);
      if (heatEnabled && heatPower > 0) rhs += heatPower * heatWeights[row];
      if (simulation.rhs_clip_c_per_s > 0) {
        rhs = clamp(rhs, -simulation.rhs_clip_c_per_s, simulation.rhs_clip_c_per_s);
      }
      nextTemperatures[row] = clamp(
        temperatures[row] + dt * rhs,
        simulation.min_temp_c,
        simulation.max_temp_c,
      );
    }
    const old = temperatures;
    temperatures = nextTemperatures;
    nextTemperatures = old;
    elapsed += dt;
  }
  frame += 1;
  if (frame % 2 === 0) publish();
}

function publish() {
  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  for (let i = 0; i < temperatures.length; i += 1) {
    const value = temperatures[i];
    if (value < min) min = value;
    if (value > max) max = value;
    total += value;
  }
  const copy = temperatures.slice();
  self.postMessage(
    { type: "frame", elapsed, min, max, mean: total / temperatures.length, temperatures: copy.buffer },
    [copy.buffer],
  );
}

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === "init") {
    metadata = message.metadata;
    positions = new Float32Array(message.positions);
    indptr = new Uint32Array(message.indptr);
    indices = new Uint32Array(message.indices);
    laplacianData = new Float32Array(message.data);
    temperatures = new Float32Array(metadata.point_count);
    nextTemperatures = new Float32Array(metadata.point_count);
    heatWeights = new Float32Array(metadata.point_count);
    temperatures.fill(metadata.physics.initial_temp_c);
    heatEnabled = metadata.heat_gun.enabled;
    heatPower = metadata.heat_gun.power_c_per_s;
    heatRadius = metadata.heat_gun.radius;
    heatTarget = [...metadata.heat_gun.target_xyz];
    recomputeHeatWeights();
    publish();
    timer = setInterval(advance, 1000 / 30);
    self.postMessage({ type: "ready" });
  } else if (message.type === "play") {
    playing = Boolean(message.value);
  } else if (message.type === "heat-enabled") {
    heatEnabled = Boolean(message.value);
  } else if (message.type === "power") {
    heatPower = Number(message.value);
  } else if (message.type === "heat-target") {
    heatTarget = message.value.map(Number);
    recomputeHeatWeights();
  } else if (message.type === "radius") {
    heatRadius = Math.max(Number(message.value), 1e-9);
    recomputeHeatWeights();
  } else if (message.type === "reset") {
    temperatures.fill(metadata.physics.initial_temp_c);
    nextTemperatures.fill(metadata.physics.initial_temp_c);
    elapsed = 0;
    frame = 0;
    publish();
  }
};

self.addEventListener("close", () => {
  if (timer !== null) clearInterval(timer);
});
