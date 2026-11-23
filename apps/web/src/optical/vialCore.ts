const WAVE_NODES = 24;
// Geometry lives in a 96x220 design space; the renderer scales a crop of it onto the canvas.
const TUBE_X = 34;
const TUBE_OUT_R = 21.6;
const TUBE_IN_R = 19.6;
const LIP_Y = 18.5;
const TOP_OUT = 18.5;
const TOP_IN = 20.5;
const RC_TOP_IN = 12.5;
const HEM_Y = 175;
const FLOOR_OUT = 198;
const FLOOR_IN = 195;
const RC_OUT = 14.5;
const RC_IN = 12.5;
const CHAMBER_TOP = LIP_Y + 8;
const CHAMBER_BOTTOM = HEM_Y + 14;
const FIXED_DT = 1 / 120;
const MAX_FRAME_DT = 0.05;
const MAX_SUBSTEPS = 8;
const GRAVITY = 460;
const MAX_TILT = 0.48;
const MAX_WETTING = 0.42;
const MAX_DROPS = 4;
const MAX_BUBBLES = 10;
const SETTLE_MIN_AGE_SEC = 1.1;
const MAX_DPR = 2;
/** The capsule and its tick marks, without the label gutter of the full design. */
const VIEW_COMPACT = { x: 8, y: 12, w: 58, h: 192 } as const;
/** Wider crop that preserves the right-hand gutter for 128k/256k/384k tick labels. */
const VIEW_LABELED = { x: 8, y: 12, w: 86, h: 192 } as const;
const DEFAULT_RATIOS: readonly [number, number, number] = [0.08, 0.27, 0.12];

const clampFill = (value: number) =>
  Math.max(0.06, Math.min(0.95, Number.isFinite(value) ? value : 0.46));
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export interface VialDrop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

export interface VialBubble {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  phase: number;
  aspect: number;
  alpha: number;
  gentle: boolean;
}

export interface VialSnapshot {
  readonly fill: number;
  readonly targetFill: number;
  readonly tiltAngle: number;
  readonly tiltVelocity: number;
  readonly waveEnergy: number;
  readonly wetLeft: number;
  readonly wetRight: number;
  readonly fallingCount: number;
  readonly bubbleCount: number;
  readonly streaming: boolean;
}

export interface VialPhysicsOptions {
  readonly fill?: number;
  readonly streaming?: boolean;
  readonly random?: () => number;
}

export interface VialPhysics {
  readonly waveH: Float32Array;
  readonly fallingDrops: readonly VialDrop[];
  readonly bubbles: readonly VialBubble[];
  setTargetFill(next: number): void;
  snapFill(next: number): void;
  setStreaming(on: boolean): void;
  injectSlosh(impulse?: number): void;
  injectTilt(impulse?: number): void;
  injectFingerPoke(normX: number, normY: number, vx: number, vy: number): void;
  spawnDroplet(): void;
  surfacePixelY(): number;
  isSettled(): boolean;
  step(dtSec: number): void;
  snapshot(): VialSnapshot;
}

/** Damped shallow-water surface on a gravity pendulum, with wall wetting, drops and bubbles. */
export function createVialPhysics(options: VialPhysicsOptions = {}): VialPhysics {
  const random = options.random ?? Math.random;
  const waveH = new Float32Array(WAVE_NODES);
  const waveV = new Float32Array(WAVE_NODES);
  const fallingDrops: VialDrop[] = [];
  const bubbles: VialBubble[] = [];
  let fill = clampFill(options.fill ?? 0.46);
  let targetFill = fill;
  let streaming = options.streaming ?? false;
  let tiltAngle = 0;
  let tiltVel = 0;
  let wetLeft = 0;
  let wetRight = 0;
  let streamClock = 0;
  let dustCooldown = 0.42;
  let accumulator = 0;

  const nodeNorm = (i: number) => (i / (WAVE_NODES - 1)) * 2 - 1;
  const surfacePixelY = () => CHAMBER_BOTTOM - fill * (CHAMBER_BOTTOM - CHAMBER_TOP);

  const sampleWave = (normX: number) => {
    const t = clamp((normX + 1) * 0.5, 0, 1) * (WAVE_NODES - 1);
    const i0 = Math.min(WAVE_NODES - 2, Math.floor(t));
    const f = t - i0;
    return waveH[i0]! * (1 - f) + waveH[i0 + 1]! * f;
  };

  const localSurfaceY = (xPx: number) =>
    surfacePixelY() + Math.tan(tiltAngle) * xPx + sampleWave(xPx / TUBE_IN_R);

  const boreHalfWidthAt = (yPx: number) => {
    if (yPx <= TOP_IN || yPx >= FLOOR_IN) return 0;
    const cornerTop = TOP_IN + RC_TOP_IN;
    if (yPx < cornerTop) {
      const d = cornerTop - yPx;
      return TUBE_IN_R - RC_TOP_IN + Math.sqrt(Math.max(0, RC_TOP_IN * RC_TOP_IN - d * d));
    }
    const d = yPx - (FLOOR_IN - RC_IN);
    if (d <= 0) return TUBE_IN_R;
    if (d >= RC_IN) return TUBE_IN_R - RC_IN;
    return TUBE_IN_R - RC_IN + Math.sqrt(Math.max(0, RC_IN * RC_IN - d * d));
  };

  const spawnBubbles = (normX: number, count: number, gentle: boolean) => {
    const surface = surfacePixelY();
    for (let i = 0; i < count; i++) {
      if (bubbles.length >= MAX_BUBBLES) bubbles.shift();
      const jitter = (random() - 0.5) * 8;
      const y = gentle
        ? Math.min(HEM_Y + 10, Math.max(surface + 14, FLOOR_IN - 12 - random() * 18))
        : Math.min(HEM_Y + 11, surface + 5 + random() * 14);
      const r = gentle ? 0.95 + random() * 0.65 : 1.3 + random() * 1.45;
      const maxX = Math.max(2, boreHalfWidthAt(y) - r - 1.2);
      bubbles.push({
        x: clamp(normX * (TUBE_IN_R - 4) + jitter, -maxX, maxX),
        y,
        r,
        vx: (random() - 0.5) * (gentle ? 3.5 : 9),
        vy: gentle ? -(14 + random() * 9) : -(22 + random() * 24),
        phase: random() * Math.PI * 2,
        aspect: 1,
        alpha: gentle ? 0.72 : 0.92,
        gentle,
      });
    }
  };

  const injectWaveRange = (centerNorm: number, widthNodes: number, velocity: number) => {
    const center = clamp((centerNorm + 1) * 0.5 * (WAVE_NODES - 1), 0, WAVE_NODES - 1);
    for (let i = 0; i < WAVE_NODES; i++) {
      const d = Math.abs(i - center);
      if (d > widthNodes) continue;
      const weight = 0.5 * (1 + Math.cos((d / Math.max(1, widthNodes)) * Math.PI));
      waveV[i] = clamp(waveV[i]! + velocity * weight, -65, 65);
    }
  };

  const waveEnergy = () => {
    let energy = 0;
    for (let i = 0; i < WAVE_NODES; i++) energy += Math.abs(waveH[i]!) + Math.abs(waveV[i]!) * 0.05;
    return energy;
  };

  const subStep = (dt: number) => {
    const fillError = targetFill - fill;
    fill = Math.abs(fillError) < 0.00018 ? targetFill : fill + fillError * Math.min(1, dt * 6);

    const omega = 7.2;
    const zeta = 0.4;
    let streamTorque = 0;
    if (streaming) {
      streamClock += dt;
      streamTorque = Math.sin(streamClock * 1.55) * 0.22 + Math.sin(streamClock * 2.7 + 1.1) * 0.09;
    }
    let tiltAcc = -2 * zeta * omega * tiltVel - omega * omega * tiltAngle + streamTorque;
    tiltVel += tiltAcc * dt;
    tiltAngle = clamp(tiltAngle + tiltVel * dt, -MAX_TILT, MAX_TILT);
    // Below this the pendulum only creeps; snapping it lets the surface reach exact rest.
    if (!streaming && Math.abs(tiltAngle) < 0.00035 && Math.abs(tiltVel) < 0.0012) {
      tiltAngle = 0;
      tiltVel = 0;
      tiltAcc = 0;
    }
    const sinT = Math.sin(tiltAngle);
    const cosT = Math.cos(tiltAngle);
    if (tiltAngle < -0.11)
      wetLeft = Math.max(wetLeft, Math.min(MAX_WETTING, (-tiltAngle - 0.08) * 1.15));
    if (tiltAngle > 0.11)
      wetRight = Math.max(wetRight, Math.min(MAX_WETTING, (tiltAngle - 0.08) * 1.15));

    const tiltPump = -tiltAcc * 0.3;
    for (let i = 0; i < WAVE_NODES; i++) {
      const here = waveH[i]!;
      const left = i > 0 ? waveH[i - 1]! : here;
      const right = i < WAVE_NODES - 1 ? waveH[i + 1]! : here;
      const acc =
        380 * (left + right - 2 * here) - 2.65 * waveV[i]! - 26 * here + tiltPump * nodeNorm(i);
      waveV[i] = waveV[i]! + acc * dt;
    }
    let sum = 0;
    for (let i = 0; i < WAVE_NODES; i++) {
      const next = clamp(waveH[i]! + waveV[i]! * dt, -10, 10);
      waveH[i] = next;
      sum += next;
    }
    // The liquid is incompressible, so the mean displacement is bled back toward zero.
    const meanFix = (sum / WAVE_NODES) * 0.025;
    for (let i = 0; i < WAVE_NODES; i++) waveH[i] = waveH[i]! - meanFix;
    if (!streaming && tiltAngle === 0 && tiltVel === 0 && waveEnergy() < 0.05) {
      waveH.fill(0);
      waveV.fill(0);
    }

    const runLeft = -waveH[0]! - 1.2;
    const runRight = -waveH[WAVE_NODES - 1]! - 1.2;
    if (runLeft > 0) wetLeft = Math.max(wetLeft, Math.min(MAX_WETTING, runLeft * 0.035));
    if (runRight > 0) wetRight = Math.max(wetRight, Math.min(MAX_WETTING, runRight * 0.035));
    wetLeft = Math.max(0, wetLeft - dt * 0.14);
    wetRight = Math.max(0, wetRight - dt * 0.14);

    if (streaming && fill > 0.14 && fallingDrops.length === 0) {
      dustCooldown -= dt;
      if (dustCooldown <= 0 && bubbles.length < 4) {
        dustCooldown = 0.62 + random() * 0.45;
        spawnBubbles((random() - 0.5) * 1.1, 1, true);
      }
    }

    for (let i = fallingDrops.length - 1; i >= 0; i--) {
      const drop = fallingDrops[i]!;
      drop.vx += -GRAVITY * sinT * dt;
      drop.vy += GRAVITY * cosT * dt;
      drop.x += drop.vx * dt;
      drop.y += drop.vy * dt;
      const limit = Math.max(0, boreHalfWidthAt(drop.y) - drop.r - 0.6);
      if (drop.x < -limit) {
        drop.x = -limit;
        drop.vx = Math.abs(drop.vx) * 0.12;
        wetLeft = Math.max(wetLeft, 0.12);
      } else if (drop.x > limit) {
        drop.x = limit;
        drop.vx = -Math.abs(drop.vx) * 0.12;
        wetRight = Math.max(wetRight, 0.12);
      }
      if (drop.y >= localSurfaceY(drop.x) - 1.5) {
        const at = drop.x / TUBE_IN_R;
        injectWaveRange(at, 4.2, -32);
        spawnBubbles(at, 3, false);
        fallingDrops.splice(i, 1);
      }
    }

    for (let i = bubbles.length - 1; i >= 0; i--) {
      const bubble = bubbles[i]!;
      bubble.phase += dt * (bubble.gentle ? 3.8 : 5.8 + 2 / bubble.r);
      const rise = bubble.gentle ? 16 + bubble.r * 5 : 25 + bubble.r * 8;
      const relax = Math.min(1, dt * 3);
      bubble.vx += (sinT * rise - bubble.vx) * relax;
      bubble.vy += (-cosT * rise - bubble.vy) * relax;
      const wobble = Math.sin(bubble.phase) * (bubble.gentle ? 3.2 : 5.6 + bubble.r * 2.2);
      bubble.x += (bubble.vx + cosT * wobble) * dt;
      bubble.y += (bubble.vy + sinT * wobble) * dt;
      bubble.aspect = 1 + (bubble.gentle ? 0.1 : 0.18) * Math.sin(bubble.phase * 2 + 0.6);
      const limit = Math.max(0, boreHalfWidthAt(bubble.y) - bubble.r - 1);
      bubble.x = clamp(bubble.x, -limit, limit);
      bubble.y = Math.min(HEM_Y + 11, bubble.y);
      if (bubble.y <= localSurfaceY(bubble.x) + 2.5) {
        injectWaveRange(bubble.x / TUBE_IN_R, 2, bubble.gentle ? -0.6 : -4.4);
        bubbles.splice(i, 1);
      }
    }
  };

  return {
    waveH,
    fallingDrops,
    bubbles,
    setTargetFill(next) {
      targetFill = clampFill(next);
    },
    snapFill(next) {
      targetFill = clampFill(next);
      fill = targetFill;
    },
    setStreaming(on) {
      streaming = on;
    },
    injectSlosh(impulse = 1.6) {
      const s = clamp(impulse, -3.8, 3.8);
      tiltVel += s * 1.85;
      for (let i = 0; i < WAVE_NODES; i++) {
        const norm = nodeNorm(i);
        waveV[i] = waveV[i]! + norm * s * 18 + Math.sin(norm * 4.2) * Math.abs(s) * 4.2;
      }
      if (Math.abs(s) > 0.85) spawnBubbles(s > 0 ? 0.25 : -0.25, 2, false);
    },
    injectTilt(impulse = 0.18) {
      const s = clamp(impulse, -1.6, 1.6);
      tiltAngle = clamp(tiltAngle + s * 0.45, -MAX_TILT, MAX_TILT);
      tiltVel += s * 2.2;
      for (let i = 0; i < WAVE_NODES; i++) waveV[i] = waveV[i]! + nodeNorm(i) * s * 12;
    },
    injectFingerPoke(normX, normY, vx, vy) {
      const nx = clamp(normX, -1, 1);
      const pushX = clamp(vx * 0.14, -2.6, 2.6);
      if (Math.abs(normY - (1 - fill)) < 0.22) {
        injectWaveRange(nx, 4.5, -24 + vy * 1.4);
        tiltVel += pushX * 0.62;
        if (nx < -0.35) wetLeft = Math.min(MAX_WETTING, wetLeft + 0.16);
        if (nx > 0.35) wetRight = Math.min(MAX_WETTING, wetRight + 0.16);
        spawnBubbles(nx * 0.7, 2, false);
        return;
      }
      injectWaveRange(nx, 3.2, -11.5);
      tiltVel += (pushX === 0 ? nx * 0.4 : pushX) * 0.44;
    },
    spawnDroplet() {
      if (fallingDrops.length >= MAX_DROPS) return;
      fallingDrops.push({ x: (random() - 0.5) * 1.8, y: LIP_Y + 5, vx: 0, vy: 38, r: 2.55 });
    },
    surfacePixelY,
    isSettled() {
      if (streaming || fallingDrops.length > 0 || bubbles.length > 0) return false;
      if (Math.abs(targetFill - fill) >= 0.001) return false;
      if (Math.abs(tiltAngle) >= 0.005 || Math.abs(tiltVel) >= 0.015) return false;
      return waveEnergy() < 0.24 && wetLeft < 0.06 && wetRight < 0.06;
    },
    step(dtSec) {
      accumulator += clamp(Number.isFinite(dtSec) ? dtSec : 0.016, 0.001, MAX_FRAME_DT);
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
        subStep(FIXED_DT);
        accumulator -= FIXED_DT;
        steps++;
      }
      if (steps >= MAX_SUBSTEPS) accumulator = 0;
    },
    snapshot: () => ({
      fill,
      targetFill,
      tiltAngle,
      tiltVelocity: tiltVel,
      waveEnergy: waveEnergy(),
      wetLeft,
      wetRight,
      fallingCount: fallingDrops.length,
      bubbleCount: bubbles.length,
      streaming,
    }),
  };
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;

