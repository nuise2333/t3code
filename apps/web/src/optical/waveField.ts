export const RIPPLE = {
  fontSize: 10,
  cellWidth: 7,
  cellHeight: 15,
  changeRate: 2,
  digitRatio: 0.3,
  cloudScale: 100,
  cloudCoverage: 1,
  cloudSoftness: 0.1,
  cloudDrift: 8,
  idleAlphaLight: 0.172,
  idleAlphaDark: 0.13,
  speedNear: 1100,
  speedFar: 80,
  speedFalloff: 240,
  damping: 1,
  borderCells: 6,
  turbulence: 0.45,
  turbulenceScale: 180,
  sourceFrequency: 6,
  sourceRadius: 36,
  sourceAmplitude: 1.4,
  waveGain: 3.5,
  glowDecay: 1.2,
  glowAlpha: 0.3,
  waveAlpha: 0.85,
  patchScale: 60,
  patchFloor: 0.3,
  edgeFeather: 0.05,
  breathPeriod: 10.5,
  breathDepth: 0.24,
  breathScale: 280,
  calmAlpha: 0.45,
  calmFeather: 36,
  lightAlphaScale: 0.72,
  waveAlphaCap: 0.7,
  injectSoftness: 0.8,
  injectLoadDecay: 0.9,
  heightKnee: 0.9,
  heightCap: 1.6,
  auraTint: 0.48,
  auraLift: 0.78,
  auraRadius: 230,
  prismTint: 0.68,
  prismCap: 0.74,
  prismBands: 3,
  prismSlopeScale: 60,
  prismThreshold: 0.2,
  nebulaTint: 0.58,
  nebulaLift: 1.08,
  nebulaFrameMs: 40,
  nebulaPeriods: [8.4, 10.8, 12.8],
} as const;

const WAVE_STEP = 1 / 600;
const MAX_ADVANCE = 0.05;
const REST_HEIGHT = 0.003;
const MAX_SOURCES = 24;
const SKIMMER_MERGE_CELLS = 2;
const SKIMMER_MERGE_SECONDS = 0.036;
const SKIMMER_DURATION = 0.105;
const WAKE_LOAD_DECAY_SECONDS = 0.2;
const BORDER_DAMPING = 12;
const TAU = Math.PI * 2;

export function hash(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * sx;
  const bottom = hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * sx;
  return top + (bottom - top) * sy;
}

export function fractalNoise(x: number, y: number): number {
  return (
    (valueNoise(x, y) * 4 +
      valueNoise(x * 2.1 + 7, y * 2.1 + 3) * 2 +
      valueNoise(x * 4.3 + 13, y * 4.3 + 11)) /
    7
  );
}