uniform vec4 u_view;
uniform float u_time;
uniform float u_dark;
uniform float u_fill;
uniform float u_tilt;
uniform float u_camp;
uniform float u_accent;
uniform float u_critical;
uniform float u_wetL;
uniform float u_wetR;
uniform float u_hoverSlice;
uniform float u_wave[24];
uniform vec4 u_drops[4];
uniform vec4 u_bubbles[8];
uniform vec2 u_bubShape[8];
uniform vec3 u_ratios;

const float CX = 34.0;
const float R_OUT = 21.6;
const float R_IN = 19.6;
const float TOP_OUT = 18.5;
const float TOP_IN = 20.5;
const float LIP_Y = 18.5;
const float HEM_Y = 175.0;
const float FLOOR_OUT = 198.0;
const float FLOOR_IN = 195.0;
const float RC_OUT = 14.5;
const float RC_IN = 12.5;
const float H_BOX_OUT = 89.75;
const float Y_MID_OUT = 108.25;
const float H_BOX_IN = 87.25;
const float Y_MID_IN = 107.75;

const vec3 ION_DEEP = vec3(0.059, 0.090, 0.227);
const vec3 ION_SYS = vec3(0.106, 0.286, 0.698);
const vec3 ION_CONV = vec3(0.192, 0.525, 1.000);
const vec3 ION_TOOL = vec3(0.361, 0.776, 0.988);
const vec3 ION_HAZE = vec3(0.690, 0.875, 1.000);

const vec3 DAY_AIR = vec3(0.880, 0.920, 0.980);
const vec3 DAY_RIM_REF = vec3(0.118, 0.251, 0.686);
const vec3 DAY_ROYAL = vec3(0.114, 0.306, 0.847);
const vec3 DAY_COBALT = vec3(0.145, 0.388, 0.922);
const vec3 DAY_SKY = vec3(0.008, 0.518, 0.780);
const vec3 DAY_CROWN = vec3(0.055, 0.600, 0.885);
const vec3 DAY_MENISCUS = vec3(0.016, 0.275, 0.635);
const vec3 DAY_VIOLET = vec3(0.486, 0.227, 0.929);
const vec3 DAY_AMBER_RED = vec3(0.918, 0.345, 0.047);

const vec3 CLD_CONV = vec3(0.820, 0.490, 0.280);
const vec3 CAMP_INDIGO = vec3(0.165, 0.275, 0.725);
const vec3 CAMP_ASTRAL = vec3(0.395, 0.545, 0.980);
const vec3 CRIT_DEEP = vec3(0.360, 0.145, 0.035);
const vec3 CRIT_SYS = vec3(0.740, 0.330, 0.075);
const vec3 CRIT_CONV = vec3(0.945, 0.600, 0.070);
const vec3 CRIT_TOOL = vec3(0.995, 0.835, 0.310);

void layerOver(inout vec3 col, inout float alpha, vec3 srcCol, float srcA) {
  float a = clamp(srcA, 0.0, 1.0);
  if (a <= 1e-4) return;
  float outA = a + alpha * (1.0 - a);
  col = (srcCol * a + col * alpha * (1.0 - a)) / max(outA, 1e-4);
  alpha = outA;
}