export function smooth(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

export interface WaveDisturbOptions {
  readonly duration?: number;
  readonly radiusScale?: number;
  readonly amplitudeScale?: number;
  readonly frequency?: number;
  readonly loadWeight?: number;
  readonly delay?: number;
}

export interface WaveField {
  readonly columns: number;
  readonly rows: number;
  readonly height: Float32Array;
  active(): boolean;
  sourceCount(): number;
  disturb(column: number, row: number, options?: WaveDisturbOptions): void;
  skimmer(column: number, row: number, speedNorm?: number): void;
  advance(seconds: number): void;
}

interface WaveSource {
  column: number;
  row: number;
  time: number;
  delay: number;
  duration: number;
  radiusScale: number;
  amplitudeScale: number;
  frequency: number;
  skimmer: boolean;
}

const positive = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

/** Damped 2D wave equation on the glyph grid, solved only inside the box that still moves. */
export function createWaveField(
  columns: number,
  rows: number,
  random: () => number = Math.random,
): WaveField {
  const cells = columns * rows;
  const height = new Float32Array(cells);
  const velocity = new Float32Array(cells);
  const speedSquared = new Float32Array(cells);
  const speedFactor = new Float32Array(cells);
  const damping = new Float32Array(cells);
  const seed = random() * 1000;
  const { cellWidth, cellHeight } = RIPPLE;
  const invW2 = 1 / (cellWidth * cellWidth);
  const invH2 = 1 / (cellHeight * cellHeight);
  const loadDecay = Math.exp(-WAVE_STEP / RIPPLE.injectLoadDecay);
  const wakeLoadDecay = Math.exp(-WAVE_STEP / WAKE_LOAD_DECAY_SECONDS);
  const knee = RIPPLE.heightKnee;
  const span = Math.max(0.01, RIPPLE.heightCap - RIPPLE.heightKnee);
  const sources: WaveSource[] = [];
  let moving = false;
  let behind = 0;
  let load = 0;
  let wakeLoad = 0;
  let baseSpeedPrimed = false;
  let actC0 = columns;
  let actC1 = -1;
  let actR0 = rows;
  let actR1 = -1;

  const turbulenceAt = (column: number, row: number) =>
    fractalNoise(
      (column * cellWidth) / RIPPLE.turbulenceScale + seed,
      (row * cellHeight) / RIPPLE.turbulenceScale + seed,
    );
  const seedCell = (cell: number, column: number, row: number, noise: number) => {
    speedFactor[cell] = Math.min(1.4, Math.max(0.3, 1 + RIPPLE.turbulence * (noise - 0.5) * 3.2));
    const edge = Math.min(column, row, columns - 1 - column, rows - 1 - row);
    const border = Math.max(0, 1 - edge / RIPPLE.borderCells) ** 2;
    damping[cell] = RIPPLE.damping + border * BORDER_DAMPING;
  };

  if (columns >= 32 && rows >= 16) {
    // Turbulence is smooth at this scale, so half-resolution samples lerp to the same field.
    const gCols = Math.ceil(columns / 2) + 1;
    const gRows = Math.ceil(rows / 2) + 1;
    const coarse = new Float32Array(gCols * gRows);
    for (let gr = 0; gr < gRows; gr++) {
      const r = Math.min(rows - 1, gr * 2);
      for (let gc = 0; gc < gCols; gc++) {
        coarse[gr * gCols + gc] = turbulenceAt(Math.min(columns - 1, gc * 2), r);
      }
    }
    for (let row = 0; row < rows; row++) {
      const gr = row >> 1;
      const ty = (row & 1) * 0.5;
      const rowOff0 = gr * gCols;
      const rowOff1 = Math.min(gRows - 1, gr + 1) * gCols;
      for (let column = 0; column < columns; column++) {
        const gc = column >> 1;
        const gc1 = Math.min(gCols - 1, gc + 1);
        const tx = (column & 1) * 0.5;
        const a0 = coarse[rowOff0 + gc]!;
        const a1 = coarse[rowOff1 + gc]!;
        const n0 = a0 + (coarse[rowOff0 + gc1]! - a0) * tx;
        const n1 = a1 + (coarse[rowOff1 + gc1]! - a1) * tx;
        seedCell(row * columns + column, column, row, n0 + (n1 - n0) * ty);
      }
    }
  } else {
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        seedCell(row * columns + column, column, row, turbulenceAt(column, row));
      }
    }
  }

  function primeFarBaseline() {
    if (baseSpeedPrimed) return;
    for (let i = 0; i < cells; i++) {
      const s = RIPPLE.speedFar * speedFactor[i]!;
      const sq = s * s;
      if (sq > speedSquared[i]!) speedSquared[i] = sq;
    }
    baseSpeedPrimed = true;
  }

  function raiseSpeedsAround(
    column: number,
    row: number,
    reachPx: number,
    boost: number,
    falloffPx: number,
  ) {
    primeFarBaseline();
    const reachSq = reachPx * reachPx;
    const reachCols = Math.ceil(reachPx / cellWidth);
    const reachRows = Math.ceil(reachPx / cellHeight);
    const r0 = Math.max(0, row - reachRows);
    const r1 = Math.min(rows - 1, row + reachRows);
    const c0 = Math.max(0, column - reachCols);
    const c1 = Math.min(columns - 1, column + reachCols);
    for (let r = r0; r <= r1; r++) {
      const dy = (r - row) * cellHeight;
      const dy2 = dy * dy;
      const rowBase = r * columns;
      for (let c = c0; c <= c1; c++) {
        const dx = (c - column) * cellWidth;
        const d2 = dx * dx + dy2;
        if (d2 > reachSq) continue;
        const cell = rowBase + c;
        const speed =
          (RIPPLE.speedFar + boost * Math.exp(-Math.sqrt(d2) / falloffPx)) * speedFactor[cell]!;
        const squared = speed * speed;
        if (squared > speedSquared[cell]!) speedSquared[cell] = squared;
      }
    }
  }

  const raiseSpeeds = (column: number, row: number) =>
    raiseSpeedsAround(
      column,
      row,
      RIPPLE.speedFalloff * 4.6,
      RIPPLE.speedNear - RIPPLE.speedFar,
      RIPPLE.speedFalloff,
    );
  const raiseWakeSpeeds = (column: number, row: number, speedNorm: number) =>
    raiseSpeedsAround(
      column,
      row,
      RIPPLE.speedFalloff * 0.65,
      (RIPPLE.speedNear - RIPPLE.speedFar) * (0.14 + 0.14 * speedNorm),
      RIPPLE.speedFalloff * 0.55,
    );

  // Each stacked source injects less, so rapid clicks compress instead of saturating the grid.
  const loadGain = (softness: number, stacked: number) => {
    const n = 1 + stacked;
    return Math.tanh(softness * n) / (Math.tanh(softness) * n);
  };

  function drive() {
    let keep = 0;
    for (const source of sources) {
      if (source.delay > 0) {
        source.delay -= WAVE_STEP;
        sources[keep++] = source;
        continue;
      }
      const envelope = Math.sin((Math.PI * source.time) / source.duration);
      const rate = Math.cos(TAU * source.frequency * source.time) * TAU * RIPPLE.sourceFrequency;
      const radius = RIPPLE.sourceRadius * source.radiusScale;
      const inv2r2 = 1 / (2 * radius * radius);
      const gain = RIPPLE.sourceAmplitude * source.amplitudeScale * envelope * rate * WAVE_STEP;
      const reachColumns = Math.ceil((radius * 3) / cellWidth);
      const reachRows = Math.ceil((radius * 3) / cellHeight);
      const r0 = Math.max(0, source.row - reachRows);
      const r1 = Math.min(rows - 1, source.row + reachRows);
      const c0 = Math.max(0, source.column - reachColumns);
      const c1 = Math.min(columns - 1, source.column + reachColumns);
      if (r0 < actR0) actR0 = r0;
      if (r1 > actR1) actR1 = r1;
      if (c0 < actC0) actC0 = c0;
      if (c1 > actC1) actC1 = c1;
      for (let r = r0; r <= r1; r++) {
        const dy = (r - source.row) * cellHeight;
        const dy2 = dy * dy;
        const rowBase = r * columns;
        for (let c = c0; c <= c1; c++) {
          const dx = (c - source.column) * cellWidth;
          const i = rowBase + c;
          let v = height[i]! + gain * Math.exp(-(dx * dx + dy2) * inv2r2);
          const av = v < 0 ? -v : v;
          if (av > knee) v = (v < 0 ? -1 : 1) * (knee + span * Math.tanh((av - knee) / span));
          height[i] = v;
        }
      }
      source.time += WAVE_STEP;
      if (source.time < source.duration) sources[keep++] = source;
    }
    sources.length = keep;
  }

  function settle() {
    if (actC0 <= actC1 && actR0 <= actR1) {
      for (let r = actR0; r <= actR1; r++) {
        const start = r * columns + actC0;
        const end = r * columns + actC1 + 1;
        height.fill(0, start, end);
        velocity.fill(0, start, end);
      }
    } else {
      height.fill(0);
      velocity.fill(0);
    }
    speedSquared.fill(0);
    load = 0;
    wakeLoad = 0;
    baseSpeedPrimed = false;
    actC0 = columns;
    actC1 = -1;
    actR0 = rows;
    actR1 = -1;
  }

  function step() {
    let peak = 0;
    if (actC0 <= actC1 && actR0 <= actR1) {
      const rStart = Math.max(0, actR0 - 1);
      const rEnd = Math.min(rows - 1, actR1 + 1);
      const cStart = Math.max(0, actC0 - 1);
      const cEnd = Math.min(columns - 1, actC1 + 1);
      const decayMul = 1 - 0.35 * WAVE_STEP;
      for (let r = rStart; r <= rEnd; r++) {
        const rowBase = r * columns;
        const hasAbove = r > 0;
        const hasBelow = r < rows - 1;
        for (let c = cStart; c <= cEnd; c++) {
          const cell = rowBase + c;
          const here = height[cell]!;
          const left = c > 0 ? height[cell - 1]! : here;
          const right = c < columns - 1 ? height[cell + 1]! : here;
          const above = hasAbove ? height[cell - columns]! : here;
          const below = hasBelow ? height[cell + columns]! : here;
          const laplacian = (left + right - 2 * here) * invW2 + (above + below - 2 * here) * invH2;
          velocity[cell] =
            velocity[cell]! +
            (speedSquared[cell]! * laplacian - damping[cell]! * velocity[cell]!) * WAVE_STEP;
        }
      }
      let nC0 = columns;
      let nC1 = -1;
      let nR0 = rows;
      let nR1 = -1;
      for (let r = rStart; r <= rEnd; r++) {
        const rowBase = r * columns;
        for (let c = cStart; c <= cEnd; c++) {
          const cell = rowBase + c;
          const vel = velocity[cell]!;
          const h = (height[cell]! + vel * WAVE_STEP) * decayMul;
          const a = h < 0 ? -h : h;
          const av = vel < 0 ? -vel : vel;
          if (a > peak) peak = a;
          if (a > 1e-5 || av > 5e-5) {
            height[cell] = h;
            if (c < nC0) nC0 = c;
            if (c > nC1) nC1 = c;
            if (r < nR0) nR0 = r;
            if (r > nR1) nR1 = r;
          } else if (h !== 0 || vel !== 0) {
            height[cell] = 0;
            velocity[cell] = 0;
          }
        }
      }
      actC0 = nC0;
      actC1 = nC1;
      actR0 = nR0;
      actR1 = nR1;
    }
    drive();
    if (peak === 0 && actC0 <= actC1) {
      for (let r = actR0; r <= actR1; r++) {
        const rowBase = r * columns;
        for (let c = actC0; c <= actC1; c++) {
          const a = Math.abs(height[rowBase + c]!);
          if (a > peak) peak = a;
        }
      }
    }
    load *= loadDecay;
    wakeLoad *= wakeLoadDecay;
    moving = sources.length > 0 || peak > REST_HEIGHT;
    if (!moving) settle();
  }

  const clampCell = (value: number, limit: number) =>
    Math.max(0, Math.min(limit - 1, Math.floor(value)));

  return {
    columns,
    rows,
    height,
    active: () => moving,
    sourceCount: () => sources.length,
    disturb(column, row, options = {}) {
      if (columns <= 0 || rows <= 0) return;
      if (!Number.isFinite(column) || !Number.isFinite(row)) return;
      const c = clampCell(column, columns);
      const r = clampCell(row, rows);
      raiseSpeeds(c, r);
      const amplitude =
        options.amplitudeScale !== undefined && Number.isFinite(options.amplitudeScale)
          ? Math.max(0, options.amplitudeScale)
          : 0.78 + random() * 0.72;
      sources.push({
        column: c,
        row: r,
        time: 0,
        delay: positive(options.delay) ? options.delay : 0,
        duration: positive(options.duration)
          ? options.duration
          : (2 + Math.floor(random() * 2)) / RIPPLE.sourceFrequency,
        radiusScale: positive(options.radiusScale) ? options.radiusScale : 0.78 + random() * 0.92,
        amplitudeScale: amplitude * loadGain(RIPPLE.injectSoftness, load),
        frequency: positive(options.frequency) ? options.frequency : RIPPLE.sourceFrequency,
        skimmer: false,
      });
      load +=
        options.loadWeight !== undefined && Number.isFinite(options.loadWeight)
          ? Math.max(0, options.loadWeight)
          : 1;
      moving = true;
    },
    skimmer(column, row, speedNorm = 0.5) {
      if (columns <= 0 || rows <= 0) return;
      if (!Number.isFinite(column) || !Number.isFinite(row)) return;
      const c = clampCell(column, columns);
      const r = clampCell(row, rows);
      const s = Number.isFinite(speedNorm) ? Math.max(0, Math.min(1, speedNorm)) : 0.5;
      raiseWakeSpeeds(c, r, s);
      const amplitude = (0.048 + 0.088 * s) * loadGain(0.85, wakeLoad);
      const last = sources.at(-1);
      if (
        last?.skimmer &&
        Math.abs(last.column - c) <= SKIMMER_MERGE_CELLS &&
        Math.abs(last.row - r) <= SKIMMER_MERGE_CELLS &&
        last.time < SKIMMER_MERGE_SECONDS
      ) {
        last.column = c;
        last.row = r;
        last.amplitudeScale = Math.min(0.145, Math.max(last.amplitudeScale, amplitude));
        moving = true;
        return;
      }
      if (sources.length >= MAX_SOURCES) {
        const oldest = sources.findIndex((source) => source.skimmer);
        if (oldest >= 0) sources.splice(oldest, 1);
      }
      sources.push({
        column: c,
        row: r,
        time: 0,
        delay: 0,
        duration: SKIMMER_DURATION,
        radiusScale: 0.52,
        amplitudeScale: amplitude,
        frequency: 1.5 / SKIMMER_DURATION,
        skimmer: true,
      });
      wakeLoad = Math.min(2.4, wakeLoad + 0.28);
      moving = true;
    },
    advance(seconds) {
      behind += Math.min(seconds, MAX_ADVANCE);
      while (behind >= WAVE_STEP) {
        step();
        behind -= WAVE_STEP;
      }
    },
  };
}