float roundedBoxSdf(vec2 p, vec2 halfExt, float r) {
  vec2 d = abs(p) - (halfExt - vec2(r));
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

float sampleWave(float uNorm) {
  float t = clamp((uNorm + 1.0) * 0.5, 0.0, 1.0) * 23.0;
  int i1 = int(clamp(floor(t), 0.0, 22.0));
  float f = t - float(i1);
  float p0 = u_wave[max(i1 - 1, 0)];
  float p1 = u_wave[i1];
  float p2 = u_wave[i1 + 1];
  float p3 = u_wave[min(i1 + 2, 23)];
  return 0.5 * (2.0 * p1 + (-p0 + p2) * f + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * f * f + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * f * f * f);
}

float waveCurvature(float uNorm) {
  float du = 0.10;
  return sampleWave(uNorm - du) + sampleWave(uNorm + du) - 2.0 * sampleWave(uNorm);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm3(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * vNoise(p);
    p = p * 2.04 + vec2(11.3, 7.9);
    a *= 0.5;
  }
  return v;
}

float capsuleHalfWidth(float yPx, float topY, float botY, float rSide, float rc) {
  if (yPx < topY || yPx > botY) return 0.0;
  float cyT = topY + rc;
  if (yPx < cyT) {
    float dt = cyT - yPx;
    return rSide - rc + sqrt(max(0.0, rc * rc - dt * dt));
  }
  float cyB = botY - rc;
  if (yPx > cyB) {
    float db = yPx - cyB;
    return rSide - rc + sqrt(max(0.0, rc * rc - db * db));
  }
  return rSide;
}

vec3 evalHorizonSpectrum(float hFrac) {
  float h = clamp(hFrac, 0.0, 1.0);
  if (u_dark > 0.5) {
    vec3 crit = mix(CRIT_DEEP, CRIT_SYS, smoothstep(0.0, 0.36, h));
    crit = mix(crit, CRIT_CONV, smoothstep(0.30, 0.76, h));
    crit = mix(crit, CRIT_TOOL, smoothstep(0.68, 1.00, h));
    if (u_accent > 2.5) {
      vec3 monoSea = mix(vec3(0.110, 0.115, 0.128), vec3(0.310, 0.320, 0.345), smoothstep(0.0, 0.40, h));
      monoSea = mix(monoSea, vec3(0.580, 0.595, 0.625), smoothstep(0.34, 0.78, h));
      monoSea = mix(monoSea, vec3(0.865, 0.875, 0.895), smoothstep(0.70, 1.00, h));
      return mix(monoSea, crit, u_critical);
    }
    if (u_accent > 1.5) {
      vec3 ambSea = mix(vec3(0.215, 0.095, 0.025), vec3(0.580, 0.270, 0.055), smoothstep(0.0, 0.40, h));
      ambSea = mix(ambSea, vec3(0.851, 0.467, 0.024), smoothstep(0.34, 0.78, h));
      ambSea = mix(ambSea, vec3(0.984, 0.749, 0.141), smoothstep(0.70, 1.00, h));
      return mix(ambSea, crit, u_critical);
    }
    if (u_accent > 0.5) {
      vec3 irisSea = mix(vec3(0.110, 0.055, 0.255), vec3(0.310, 0.165, 0.720), smoothstep(0.0, 0.40, h));
      irisSea = mix(irisSea, vec3(0.545, 0.361, 0.965), smoothstep(0.34, 0.78, h));
      irisSea = mix(irisSea, vec3(0.768, 0.620, 0.992), smoothstep(0.70, 1.00, h));
      return mix(irisSea, crit, u_critical);
    }
    vec3 sea = mix(ION_DEEP, ION_SYS, smoothstep(0.0, 0.38, h));
    sea = mix(sea, ION_CONV, smoothstep(0.30, 0.78, h));
    sea = mix(sea, ION_TOOL, smoothstep(0.68, 1.00, h));
    vec3 darkCamp = mix(CAMP_INDIGO, CAMP_ASTRAL, smoothstep(0.22, 0.96, h));
    vec3 campTinted = mix(sea, darkCamp, u_camp * 0.22);
    return mix(campTinted, crit, u_critical);
  }

  vec3 dayCrit = mix(DAY_VIOLET * 0.86, DAY_VIOLET, smoothstep(0.0, 0.34, h));
  dayCrit = mix(dayCrit, DAY_AMBER_RED, smoothstep(0.28, 0.80, h));
  dayCrit = mix(dayCrit, vec3(0.960, 0.560, 0.065), smoothstep(0.76, 1.00, h));
  if (u_accent > 2.5) {
    vec3 dayMono = mix(vec3(0.153, 0.153, 0.165), vec3(0.322, 0.322, 0.357), smoothstep(0.0, 0.50, h));
    dayMono = mix(dayMono, vec3(0.455, 0.455, 0.490), smoothstep(0.45, 1.00, h));
    return mix(dayMono, dayCrit, u_critical);
  }
  if (u_accent > 1.5) {
    vec3 dayAmb = mix(vec3(0.706, 0.325, 0.035), vec3(0.851, 0.467, 0.024), smoothstep(0.0, 0.50, h));
    dayAmb = mix(dayAmb, vec3(0.961, 0.620, 0.043), smoothstep(0.45, 1.00, h));
    return mix(dayAmb, dayCrit, u_critical);
  }
  if (u_accent > 0.5) {
    vec3 dayIris = mix(vec3(0.357, 0.129, 0.714), vec3(0.486, 0.227, 0.929), smoothstep(0.0, 0.50, h));
    dayIris = mix(dayIris, vec3(0.659, 0.333, 0.969), smoothstep(0.45, 1.00, h));
    return mix(dayIris, dayCrit, u_critical);
  }

  vec3 daySea = mix(DAY_ROYAL, DAY_COBALT, smoothstep(0.0, 0.48, h));
  daySea = mix(daySea, DAY_SKY, smoothstep(0.42, 0.88, h));
  daySea = mix(daySea, DAY_CROWN, smoothstep(0.82, 1.00, h));
  daySea = mix(daySea, mix(DAY_VIOLET, CLD_CONV, 0.32 * h), u_camp * 0.20);

  float warnShift = smoothstep(0.68, 0.85, u_fill);
  vec3 warnSpec = mix(DAY_ROYAL, DAY_VIOLET, smoothstep(0.10, 0.78, h));
  daySea = mix(daySea, warnSpec, warnShift * 0.68);
  return mix(daySea, dayCrit, u_critical);
}

void drawIonDroplet(inout vec3 col, inout float alpha, vec2 px, vec2 center, float rad, vec3 dropCol, float darkMode) {
  vec2 p = px - center;
  if (dot(p, p) > (rad * 2.2 + 2.0) * (rad * 2.2 + 2.0)) return;
  vec2 q = vec2(p.x * 1.15, (p.y + 0.35 * rad) * 0.68);
  float rn = length(q) / max(0.7, rad);
  float halo = exp(-rn * rn * 2.4);
  float coreDist = length(vec2(p.x * 1.05, p.y * 0.92)) / max(0.6, rad);
  float core = 1.0 - smoothstep(0.35, 0.88, coreDist);
  vec3 bodyTint = darkMode > 0.5 ? mix(dropCol, ION_HAZE, 0.45) : mix(DAY_ROYAL, DAY_SKY, 0.55);
  layerOver(col, alpha, bodyTint, halo * mix(0.68, 0.62, darkMode));
  if (darkMode <= 0.5) {
    float rim = (1.0 - smoothstep(0.62, 1.02, coreDist)) * smoothstep(0.32, 0.68, coreDist);
    layerOver(col, alpha, DAY_MENISCUS, rim * 0.82);
  }
  layerOver(col, alpha, mix(vec3(0.96, 0.99, 1.0), dropCol, 0.28), core * 0.92);
}

void main() {
  vec2 px = u_view.xy + vec2(v_uv.x, 1.0 - v_uv.y) * u_view.zw;
  float dx = px.x - CX;

  float sdfOut = roundedBoxSdf(vec2(dx, px.y - Y_MID_OUT), vec2(R_OUT, H_BOX_OUT), RC_OUT);
  float distOut = -sdfOut;
  if (distOut <= -0.8) {
    outColor = vec4(0.0);
    return;
  }

  float sdfIn = roundedBoxSdf(vec2(dx, px.y - Y_MID_IN), vec2(R_IN, H_BOX_IN), RC_IN);
  float distIn = -sdfIn;
  float rOutAtY = capsuleHalfWidth(px.y, TOP_OUT, FLOOR_OUT, R_OUT, RC_OUT);
  float rInAtY = capsuleHalfWidth(px.y, TOP_IN, FLOOR_IN, R_IN, RC_IN);
  bool inInnerBore = distIn > -0.6;

  vec3 col = vec3(0.0);
  float alpha = 0.0;

  float topChamber = LIP_Y + 8.0;
  float botChamber = HEM_Y + 14.0;
  float baseSurfY = botChamber - u_fill * (botChamber - topChamber);
  float uIn = (rInAtY > 0.5) ? clamp(dx / rInAtY, -1.0, 1.0) : clamp(dx / R_IN, -1.0, 1.0);
  float au = abs(uIn);
  float slopeTilt = tan(u_tilt) * dx;
  float waveDisp = sampleWave(uIn);
  float capillary = -1.55 * pow(au, 3.0);

  float surfCenterY = baseSurfY + slopeTilt + waveDisp + capillary;
  float perspAmp = (rInAtY > 0.0) ? (0.205 * rInAtY * sqrt(max(0.0, 1.0 - uIn * uIn))) : 0.0;
  float surfBackY = surfCenterY - perspAmp;
  float surfFrontY = surfCenterY + perspAmp;

  float sumR = max(1e-3, u_ratios.x + u_ratios.y + u_ratios.z);
  float colH = max(12.0, FLOOR_IN - baseSurfY);
  float hFrac = clamp((FLOOR_IN - (px.y - slopeTilt * 0.72 - waveDisp * 0.45)) / colH, 0.0, 1.0);
  vec3 ionBase = evalHorizonSpectrum(hFrac);
  vec3 surfTint = evalHorizonSpectrum(0.96);

  float bodyAA = smoothstep(-0.55, 0.45, distOut);
  float uOut = clamp(dx / max(1.0, rOutAtY), -1.0, 1.0);
  float lensCurve = pow(abs(uOut), 2.6);
  vec3 airBackCol = u_dark > 0.5 ? vec3(0.045, 0.068, 0.125) : DAY_AIR;
  float airBackA = u_dark > 0.5
    ? 0.11 * (0.30 + 0.70 * pow(abs(uOut), 3.4))
    : mix(0.26, 0.42, lensCurve);
  layerOver(col, alpha, airBackCol, airBackA * bodyAA);

  if (u_dark <= 0.5) {
    float wallBand = smoothstep(3.4, 0.8, distOut) * bodyAA;
    float sideRefract = smoothstep(0.66, 0.98, abs(uOut)) * bodyAA;
    float capArc = (smoothstep(TOP_OUT + 6.5, TOP_OUT + 1.2, px.y) + smoothstep(FLOOR_OUT - 7.5, FLOOR_OUT - 1.2, px.y)) * bodyAA;
    float refractMask = clamp(max(wallBand * 0.85, sideRefract * 0.92) + capArc * 0.42, 0.0, 1.0);
    layerOver(col, alpha, DAY_RIM_REF, refractMask * 0.28);
  }

  if (px.y < TOP_OUT + RC_OUT) {
    float domeGlow = exp(-pow((px.y - (TOP_OUT + 2.8)) / 2.2, 2.0) - pow((dx + 5.0) / 10.5, 2.0)) * bodyAA;
    vec3 domeCol = u_dark > 0.5 ? mix(ION_HAZE, vec3(1.0), 0.5) : mix(DAY_COBALT, DAY_SKY, 0.45);
    layerOver(col, alpha, domeCol, domeGlow * mix(0.26, 0.32, u_dark));
  }

  if (inInnerBore && px.y >= surfBackY - 0.6) {
    float boreMask = smoothstep(-0.45, 0.55, distIn) * smoothstep(-0.5, 0.5, px.y - surfBackY);
    float depthPx = max(0.0, px.y - surfCenterY);
    float nz = sqrt(max(0.0, 1.0 - uIn * uIn));

    vec2 flowUv = vec2(dx / 25.0, (px.y + u_time * 10.5) / 38.0);
    float plasma = fbm3(flowUv + vec2(sin(u_time * 0.38) * 0.22, 0.0));
    float field = smoothstep(0.18, 0.84, plasma) * (0.42 + 0.58 * nz);

    vec3 ionBody;
    if (u_dark > 0.5) {
      vec3 darkEdgeTint = mix(ION_DEEP * 0.84, CRIT_DEEP, u_critical);
      vec3 deepBody = mix(darkEdgeTint, ionBase, 0.28 + 0.66 * nz);
      ionBody = deepBody * (0.72 + 0.26 * nz) * (0.88 + 0.18 * field);
      float horizonCrown = exp(-depthPx / 7.5) * (0.35 + 0.65 * nz);
      ionBody += surfTint * horizonCrown * 0.15;
      float subRim = smoothstep(2.4, 0.35, distIn) * smoothstep(-0.2, 0.5, distIn);
      ionBody = mix(ionBody, mix(surfTint, ION_HAZE, 0.30), subRim * 0.38);
      float botScatter = exp(-pow(dx / 11.0, 2.0) - pow((px.y - (FLOOR_IN - 3.0)) / 3.6, 2.0));
      ionBody += mix(ION_CONV, CRIT_CONV, u_critical) * botScatter * 0.16;
    } else {
      vec3 lightEdge = mix(DAY_ROYAL * 0.72, DAY_VIOLET * 0.68, u_critical);
      vec3 richBody = mix(lightEdge, ionBase, 0.32 + 0.68 * nz);
      ionBody = richBody * (0.88 + 0.16 * nz) * (0.92 + 0.14 * field);
      float horizonCrown = exp(-depthPx / 8.5) * (0.40 + 0.60 * nz);
      ionBody = mix(ionBody, mix(surfTint, vec3(0.75, 0.92, 1.0), 0.36), horizonCrown * 0.28);
      float subRim = smoothstep(2.6, 0.35, distIn) * smoothstep(-0.2, 0.5, distIn);
      ionBody = mix(ionBody, mix(DAY_RIM_REF, DAY_MENISCUS, 0.45), subRim * 0.42);
      float botScatter = exp(-pow(dx / 11.5, 2.0) - pow((px.y - (FLOOR_IN - 3.2)) / 3.8, 2.0));
      ionBody += mix(DAY_COBALT, DAY_AMBER_RED, u_critical) * botScatter * 0.18;
    }

    layerOver(col, alpha, clamp(ionBody, 0.0, 1.0), boreMask * mix(0.93, 0.91, u_dark));

    if (depthPx > 1.8) {
      float arcX = asin(clamp(uIn, -0.96, 0.96)) * R_IN;
      float waveSyncY = slopeTilt * 0.85 + waveDisp * 0.75;
      float pTime = px.y - waveSyncY + u_time * 6.2;
      vec2 stardustUv = vec2(arcX / 6.0, pTime / 6.0);
      vec2 cellId = floor(stardustUv);
      vec2 cellF = fract(stardustUv) - 0.5;
      float rnd = hash12(cellId + vec2(3.7, 9.1));
      float jitter = (rnd - 0.5) * 0.28;
      vec2 starOff = cellF - vec2(jitter, sin(rnd * 6.283 + u_time * 1.2) * 0.12);
      float dotRad = mix(0.09, 0.20, smoothstep(0.18, 0.95, rnd));
      float dotMask = (1.0 - smoothstep(dotRad - 0.07, dotRad + 0.03, length(starOff)));
      float upperBoost = 0.32 + 0.68 * exp(-depthPx / 54.0);
      float twinkle = 0.65 + 0.35 * sin(u_time * 2.1 + rnd * 12.566);
      float stardustVis = dotMask * step(0.36, rnd) * upperBoost * twinkle * nz * smoothstep(0.6, 2.5, distIn) * boreMask;
      vec3 baseStar = u_dark > 0.5 ? mix(ION_TOOL, ION_HAZE, 0.62) : vec3(0.92, 0.98, 1.0);
      vec3 campStar = mix(baseStar, vec3(0.68, 0.75, 1.0), u_camp * 0.42);
      vec3 starCol = mix(campStar, CRIT_TOOL, u_critical);
      layerOver(col, alpha, min(starCol * 1.22, 1.0), stardustVis * mix(0.62, 0.70, u_dark));
    }

    for (int i = 0; i < 8; i++) {
      vec4 b = u_bubbles[i];
      if (b.w <= 0.0 || px.y < surfCenterY + 1.0) continue;
      float bRad = b.z;
      vec2 bp0 = px - vec2(CX + b.x, b.y);
      if (dot(bp0, bp0) > (bRad * 2.2 + 1.4) * (bRad * 2.2 + 1.4)) continue;
      float ca = cos(u_bubShape[i].y);
      float sa = sin(u_bubShape[i].y);
      vec2 bpr = vec2(ca * bp0.x + sa * bp0.y, -sa * bp0.x + ca * bp0.y);
      float asp = max(0.65, u_bubShape[i].x);
      vec2 bp = bpr / vec2(asp, 1.0 / asp);
      float bd = length(bp) / max(0.6, bRad);
      float halo = exp(-bd * bd * 1.55) * b.w * boreMask;
      float sparkCore = (1.0 - smoothstep(0.22, 0.76, bd)) * b.w * boreMask;
      layerOver(col, alpha, mix(surfTint, ION_HAZE, 0.45), halo * 0.40);
      if (u_dark <= 0.5) {
        float bubRim = (1.0 - smoothstep(0.72, 1.08, bd)) * smoothstep(0.42, 0.76, bd) * b.w * boreMask;
        layerOver(col, alpha, mix(DAY_MENISCUS, DAY_VIOLET, u_critical), bubRim * 0.85);
      }
      layerOver(col, alpha, vec3(0.95, 0.99, 1.0), sparkCore * 0.88);
    }
  }

  if (inInnerBore) {
    float boreMask = smoothstep(-0.35, 0.55, distIn);

    if (px.y >= surfBackY - 0.5 && px.y <= surfFrontY + 0.5) {
      float discV = clamp((px.y - surfBackY) / max(0.8, surfFrontY - surfBackY), 0.0, 1.0);
      float wSlope = sampleWave(min(1.0, uIn + 0.06)) - sampleWave(max(-1.0, uIn - 0.06));
      float excite = smoothstep(0.08, 0.40, abs(wSlope) + abs(waveCurvature(uIn)) * 0.5 + abs(u_tilt) * 0.6);
      vec3 discCol = u_dark > 0.5
        ? mix(surfTint * 0.78, mix(surfTint, ION_HAZE, 0.42), 0.32 + 0.68 * discV)
        : mix(mix(DAY_ROYAL, DAY_SKY, 0.58), mix(DAY_SKY, vec3(0.76, 0.93, 1.0), 0.52), 0.28 + 0.72 * discV);
      discCol = mix(discCol, vec3(0.90, 0.96, 1.0), excite * 0.28);
      float discMask = smoothstep(-0.45, 0.45, px.y - surfBackY) * smoothstep(-0.45, 0.45, surfFrontY - px.y) * boreMask;
      layerOver(col, alpha, discCol, discMask * mix(0.68, 0.54, u_dark));
    }

    float dBack = abs(px.y - surfBackY);
    float backArc = (1.0 - smoothstep(0.18, 0.82, dBack)) * boreMask;
    vec3 backCol = u_dark > 0.5 ? mix(surfTint, ION_HAZE, 0.55) : mix(DAY_MENISCUS, DAY_SKY, 0.45);
    layerOver(col, alpha, backCol, backArc * mix(0.64, 0.50, u_dark));

    float dUnder = abs(px.y - (surfFrontY + 1.2));
    float underShadow = (1.0 - smoothstep(0.2, 0.92, dUnder)) * boreMask * step(px.y, FLOOR_IN - 0.5);
    layerOver(col, alpha, u_dark > 0.5 ? ION_DEEP : DAY_ROYAL * 0.58, underShadow * mix(0.52, 0.46, u_dark));

    float dFront = abs(px.y - surfFrontY);
    float laserHalo = exp(-pow(dFront / 2.1, 2.0)) * boreMask;
    float laserBlade = (1.0 - smoothstep(0.32, 0.95, dFront)) * boreMask;
    if (u_dark > 0.5) {
      float wSlope = abs(sampleWave(min(1.0, uIn + 0.06)) - sampleWave(max(-1.0, uIn - 0.06)));
      float prismShift = smoothstep(0.05, 0.32, wSlope + abs(u_tilt) * 0.7);
      vec3 coldBlade = mix(ION_TOOL, ION_HAZE, 0.68);
      vec3 baseBladeCol = mix(coldBlade, vec3(0.74, 0.82, 1.0), u_camp * 0.24);
      vec3 prismBladeCol = mix(ION_CONV, mix(CAMP_ASTRAL, ION_TOOL, 0.5 + 0.5 * uIn), clamp((uIn + 1.0) * 0.5, 0.0, 1.0));
      vec3 laserCol = mix(baseBladeCol, prismBladeCol, prismShift * (1.0 - u_critical) * 0.58);
      if (u_critical > 0.5) laserCol = mix(CRIT_TOOL, vec3(1.0, 0.97, 0.86), 0.48);
      layerOver(col, alpha, laserCol, laserHalo * 0.36);
      layerOver(col, alpha, mix(laserCol, vec3(0.97, 0.99, 1.0), 0.44), laserBlade * 0.92);
    } else {
      vec3 dayBlade = u_critical > 0.5
        ? mix(vec3(0.76, 0.25, 0.04), DAY_AMBER_RED, 0.5)
        : DAY_MENISCUS;
      layerOver(col, alpha, dayBlade, laserHalo * 0.38);
      layerOver(col, alpha, dayBlade, laserBlade * 0.95);
      float specLine = (1.0 - smoothstep(0.15, 0.58, abs(px.y - (surfFrontY - 0.55)))) * boreMask * (1.0 - 0.45 * au);
      layerOver(col, alpha, vec3(0.94, 0.99, 1.0), specLine * 0.72);
    }
  }

  if (inInnerBore && px.y < surfCenterY) {
    float wetSpan = 54.0;
    vec3 wetCol = u_dark > 0.5 ? mix(surfTint, ION_HAZE, 0.48) : mix(DAY_COBALT, DAY_SKY, 0.5);
    if (dx < 0.0 && u_wetL > 0.01 && px.y > surfCenterY - u_wetL * wetSpan) {
      float wRatio = 1.0 - clamp((surfCenterY - px.y) / (u_wetL * wetSpan), 0.0, 1.0);
      float wallMask = smoothstep(2.0, 0.3, distIn) * smoothstep(-0.2, 0.3, distIn);
      layerOver(col, alpha, wetCol, wallMask * wRatio * 0.56);
    }
    if (dx > 0.0 && u_wetR > 0.01 && px.y > surfCenterY - u_wetR * wetSpan) {
      float wRatio = 1.0 - clamp((surfCenterY - px.y) / (u_wetR * wetSpan), 0.0, 1.0);
      float wallMask = smoothstep(2.0, 0.3, distIn) * smoothstep(-0.2, 0.3, distIn);
      layerOver(col, alpha, wetCol, wallMask * wRatio * 0.56);
    }
  }

  for (int i = 0; i < 4; i++) {
    vec4 dr = u_drops[i];
    if (dr.w <= 0.0) continue;
    drawIonDroplet(col, alpha, px, vec2(CX + dr.x, dr.y), dr.z, surfTint, u_dark);
  }

  if (px.y > TOP_OUT + 9.0 && px.y < FLOOR_OUT - 9.0) {
    bool submerged = px.y >= surfCenterY;
    float snellShift = submerged ? 1.0 : 0.0;
    float fineAxisX = CX - R_OUT * 0.72 + snellShift;
    float fineThread = (1.0 - smoothstep(0.18, 0.85, abs(px.x - fineAxisX)))
      * smoothstep(TOP_OUT + 9.0, TOP_OUT + 22.0, px.y)
      * (1.0 - smoothstep(FLOOR_OUT - 22.0, FLOOR_OUT - 9.0, px.y))
      * smoothstep(0.8, 1.8, distOut);
    vec3 threadCol = u_dark > 0.5
      ? vec3(0.78, 0.89, 1.0)
      : (submerged ? vec3(0.95, 0.99, 1.0) : mix(DAY_RIM_REF, DAY_COBALT, 0.42));
    float threadAlpha = u_dark > 0.5 ? 0.32 : (submerged ? 0.56 : 0.34);
    layerOver(col, alpha, threadCol, fineThread * threadAlpha);
  }

  if (u_hoverSlice >= -0.5) {
    float midFrac = u_hoverSlice < 0.5
      ? (u_ratios.x * 0.5) / sumR
      : (u_hoverSlice < 1.5 ? (u_ratios.x + u_ratios.y * 0.5) / sumR : (u_ratios.x + u_ratios.y + u_ratios.z * 0.5) / sumR);
    float sliceY = FLOOR_IN - colH * midFrac;
    float sDist = abs(px.y - (sliceY + 0.14 * max(0.0, rOutAtY - abs(dx))));
    float hRing = (1.0 - smoothstep(0.25, 1.15, sDist)) * bodyAA;
    layerOver(col, alpha, u_dark > 0.5 ? ION_HAZE : vec3(1.0), hRing * 0.84);
  }

  float rimMask = smoothstep(1.65, 0.95, distOut) * smoothstep(-0.35, 0.35, distOut);
  float prismGrad = 0.5 + 0.5 * sin(px.y * 0.032 - u_time * 0.40 + dx * 0.04);
  vec3 darkRimLeft = mix(vec3(0.72, 0.85, 0.98), mix(vec3(0.22, 0.48, 0.92), vec3(0.48, 0.56, 0.92), prismGrad), 0.30);
  vec3 darkRimRight = vec3(0.20, 0.30, 0.46);
  vec3 lightRim = mix(DAY_RIM_REF, vec3(0.118, 0.161, 0.231), 0.52 + 0.25 * smoothstep(-0.6, 0.7, uOut));
  vec3 rimCol = u_dark > 0.5
    ? mix(darkRimLeft, darkRimRight, smoothstep(-0.6, 0.7, uOut))
    : lightRim;
  layerOver(col, alpha, rimCol, rimMask * mix(0.82, 0.84, u_dark));

  if (u_accent > 2.5 && u_critical < 0.5) {
    float monoLum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(monoLum * 0.99, monoLum, monoLum * 1.01), 0.94);
  } else if (u_accent > 0.5 && u_dark <= 0.5 && u_critical < 0.5) {
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    vec3 toneTint = u_accent > 1.5 ? vec3(lum * 1.24, lum * 0.88, lum * 0.52) : vec3(lum * 0.96, lum * 0.78, lum * 1.28);
    col = mix(col, clamp(toneTint, 0.0, 1.0), 0.24 * (1.0 - step(surfBackY, px.y)));
  }
  float n1 = hash12(gl_FragCoord.xy + fract(u_time * 7.0) * 31.0);
  float n2 = hash12(gl_FragCoord.xy + vec2(17.31, 41.7));
  float dither = (n1 + n2 - 1.0) / 255.0;
  outColor = vec4(clamp(col + vec3(dither), 0.0, 1.0), clamp(alpha + dither * step(0.01, alpha), 0.0, 1.0));
}`;

export type VialAccent = "cobalt" | "iris" | "amber" | "mono";
export type VialCamp = "gemini" | "claude";

export interface VialVisualState {
  readonly isDark: boolean;
  readonly fill: number;
  readonly critical: boolean;
  readonly streaming: boolean;
  readonly accent: VialAccent;
  readonly reduceMotion: boolean;
  readonly ratios?: readonly [number, number, number] | undefined;
  readonly hoveredSlice?: number | undefined;
  readonly camp?: VialCamp | undefined;
  readonly tickLabels?: readonly [string, string, string] | undefined;
}

export interface OpticalVialOptions {
  readonly getState: () => VialVisualState;
  /** Called when something needs a repaint: a poke, a prop change, or a restored GL context. */
  readonly onWake?: () => void;
  readonly force2D?: boolean;
}

export interface OpticalVial {
  rendererMode(): "webgl2" | "2d";
  resize(cssWidth: number, cssHeight: number): void;
  step(dtSec: number): void;
  isSettled(): boolean;
  wake(): void;
  agitate(strength?: number): void;
  /** Drops both backing stores; the next `step` restores them. */
  reclaim(): void;
  dispose(): void;
}

const VIAL_UNIFORMS = [
  "u_view",
  "u_time",
  "u_dark",
  "u_fill",
  "u_tilt",
  "u_camp",
  "u_accent",
  "u_critical",
  "u_wetL",
  "u_wetR",
  "u_hoverSlice",
  "u_ratios",
] as const;

interface VialGlState {
  readonly gl: WebGL2RenderingContext;
  readonly program: WebGLProgram;
  readonly buffer: WebGLBuffer | null;
  readonly u: Record<(typeof VIAL_UNIFORMS)[number], WebGLUniformLocation | null>;
  readonly wave: WebGLUniformLocation | null;
  readonly drops: WebGLUniformLocation | null;
  readonly bubbles: WebGLUniformLocation | null;
  readonly bubbleShape: WebGLUniformLocation | null;
}

const GL_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: true,
  premultipliedAlpha: false,
};

function buildVialGl(gl: WebGL2RenderingContext): VialGlState {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) || "shader compile error";
      gl.deleteShader(shader);
      throw new Error(log);
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error("program allocation failed");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "program link error");
  }
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const u = {} as Record<(typeof VIAL_UNIFORMS)[number], WebGLUniformLocation | null>;
  for (const name of VIAL_UNIFORMS) u[name] = gl.getUniformLocation(program, name);
  return {
    gl,
    program,
    buffer,
    u,
    wave: gl.getUniformLocation(program, "u_wave[0]"),
    drops: gl.getUniformLocation(program, "u_drops[0]"),
    bubbles: gl.getUniformLocation(program, "u_bubbles[0]"),
    bubbleShape: gl.getUniformLocation(program, "u_bubShape[0]"),
  };
}

function traceCapsule(
  ctx: CanvasRenderingContext2D,
  cx: number,
  rSide: number,
  topY: number,
  botY: number,
  corner: number,
) {
  const r = Math.min(corner, rSide);
  ctx.beginPath();
  ctx.roundRect(cx - rSide, topY, rSide * 2, botY - topY, r);
}

function traceLiquidColumn(
  ctx: CanvasRenderingContext2D,
  cx: number,
  rSide: number,
  topLeftY: number,
  topRightY: number,
  floorY: number,
  corner: number,
) {
  const rc = Math.min(corner, rSide);
  const leftX = cx - rSide;
  const rightX = cx + rSide;
  ctx.beginPath();
  ctx.moveTo(leftX, topLeftY);
  ctx.lineTo(leftX, Math.max(topLeftY, floorY - rc));
  ctx.arcTo(leftX, floorY, leftX + rc, floorY, rc);
  ctx.lineTo(rightX - rc, floorY);
  ctx.arcTo(rightX, floorY, rightX, Math.max(topRightY, floorY - rc), rc);
  ctx.lineTo(rightX, topRightY);
  ctx.closePath();
}

type ToneTable = Record<VialAccent, { readonly dark: string; readonly light: string }>;
const pick = (table: ToneTable, accent: VialAccent, isDark: boolean) =>
  table[accent][isDark ? "dark" : "light"];

const BLADE: ToneTable = {
  mono: { dark: "rgba(244, 244, 245, 0.94)", light: "rgba(39, 39, 42, 0.96)" },
  amber: { dark: "rgba(253, 224, 71, 0.94)", light: "rgba(180, 83, 9, 0.96)" },
  iris: { dark: "rgba(221, 214, 254, 0.94)", light: "rgba(109, 40, 217, 0.96)" },
  cobalt: { dark: "rgba(176, 224, 255, 0.94)", light: "rgba(3, 105, 161, 0.96)" },
};
const MENISCUS_FILL: ToneTable = {
  mono: { dark: "rgba(212, 212, 216, 0.32)", light: "rgba(82, 82, 91, 0.48)" },
  amber: { dark: "rgba(251, 191, 36, 0.36)", light: "rgba(217, 119, 6, 0.50)" },
  iris: { dark: "rgba(196, 181, 253, 0.36)", light: "rgba(124, 58, 237, 0.50)" },
  cobalt: { dark: "rgba(92, 198, 252, 0.36)", light: "rgba(2, 132, 199, 0.56)" },
};
const MENISCUS_BACK: ToneTable = {
  mono: { dark: "rgba(228, 228, 231, 0.42)", light: "rgba(63, 63, 70, 0.56)" },
  amber: { dark: "rgba(253, 224, 71, 0.42)", light: "rgba(180, 83, 9, 0.56)" },
  iris: { dark: "rgba(221, 214, 254, 0.44)", light: "rgba(109, 40, 217, 0.56)" },
  cobalt: { dark: "rgba(176, 224, 255, 0.44)", light: "rgba(29, 78, 216, 0.58)" },
};
const OUTLINE: ToneTable = {
  mono: { dark: "rgba(212, 212, 216, 0.68)", light: "rgba(82, 82, 91, 0.68)" },
  amber: { dark: "rgba(251, 191, 36, 0.62)", light: "rgba(146, 64, 14, 0.68)" },
  iris: { dark: "rgba(196, 181, 253, 0.64)", light: "rgba(91, 33, 182, 0.68)" },
  cobalt: { dark: "rgba(172, 204, 248, 0.68)", light: "rgba(30, 64, 175, 0.68)" },
};
const GLASS_EDGE_LIGHT: Record<VialAccent, string> = {
  mono: "rgba(63, 63, 70, 0.30)",
  amber: "rgba(146, 64, 14, 0.30)",
  iris: "rgba(91, 33, 182, 0.30)",
  cobalt: "rgba(30, 64, 175, 0.32)",
};
const AIR_RIM_LIGHT: Record<VialAccent, string> = {
  mono: "rgba(82, 82, 91, 0.28)",
  amber: "rgba(146, 64, 14, 0.26)",
  iris: "rgba(91, 33, 182, 0.26)",
  cobalt: "rgba(30, 64, 175, 0.28)",
};
const THREAD_LIGHT: Record<VialAccent, string> = {
  mono: "rgba(82, 82, 91, 0.34)",
  amber: "rgba(180, 83, 9, 0.32)",
  iris: "rgba(109, 40, 217, 0.32)",
  cobalt: "rgba(30, 64, 175, 0.34)",
};
const BUBBLE_RIM_LIGHT: Record<VialAccent, string> = {
  mono: "rgba(63, 63, 70, 0.68)",
  amber: "rgba(180, 83, 9, 0.68)",
  iris: "rgba(109, 40, 217, 0.68)",
  cobalt: "rgba(29, 78, 216, 0.68)",
};
const TICK_ACTIVE: Record<
  VialAccent,
  { readonly dark: readonly string[]; readonly light: readonly string[] }
> = {
  mono: { dark: ["#71717A", "#A1A1AA", "#E4E4E7"], light: ["#3F3F46", "#52525B", "#71717A"] },
  amber: { dark: ["#B45309", "#D97706", "#FBBF24"], light: ["#92400E", "#B45309", "#D97706"] },
  iris: { dark: ["#6D28D9", "#8B5CF6", "#C4B5FD"], light: ["#5B21B6", "#7C3AED", "#9333EA"] },
  cobalt: { dark: ["#2A6EE8", "#3186FF", "#5CC6FC"], light: ["#1D4ED8", "#2563EB", "#0284C7"] },
};
const TICK_GLOW: ToneTable = {
  mono: { dark: "rgba(161, 161, 170, 0.20)", light: "rgba(161, 161, 170, 0.20)" },
  amber: { dark: "rgba(217, 119, 6, 0.18)", light: "rgba(217, 119, 6, 0.18)" },
  iris: { dark: "rgba(139, 92, 246, 0.18)", light: "rgba(139, 92, 246, 0.18)" },
  cobalt: { dark: "rgba(92, 198, 252, 0.18)", light: "rgba(37, 99, 235, 0.16)" },
};
const LIQUID_STOPS: Record<
  VialAccent,
  {
    readonly dark: ReadonlyArray<readonly [number, string]>;
    readonly light: ReadonlyArray<readonly [number, string]>;
  }
> = {
  mono: {
    dark: [
      [0, "rgba(24, 24, 27, 0.92)"],
      [0.45, "rgba(82, 82, 91, 0.90)"],
      [1, "rgba(212, 212, 216, 0.90)"],
    ],
    light: [
      [0, "rgba(39, 39, 42, 0.94)"],
      [0.52, "rgba(82, 82, 91, 0.93)"],
      [1, "rgba(113, 113, 122, 0.94)"],
    ],
  },
  amber: {
    dark: [
      [0, "rgba(69, 26, 3, 0.92)"],
      [0.45, "rgba(180, 83, 9, 0.90)"],
      [1, "rgba(251, 191, 36, 0.90)"],
    ],
    light: [
      [0, "rgba(146, 64, 14, 0.94)"],
      [0.52, "rgba(217, 119, 6, 0.93)"],
      [1, "rgba(245, 158, 11, 0.94)"],
    ],
  },
  iris: {
    dark: [
      [0, "rgba(46, 16, 101, 0.92)"],
      [0.45, "rgba(109, 40, 217, 0.90)"],
      [1, "rgba(196, 181, 253, 0.90)"],
    ],
    light: [
      [0, "rgba(91, 33, 182, 0.94)"],
      [0.52, "rgba(124, 58, 237, 0.93)"],
      [1, "rgba(168, 85, 247, 0.94)"],
    ],
  },
  cobalt: {
    dark: [
      [0, "rgba(15, 23, 58, 0.92)"],
      [0.36, "rgba(27, 73, 178, 0.90)"],
      [0.74, "rgba(49, 134, 255, 0.90)"],
      [1, "rgba(92, 198, 252, 0.90)"],
    ],
    light: [
      [0, "rgba(29, 78, 216, 0.94)"],
      [0.52, "rgba(37, 99, 235, 0.93)"],
      [1, "rgba(2, 132, 199, 0.94)"],
    ],
  },
};
const CRITICAL_STOPS = {
  dark: [
    [0, "rgba(92, 37, 9, 0.92)"],
    [0.38, "rgba(189, 84, 19, 0.90)"],
    [0.75, "rgba(241, 153, 18, 0.90)"],
    [1, "rgba(254, 213, 79, 0.90)"],
  ],
  light: [
    [0, "rgba(124, 58, 237, 0.94)"],
    [0.52, "rgba(234, 88, 12, 0.93)"],
    [1, "rgba(245, 158, 11, 0.94)"],
  ],
} as const;
// Near full, the daylight cobalt column warms toward violet as an early warning.
const HIGH_LOAD_STOPS = [
  [0, "#1D4ED8"],
  [0.55, "#4F46E5"],
  [1, "#7C3AED"],
] as const;

/** Glass capsule on a 2D canvas: the liquid comes from an offscreen WebGL2 pass, the ticks stay 2D. */
export function mountOpticalVial(
  canvas: HTMLCanvasElement,
  options: OpticalVialOptions,
): OpticalVial {
  const ctx = canvas.getContext("2d");
  const physics = createVialPhysics({
    fill: options.getState().fill,
    streaming: options.getState().streaming,
  });
  const dropData = new Float32Array(16);
  const bubbleData = new Float32Array(32);
  const bubbleShape = new Float32Array(16);
  const gradients = new Map<string, CanvasGradient>();
  let cssWidth = canvas.clientWidth;
  let cssHeight = canvas.clientHeight;
  let glCanvas: HTMLCanvasElement | null = null;
  let glState: VialGlState | null = null;
  let elapsed = 0;
  let settleClock = 0;
  let dirty = true;
  let renderedKey = "";
  let lastPointer: { x: number; y: number } | null = null;
  let disposed = false;

  const notifyWake = () => {
    dirty = true;
    options.onWake?.();
  };

  const tryBuildGl = () => {
    if (!glCanvas) return;
    try {
      const gl = glCanvas.getContext("webgl2", GL_ATTRIBUTES);
      glState = gl ? buildVialGl(gl) : null;
    } catch {
      glState = null;
    }
  };
  const onGlLost = (event: Event) => {
    event.preventDefault();
    glState = null;
    notifyWake();
  };
  const onGlRestored = () => {
    tryBuildGl();
    notifyWake();
  };
  if (ctx && !options.force2D) {
    glCanvas = canvas.ownerDocument.createElement("canvas");
    glCanvas.addEventListener("webglcontextlost", onGlLost);
    glCanvas.addEventListener("webglcontextrestored", onGlRestored);
    tryBuildGl();
  }

  const activeView = (state: VialVisualState = options.getState()) =>
    state.tickLabels ? VIEW_LABELED : VIEW_COMPACT;

  const layout = (state: VialVisualState = options.getState()) => {
    const view = activeView(state);
    const scale = Math.max(0.01, Math.min(cssWidth / view.w, cssHeight / view.h));
    return {
      view,
      scale,
      width: view.w * scale,
      height: view.h * scale,
      left: (cssWidth - view.w * scale) / 2,
      top: (cssHeight - view.h * scale) / 2,
    };
  };

  const toDesign = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const { view, scale, left, top } = layout();
    const x = view.x + (event.clientX - rect.left - left) / scale;
    const y = view.y + (event.clientY - rect.top - top) / scale;
    return {
      normX: (x - TUBE_X) / TUBE_IN_R,
      normY: (y - CHAMBER_TOP) / (HEM_Y - LIP_Y + 6),
      scale,
    };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (options.getState().reduceMotion) return;
    const at = toDesign(event);
    if (!at) return;
    if (lastPointer) {
      const vx = clamp((event.clientX - lastPointer.x) / at.scale, -24, 24);
      const vy = clamp((event.clientY - lastPointer.y) / at.scale, -24, 24);
      physics.injectFingerPoke(at.normX, at.normY, vx, vy);
      notifyWake();
    }
    lastPointer = { x: event.clientX, y: event.clientY };
  };
  const onPointerDown = (event: PointerEvent) => {
    if (options.getState().reduceMotion) return;
    const at = toDesign(event);
    if (!at) return;
    physics.injectFingerPoke(at.normX, at.normY, (Math.random() - 0.5) * 8, -4);
    physics.injectSlosh(at.normX >= 0 ? 1.25 : -1.25);
    notifyWake();
  };
  const onPointerLeave = () => {
    lastPointer = null;
  };
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerleave", onPointerLeave);

  const visualKey = (state: VialVisualState) => {
    const ratios = state.ratios ?? DEFAULT_RATIOS;
    const labels = state.tickLabels ? state.tickLabels.join(",") : "";
    return `${state.isDark}|${state.critical}|${state.accent}|${state.camp ?? "gemini"}|${state.hoveredSlice ?? -1}|${ratios[0].toFixed(3)},${ratios[1].toFixed(3)},${ratios[2].toFixed(3)}|${labels}|${clampFill(state.fill).toFixed(4)}|${cssWidth}x${cssHeight}`;
  };

  const cachedGradient = (key: string, build: () => CanvasGradient) => {
    let gradient = gradients.get(key);
    if (!gradient) {
      gradient = build();
      gradients.set(key, gradient);
    }
    return gradient;
  };

  function drawFallback(context: CanvasRenderingContext2D, state: VialVisualState, fill: number) {
    const { isDark, accent, critical } = state;
    const mono = accent === "mono";
    const surfaceY = physics.surfacePixelY();
    const tilt = physics.snapshot().tiltAngle;
    const slope = Math.tan(tilt) * TUBE_IN_R;
    const blade = critical
      ? isDark
        ? "rgba(255, 236, 168, 0.94)"
        : "rgba(234, 88, 12, 0.96)"
      : pick(BLADE, accent, isDark);

    traceCapsule(context, TUBE_X, TUBE_OUT_R, TOP_OUT, FLOOR_OUT, RC_OUT);
    context.fillStyle = isDark
      ? mono
        ? "rgba(24, 24, 27, 0.14)"
        : "rgba(11, 16, 30, 0.12)"
      : cachedGradient(`air:${accent}`, () => {
          const air = context.createLinearGradient(TUBE_X - TUBE_OUT_R, 0, TUBE_X + TUBE_OUT_R, 0);
          const rim = AIR_RIM_LIGHT[accent];
          const mid = mono
            ? "rgba(244, 244, 245, 0.34)"
            : accent === "amber"
              ? "rgba(254, 243, 199, 0.32)"
              : "rgba(224, 235, 250, 0.36)";
          air.addColorStop(0, rim);
          air.addColorStop(0.14, mid);
          air.addColorStop(0.5, mono ? "rgba(244, 244, 245, 0.26)" : "rgba(224, 235, 250, 0.28)");
          air.addColorStop(0.86, mid);
          air.addColorStop(1, rim);
          return air;
        });
    context.fill();

    if (surfaceY < FLOOR_IN - 0.5) {
      const liquid = context.createLinearGradient(
        TUBE_X,
        FLOOR_IN,
        TUBE_X,
        Math.min(FLOOR_IN - 6, surfaceY),
      );
      const stops = critical
        ? CRITICAL_STOPS[isDark ? "dark" : "light"]
        : !isDark && accent === "cobalt" && fill >= 0.72
          ? HIGH_LOAD_STOPS
          : LIQUID_STOPS[accent][isDark ? "dark" : "light"];
      for (const [offset, color] of stops) liquid.addColorStop(offset, color);
      traceLiquidColumn(
        context,
        TUBE_X,
        TUBE_IN_R,
        surfaceY - slope,
        surfaceY + slope,
        FLOOR_IN,
        RC_IN,
      );
      context.fillStyle = liquid;
      context.fill();
      // A horizontal sheen over the column reads as the cylinder's curvature.
      context.fillStyle = cachedGradient(`cyl:${isDark}:${accent}`, () => {
        const sheen = context.createLinearGradient(TUBE_X - TUBE_IN_R, 0, TUBE_X + TUBE_IN_R, 0);
        const edgeLight = GLASS_EDGE_LIGHT[accent];
        const edgeDark = mono ? "24, 24, 27" : "15, 23, 58";
        sheen.addColorStop(0, isDark ? `rgba(${edgeDark}, 0.58)` : edgeLight);
        sheen.addColorStop(0.24, "rgba(255, 255, 255, 0.08)");
        sheen.addColorStop(
          0.5,
          isDark
            ? mono
              ? "rgba(228, 228, 231, 0.14)"
              : "rgba(168, 220, 255, 0.14)"
            : "rgba(255, 255, 255, 0.22)",
        );
        const cobaltLight = accent === "cobalt";
        sheen.addColorStop(
          0.82,
          isDark ? `rgba(${edgeDark}, 0.38)` : cobaltLight ? "rgba(30, 64, 175, 0.20)" : edgeLight,
        );
        sheen.addColorStop(
          1,
          isDark ? `rgba(${edgeDark}, 0.64)` : cobaltLight ? "rgba(30, 64, 175, 0.34)" : edgeLight,
        );
        return sheen;
      });
      context.fill();
    }

    context.fillStyle = isDark ? "rgba(176, 224, 255, 0.50)" : "rgba(255, 255, 255, 0.68)";
    for (let sy = surfaceY + 7; sy < FLOOR_IN - 6; sy += 7.5) {
      for (let sx = -TUBE_IN_R + 6; sx <= TUBE_IN_R - 6; sx += 6.2) {
        if (((Math.round(sx + sy) * 37) & 3) === 0) continue;
        context.beginPath();
        context.ellipse(TUBE_X + sx, sy, 0.7, 0.7, 0, 0, Math.PI * 2);
        context.fill();
      }
    }

    for (const bubble of physics.bubbles.slice(0, 8)) {
      if (bubble.y <= surfaceY + 2) continue;
      const radius = Math.max(0.85, bubble.r * 0.7);
      context.fillStyle = isDark ? "rgba(220, 242, 255, 0.84)" : "rgba(240, 249, 255, 0.92)";
      context.beginPath();
      context.ellipse(TUBE_X + bubble.x, bubble.y, radius, radius, 0, 0, Math.PI * 2);
      context.fill();
      if (isDark) continue;
      context.strokeStyle = critical ? "rgba(194, 65, 12, 0.72)" : BUBBLE_RIM_LIGHT[accent];
      context.lineWidth = 0.65;
      context.stroke();
    }
    for (const drop of physics.fallingDrops.slice(0, MAX_DROPS)) {
      context.fillStyle = blade;
      context.beginPath();
      context.ellipse(TUBE_X + drop.x, drop.y, drop.r * 0.75, drop.r * 1.15, 0, 0, Math.PI * 2);
      context.fill();
    }

    context.save();
    context.translate(TUBE_X, surfaceY);
    context.rotate(tilt);
    context.fillStyle = critical ? "rgba(234, 88, 12, 0.44)" : pick(MENISCUS_FILL, accent, isDark);
    context.beginPath();
    context.ellipse(0, 0, TUBE_IN_R - 0.3, 4, 0, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = pick(MENISCUS_BACK, accent, isDark);
    context.lineWidth = 0.75;
    context.beginPath();
    context.ellipse(0, 0, TUBE_IN_R - 0.3, 4, 0, Math.PI, Math.PI * 2);
    context.stroke();
    context.strokeStyle = blade;
    context.lineWidth = 1.15;
    context.beginPath();
    context.ellipse(0, 0, TUBE_IN_R - 0.3, 4, 0, 0, Math.PI);
    context.stroke();
    context.restore();

    const threadX = TUBE_X - TUBE_OUT_R * 0.72;
    const threadTop = TOP_OUT + 16;
    const threadBottom = FLOOR_OUT - 16;
    if (isDark) {
      context.fillStyle = "rgba(200, 226, 255, 0.32)";
      context.fillRect(threadX, threadTop, 0.8, threadBottom - threadTop);
    } else {
      // Above the liquid the thread refracts cool; below it, it catches a white highlight.
      const split = clamp(surfaceY, threadTop, threadBottom);
      context.fillStyle = THREAD_LIGHT[accent];
      context.fillRect(threadX, threadTop, 0.85, split - threadTop);
      context.fillStyle = "rgba(255, 255, 255, 0.58)";
      context.fillRect(threadX + 1, split, 0.85, threadBottom - split);
    }

    traceCapsule(context, TUBE_X, TUBE_OUT_R, TOP_OUT, FLOOR_OUT, RC_OUT);
    context.strokeStyle = pick(OUTLINE, accent, isDark);
    context.lineWidth = isDark ? 1 : 1.15;
    context.stroke();
  }

  // Ticks are snapped to whole device pixels; scaled with the design they would smear.
  function drawTicks(
    context: CanvasRenderingContext2D,
    state: VialVisualState,
    fill: number,
    toDeviceX: (x: number) => number,
    toDeviceY: (y: number) => number,
    unit: number,
  ) {
    const { isDark, accent, critical } = state;
    const tickX = Math.round(toDeviceX(TUBE_X + TUBE_OUT_R + 2.4));
    const chamber = CHAMBER_BOTTOM - CHAMBER_TOP;
    const thickness = Math.max(1, Math.round(unit));
    const rowAt = (fraction: number) => Math.round(toDeviceY(CHAMBER_BOTTOM - fraction * chamber));
    context.fillStyle = isDark ? "rgba(168, 190, 224, 0.18)" : "rgba(30, 41, 59, 0.24)";
    for (const fraction of [0.125, 0.375, 0.625, 0.875]) {
      context.fillRect(tickX, rowAt(fraction), Math.max(1, Math.round(2 * unit)), thickness);
    }
    const active = TICK_ACTIVE[accent][isDark ? "dark" : "light"];
    const major = Math.max(2, Math.round(3.5 * unit));
    const labels = state.tickLabels;
    const labelX = tickX + major + Math.max(2, Math.round(2.5 * unit));
    if (labels) {
      context.save();
      context.font = `500 ${Math.max(8, Math.round(8.5 * unit))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.textBaseline = "middle";
      context.textAlign = "left";
    }
    [0.25, 0.5, 0.75].forEach((fraction, index) => {
      const row = rowAt(fraction);
      const reached = fill >= fraction - 0.012;
      if (reached) {
        context.fillStyle = critical ? "rgba(234, 88, 12, 0.20)" : pick(TICK_GLOW, accent, isDark);
        context.fillRect(tickX - thickness, row - thickness, major + thickness * 2, thickness * 3);
      }
      context.fillStyle = !reached
        ? isDark
          ? "rgba(172, 194, 228, 0.28)"
          : "rgba(30, 41, 59, 0.38)"
        : critical
          ? isDark
            ? "#F59E0B"
            : "#EA580C"
          : (active[index] ?? "#3186FF");
      context.fillRect(tickX, row, major, thickness);
      const label = labels?.[index];
      if (label) {
        context.fillStyle = reached
          ? isDark
            ? "rgba(226, 236, 250, 0.82)"
            : "rgba(15, 23, 42, 0.78)"
          : isDark
            ? "rgba(168, 186, 214, 0.44)"
            : "rgba(30, 41, 59, 0.52)";
        context.fillText(label, labelX, row + Math.round(0.5 * thickness));
      }
    });
    if (labels) context.restore();
  }

  function render(state: VialVisualState) {
    if (!ctx || cssWidth <= 0 || cssHeight <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const targetW = Math.max(1, Math.round(cssWidth * dpr));
    const targetH = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const frameLayout = layout(state);
    const { view } = frameLayout;
    const unit = frameLayout.scale * dpr;
    const snap = physics.snapshot();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, targetW, targetH);

    if (glState?.gl.isContextLost()) glState = null;
    if (glState && glCanvas) {
      const { gl, u } = glState;
      const glW = Math.max(1, Math.round(frameLayout.width * dpr));
      const glH = Math.max(1, Math.round(frameLayout.height * dpr));
      if (glCanvas.width !== glW || glCanvas.height !== glH) {
        glCanvas.width = glW;
        glCanvas.height = glH;
      }
      dropData.fill(0);
      physics.fallingDrops.slice(0, MAX_DROPS).forEach((drop, i) => {
        dropData.set([drop.x, drop.y, drop.r, 1], i * 4);
      });
      bubbleData.fill(0);
      physics.bubbles.slice(0, 8).forEach((bubble, i) => {
        bubbleData.set([bubble.x, bubble.y, bubble.r, bubble.alpha], i * 4);
        bubbleShape.set([bubble.aspect, snap.tiltAngle], i * 2);
      });
      const accent =
        state.accent === "mono"
          ? 3
          : state.accent === "amber"
            ? 2
            : state.accent === "iris"
              ? 1
              : 0;
      const ratios = state.ratios ?? DEFAULT_RATIOS;
      gl.viewport(0, 0, glW, glH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(glState.program);
      gl.uniform4f(u.u_view, view.x, view.y, view.w, view.h);
      gl.uniform1f(u.u_time, elapsed);
      gl.uniform1f(u.u_dark, state.isDark ? 1 : 0);
      gl.uniform1f(u.u_fill, snap.fill);
      gl.uniform1f(u.u_tilt, snap.tiltAngle);
      gl.uniform1f(u.u_camp, state.camp === "claude" ? 1 : 0);
      gl.uniform1f(u.u_accent, accent);
      gl.uniform1f(u.u_critical, state.critical ? 1 : 0);
      gl.uniform1f(u.u_wetL, snap.wetLeft);
      gl.uniform1f(u.u_wetR, snap.wetRight);
      gl.uniform1f(u.u_hoverSlice, state.hoveredSlice ?? -1);
      gl.uniform3f(u.u_ratios, ratios[0], ratios[1], ratios[2]);
      gl.uniform1fv(glState.wave, physics.waveH);
      gl.uniform4fv(glState.drops, dropData);
      gl.uniform4fv(glState.bubbles, bubbleData);
      gl.uniform2fv(glState.bubbleShape, bubbleShape);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      ctx.drawImage(
        glCanvas,
        frameLayout.left * dpr,
        frameLayout.top * dpr,
        frameLayout.width * dpr,
        frameLayout.height * dpr,
      );
    } else {
      ctx.save();
      ctx.setTransform(
        unit,
        0,
        0,
        unit,
        (frameLayout.left - view.x * frameLayout.scale) * dpr,
        (frameLayout.top - view.y * frameLayout.scale) * dpr,
      );
      drawFallback(ctx, state, snap.fill);
      ctx.restore();
    }

    drawTicks(
      ctx,
      state,
      snap.fill,
      (x) => (frameLayout.left + (x - view.x) * frameLayout.scale) * dpr,
      (y) => (frameLayout.top + (y - view.y) * frameLayout.scale) * dpr,
      unit,
    );
    renderedKey = visualKey(state);
    dirty = false;
  }

  render(options.getState());

  return {
    rendererMode: () => (glState ? "webgl2" : "2d"),
    resize(width, height) {
      if (width === cssWidth && height === cssHeight) return;
      cssWidth = width;
      cssHeight = height;
      gradients.clear();
      notifyWake();
    },
    step(dtSec) {
      if (disposed) return;
      const state = options.getState();
      physics.setStreaming(state.streaming && !state.reduceMotion);
      if (state.reduceMotion) {
        physics.snapFill(state.fill);
      } else {
        const dt = clamp(Number.isFinite(dtSec) ? dtSec : 0.016, 0.001, MAX_FRAME_DT);
        physics.setTargetFill(state.fill);
        elapsed += dt;
        settleClock += dt;
        physics.step(dt);
      }
      render(state);
    },
    isSettled() {
      if (dirty) return false;
      const state = options.getState();
      if (visualKey(state) !== renderedKey) return false;
      if (state.reduceMotion) return true;
      if (state.streaming || settleClock < SETTLE_MIN_AGE_SEC) return false;
      return (
        Math.abs(clampFill(state.fill) - physics.snapshot().fill) < 0.001 && physics.isSettled()
      );
    },
    wake: notifyWake,
    agitate(strength = 1.6) {
      physics.injectSlosh(strength);
      notifyWake();
    },
    reclaim() {
      canvas.width = 0;
      canvas.height = 0;
      if (glCanvas) {
        glCanvas.width = 0;
        glCanvas.height = 0;
      }
      dirty = true;
    },
    dispose() {
      disposed = true;
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      glCanvas?.removeEventListener("webglcontextlost", onGlLost);
      glCanvas?.removeEventListener("webglcontextrestored", onGlRestored);
      if (glState) {
        const { gl, program, buffer } = glState;
        gl.deleteProgram(program);
        gl.deleteBuffer(buffer);
        // Browsers cap live WebGL contexts per page, so release this one instead of waiting for GC.
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        glState = null;
      }
      glCanvas = null;
    },
  };
}
