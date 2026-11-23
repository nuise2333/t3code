import {
  HORIZON_STATIC_BREATH,
  HORIZON_STATIC_FLOW_SEC,
  HORIZON_STRETCH,
  HORIZON_TIME_OFFSET_SEC,
  advanceSemanticMix,
  encodeSemanticUniform,
  horizonBreath,
  horizonPresenceGain,
  type AuraSemantic,
} from "./auraPhase";
import type { OpticalSpectrumCode, Rgb } from "./config";
import { RIPPLE, fractalNoise, hash, smooth, valueNoise, type WaveField } from "./waveField";

type MutableRgb = [number, number, number];
type Stops4 = readonly [Rgb, Rgb, Rgb, Rgb];
type Stops5 = readonly [Rgb, Rgb, Rgb, Rgb, Rgb];
type RendererMode = "webgl2" | "2d" | "none";

const DIGITS = "0123456789";
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GLYPHS = DIGITS + LETTERS;
const COVERAGE_TO_THRESHOLD = 0.39;
const INVISIBLE_ALPHA = 0.01;
const TAU = Math.PI * 2;
const PRISM_LEVELS = 7;
const HUE_LEVELS = 32;
const IDLE_REFRESH_MS = 40;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const GL_CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  preserveDrawingBuffer: false,
};

const GLYPH_SPECTRA_DARK: Record<OpticalSpectrumCode, Stops4> = {
  0: [
    [66, 133, 244],
    [155, 114, 203],
    [234, 67, 53],
    [251, 188, 4],
  ],
  1: [
    [148, 74, 52],
    [217, 119, 87],
    [238, 155, 122],
    [246, 189, 96],
  ],
  2: [
    [27, 73, 178],
    [49, 134, 255],
    [92, 198, 252],
    [140, 224, 255],
  ],
  3: [
    [91, 33, 182],
    [139, 92, 246],
    [165, 138, 248],
    [221, 214, 254],
  ],
  4: [
    [146, 64, 14],
    [217, 119, 6],
    [242, 184, 75],
    [253, 230, 138],
  ],
  5: [
    [100, 116, 139],
    [148, 163, 184],
    [203, 213, 225],
    [241, 245, 249],
  ],
};

const GLYPH_SPECTRA_LIGHT: Record<OpticalSpectrumCode, Stops4> = {
  0: [
    [37, 99, 235],
    [124, 58, 237],
    [234, 67, 53],
    [217, 119, 6],
  ],
  1: [
    [154, 52, 18],
    [194, 89, 52],
    [217, 119, 87],
    [217, 119, 6],
  ],
  2: [
    [29, 78, 216],
    [37, 99, 235],
    [2, 132, 199],
    [56, 189, 248],
  ],
  3: [
    [76, 29, 149],
    [109, 40, 217],
    [124, 58, 237],
    [147, 51, 234],
  ],
  4: [
    [120, 53, 15],
    [180, 83, 9],
    [217, 119, 6],
    [234, 88, 12],
  ],
  5: [
    [30, 41, 59],
    [51, 65, 85],
    [71, 85, 105],
    [100, 116, 139],
  ],
};

function spectrumRgb(t: number, out: MutableRgb, dark: boolean, code: OpticalSpectrumCode) {
  const stops = (dark ? GLYPH_SPECTRA_DARK : GLYPH_SPECTRA_LIGHT)[code];
  let f = (t - Math.floor(t)) * 4;
  const i = Math.min(3, Math.floor(f));
  f -= i;
  const a = stops[i]!;
  const b = stops[(i + 1) & 3]!;
  out[0] = a[0] + (b[0] - a[0]) * f;
  out[1] = a[1] + (b[1] - a[1]) * f;
  out[2] = a[2] + (b[2] - a[2]) * f;
}

function glyphIndex(column: number, row: number, tick: number): number {
  const digit = hash(column * 7 + tick * 13, row * 11 + tick * 3) < RIPPLE.digitRatio;
  const pick = hash(column * 131 + tick, row * 197 + tick * 7);
  return digit
    ? Math.floor(pick * DIGITS.length)
    : DIGITS.length + Math.floor(pick * LETTERS.length);
}

function cloudClear(x: number, y: number): number {
  const noise = fractalNoise(x / RIPPLE.cloudScale, y / RIPPLE.cloudScale);
  const threshold = 0.5 + (RIPPLE.cloudCoverage - 0.5) * COVERAGE_TO_THRESHOLD;
  const cloud = smooth((noise - threshold + RIPPLE.cloudSoftness) / (2 * RIPPLE.cloudSoftness));
  return 0.22 + 0.78 * cloud;
}

function patchClear(x: number, y: number): number {
  const noise = fractalNoise(x / RIPPLE.patchScale + 31, y / RIPPLE.patchScale + 17);
  return RIPPLE.patchFloor + (1 - RIPPLE.patchFloor) * smooth((noise - 0.35) / 0.3);
}

interface NebulaLobe {
  x: number;
  y: number;
  radius: number;
  strength: number;
  hue: number;
}

const NEBULA_PHASES = [0.35, 2.45, 4.55] as const;
const NEBULA_ANGLES = [2.85, 0.52, 4.62] as const;
const NEBULA_HUES = [0.04, 0.54, 0.8] as const;

/** Three slow lobes orbit the field centre, each breathing on its own period. */
function computeNebulaLobes(
  seconds: number,
  width: number,
  height: number,
  still: boolean,
  out: readonly NebulaLobe[],
) {
  const t = still ? 2.4 : seconds;
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const diagonal = Math.sqrt(w * w + h * h);
  for (let i = 0; i < 3; i++) {
    const lobe = out[i]!;
    const raw = 0.5 + 0.5 * Math.sin((TAU * t) / RIPPLE.nebulaPeriods[i]! + NEBULA_PHASES[i]!);
    const envelope = raw * raw * (3 - 2 * raw);
    const strength = still ? 0.28 : 0.04 + 0.96 * envelope ** 1.3;
    const direction = i === 1 ? -1 : 1;
    const angle =
      NEBULA_ANGLES[i]! +
      0.52 * Math.sin(t * (0.13 + i * 0.023) + i * 1.7) +
      direction * t * (0.045 + i * 0.006);
    const ring = 0.34 + 0.045 * Math.cos(t * (0.11 + i * 0.019) + i * 1.1);
    lobe.x = (0.5 + ring * 1.06 * Math.cos(angle)) * w;
    lobe.y = (0.5 + ring * 0.92 * Math.sin(angle)) * h;
    lobe.radius = diagonal * (0.29 + 0.06 * strength);
    lobe.strength = strength;
    const hue = NEBULA_HUES[i]! + 0.14 * Math.sin(t * 0.09 + i * 2.1);
    lobe.hue = hue - Math.floor(hue);
  }
}

const VERTEX_SHADER = `#version 300 es
void main() {
vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const GLYPH_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D cells;
uniform sampler2D atlas;
uniform vec2 size;
uniform vec2 grid;
uniform vec2 cellPixels;
uniform vec2 atlasCell;
uniform float glyphCount;
uniform vec3 ink;
uniform vec3 wave;
uniform vec4 aura;
uniform vec4 optics;
uniform float auraLift;
uniform float auraPhase;
uniform float lightMode;
uniform vec4 neb0;
uniform vec4 neb1;
uniform vec4 neb2;
uniform vec4 nebOpt;
uniform float nebulaLift;
uniform float spectrumMode;
out vec4 color;
const vec3 COBALT = vec3(66.0 / 255.0, 133.0 / 255.0, 244.0 / 255.0);
const vec3 IRIS = vec3(155.0 / 255.0, 114.0 / 255.0, 203.0 / 255.0);
const vec3 CORAL = vec3(234.0 / 255.0, 67.0 / 255.0, 53.0 / 255.0);
const vec3 AMBER = vec3(251.0 / 255.0, 188.0 / 255.0, 4.0 / 255.0);
const vec3 COBALT_L = vec3(37.0 / 255.0, 99.0 / 255.0, 235.0 / 255.0);
const vec3 IRIS_L = vec3(124.0 / 255.0, 58.0 / 255.0, 237.0 / 255.0);
const vec3 CORAL_L = vec3(234.0 / 255.0, 67.0 / 255.0, 53.0 / 255.0);
const vec3 AMBER_L = vec3(217.0 / 255.0, 119.0 / 255.0, 6.0 / 255.0);
vec3 spectrum(float t, float light, float mode) {
float f = fract(t) * 4.0;
vec3 c0 = COBALT; vec3 c1 = IRIS; vec3 c2 = CORAL; vec3 c3 = AMBER;
vec3 l0 = COBALT_L; vec3 l1 = IRIS_L; vec3 l2 = CORAL_L; vec3 l3 = AMBER_L;
if (mode > 4.5) {
c0 = vec3(0.392, 0.455, 0.545); c1 = vec3(0.580, 0.639, 0.722); c2 = vec3(0.796, 0.835, 0.882); c3 = vec3(0.945, 0.961, 0.976);
l0 = vec3(0.118, 0.161, 0.231); l1 = vec3(0.200, 0.255, 0.333); l2 = vec3(0.278, 0.333, 0.412); l3 = vec3(0.392, 0.455, 0.545);
} else if (mode > 3.5) {
c0 = vec3(0.573, 0.251, 0.055); c1 = vec3(0.851, 0.467, 0.024); c2 = vec3(0.949, 0.722, 0.294); c3 = vec3(0.992, 0.902, 0.541);
l0 = vec3(0.471, 0.208, 0.059); l1 = vec3(0.706, 0.325, 0.035); l2 = vec3(0.851, 0.467, 0.024); l3 = vec3(0.918, 0.345, 0.047);
} else if (mode > 2.5) {
c0 = vec3(0.357, 0.129, 0.714); c1 = vec3(0.545, 0.361, 0.965); c2 = vec3(0.647, 0.541, 0.973); c3 = vec3(0.867, 0.839, 0.996);
l0 = vec3(0.298, 0.114, 0.584); l1 = vec3(0.427, 0.157, 0.851); l2 = vec3(0.486, 0.227, 0.929); l3 = vec3(0.576, 0.200, 0.918);
} else if (mode > 1.5) {
c0 = vec3(0.106, 0.286, 0.698); c1 = vec3(0.192, 0.525, 1.000); c2 = vec3(0.361, 0.776, 0.988); c3 = vec3(0.549, 0.878, 1.000);
l0 = vec3(0.114, 0.306, 0.847); l1 = vec3(0.145, 0.388, 0.922); l2 = vec3(0.008, 0.518, 0.780); l3 = vec3(0.220, 0.741, 0.973);
} else if (mode > 0.5) {
c0 = vec3(0.580, 0.290, 0.204); c1 = vec3(0.851, 0.467, 0.341); c2 = vec3(0.933, 0.608, 0.478); c3 = vec3(0.965, 0.741, 0.376);
l0 = vec3(0.604, 0.204, 0.071); l1 = vec3(0.761, 0.349, 0.204); l2 = vec3(0.851, 0.467, 0.341); l3 = vec3(0.851, 0.467, 0.024);
}
vec3 d;
vec3 l;
if (f < 1.0) { d = mix(c0, c1, f); l = mix(l0, l1, f); }
else if (f < 2.0) { d = mix(c1, c2, f - 1.0); l = mix(l1, l2, f - 1.0); }
else if (f < 3.0) { d = mix(c2, c3, f - 2.0); l = mix(l2, l3, f - 2.0); }
else { d = mix(c3, c0, f - 3.0); l = mix(l3, l0, f - 3.0); }
return mix(d, l, light);
}
void main() {
vec2 position = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y);
vec2 cell = min(floor(position / cellPixels), grid - 1.0);
vec4 data = texelFetch(cells, ivec2(cell), 0);
if (data.g <= 0.0) { color = vec4(0.0); return; }
vec2 local = position - cell * cellPixels;
float glyph = floor(data.r * 255.0 + 0.5);
vec2 inAtlas = vec2(glyph * atlasCell.x + local.x * atlasCell.x / cellPixels.x, local.y * atlasCell.y / cellPixels.y);
float coverage = texture(atlas, inAtlas / vec2(glyphCount * atlasCell.x, atlasCell.y)).a;
if (coverage <= 0.001) { color = vec4(0.0); return; }
vec3 rgb = mix(ink, wave, data.b);
float alpha = data.g;
float packed = floor(data.a * 255.0 + 0.5);
float level = floor(packed / 32.0);
float prismAmt = level / 7.0;
float hue = (packed - level * 32.0) / 32.0;
float wAura = 0.0;
vec3 auraRgb = COBALT;
if (aura.w > 0.001) {
vec2 rel = position - aura.xy;
float ar = max(1.0, aura.z);
if (abs(rel.x) < ar && abs(rel.y) < ar) {
float d2 = dot(rel, rel);
if (d2 < ar * ar) {
float rNorm = sqrt(d2) / ar;
float u = 1.0 - rNorm;
float s = u * u * (3.0 - 2.0 * u);
wAura = s * (0.35 + 0.65 * s);
float ang = atan(rel.y, rel.x + 1e-5) * 0.15915494 + 0.5;
auraRgb = spectrum(ang - rNorm * 0.45 + auraPhase, lightMode, spectrumMode);
}
}
}
float wNeb = 0.0;
vec3 nebAcc = vec3(0.0);
for (int i = 0; i < 3; i++) {
vec4 nb = i == 0 ? neb0 : (i == 1 ? neb1 : neb2);
float nh = i == 0 ? nebOpt.x : (i == 1 ? nebOpt.y : nebOpt.z);
if (nb.w > 0.001) {
vec2 nr = position - nb.xy;
float rad = max(1.0, nb.z);
if (abs(nr.x) < rad && abs(nr.y) < rad) {
float nd2 = dot(nr, nr);
if (nd2 < rad * rad) {
float rn = sqrt(nd2) / rad;
float u = 1.0 - rn;
float s = u * u * (3.0 - 2.0 * u);
float wi = s * (0.30 + 0.70 * s) * nb.w;
float nang = atan(nr.y, nr.x + 1e-5) * 0.15915494;
wNeb += wi;
nebAcc += spectrum(nh + nang * 0.22 - rn * 0.26, lightMode, spectrumMode) * wi;
}
}
}
}
vec3 nebRgb = wNeb > 0.0001 ? nebAcc / wNeb : COBALT;
float wNebC = min(1.0, wNeb);
float nebT = wNebC * nebOpt.w;
float auraT = wAura * optics.x * aura.w;
float prismT = prismAmt * optics.y * optics.w * (0.88 + 0.12 * wAura);
float total = auraT + prismT + nebT;
if (lightMode > 0.5) {
alpha = min(0.88, alpha * (1.0 + (auraLift + 0.72) * wAura * aura.w + prismT * 0.62 + nebulaLift * 0.66 * wNebC));
} else if (wAura > 0.0 || wNebC > 0.0) {
alpha = min(1.0, alpha * (1.0 + auraLift * wAura * aura.w + nebulaLift * wNebC));
}
if (total > 0.0001) {
float capped = min(optics.z, total);
float mixAmt = mix(capped, min(0.96, capped * 1.36), lightMode);
vec3 tintRgb = (auraRgb * auraT + spectrum(hue, lightMode, spectrumMode) * prismT + nebRgb * nebT) / total;
rgb = mix(rgb, tintRgb, mixAmt);
}
float a = alpha * coverage;
color = vec4(rgb * a, a);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
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
}

function linkFullscreenProgram(gl: WebGL2RenderingContext, fragmentSource: string): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("program allocation failed");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || "program link error";
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

function uniformLocations<Name extends string>(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: readonly Name[],
): Record<Name, WebGLUniformLocation | null> {
  const locations = {} as Record<Name, WebGLUniformLocation | null>;
  for (const name of names) locations[name] = gl.getUniformLocation(program, name);
  return locations;
}

function isCanvasDocHidden(canvas: HTMLCanvasElement): boolean {
  return canvas.ownerDocument.hidden;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

interface AuraSpot {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly strength: number;
}

export interface GlyphPalette {
  readonly dark: boolean;
  readonly ink: Rgb;
  readonly wave: Rgb;
  readonly fontFamily: string;
  readonly spectrumCode: OpticalSpectrumCode;
  readonly ambientIntensity: number;
  readonly prismStrength: number;
  /** Cursor aura in CSS pixels relative to the canvas, or null while the pointer is away. */
  readonly aura: AuraSpot | null;
  readonly auraPhase: number;
}

interface EffectivePalette {
  dark: boolean;
  ink: Rgb;
  wave: Rgb;
  fontFamily: string;
  spectrumCode: OpticalSpectrumCode;
  ambientIntensity: number;
  prismStrength: number;
  aura: AuraSpot | null;
  auraPhase: number;
  nebula: readonly NebulaLobe[] | null;
}

interface GlyphRenderer {
  readonly mode: "webgl2" | "2d";
  /** Per cell: glyph index, alpha, wave mix, and prism level (3 bits) packed with hue (5 bits). */
  readonly data: Uint8Array;
  build(): void;
  draw(palette: EffectivePalette, dpr: number, uploadCells: boolean): void;
  release(): void;
  dispose(): void;
}

function paintGlyphAtlas(
  atlas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  font: string,
  dpr: number,
): { width: number; height: number } {
  const { cellWidth, cellHeight } = RIPPLE;
  const width = Math.max(1, Math.ceil(cellWidth * dpr));
  const height = Math.max(1, Math.ceil(cellHeight * dpr));
  atlas.width = width * GLYPHS.length;
  atlas.height = height;
  context.setTransform(width / cellWidth, 0, 0, height / cellHeight, 0, 0);
  context.clearRect(0, 0, cellWidth * GLYPHS.length, cellHeight);
  context.font = `${RIPPLE.fontSize}px ${font}`;
  context.textBaseline = "middle";
  context.textAlign = "center";
  context.fillStyle = "#fff";
  for (let i = 0; i < GLYPHS.length; i++) {
    context.fillText(GLYPHS[i]!, i * cellWidth + cellWidth / 2, cellHeight / 2);
  }
  return { width, height };
}

const GLYPH_UNIFORMS = [
  "cells",
  "atlas",
  "size",
  "grid",
  "cellPixels",
  "atlasCell",
  "glyphCount",
  "ink",
  "wave",
  "aura",
  "optics",
  "auraLift",
  "auraPhase",
  "lightMode",
  "neb0",
  "neb1",
  "neb2",
  "nebOpt",
  "nebulaLift",
  "spectrumMode",
] as const;

function createGlyphGlRenderer(
  canvas: HTMLCanvasElement,
  columns: number,
  rows: number,
): GlyphRenderer | null {
  const gl = canvas.getContext("webgl2", GL_CONTEXT_ATTRIBUTES);
  if (!gl) return null;
  const atlasCanvas = canvas.ownerDocument.createElement("canvas");
  const atlasContext = atlasCanvas.getContext("2d");
  if (!atlasContext) return null;
  const data = new Uint8Array(columns * rows * 4);
  let program: WebGLProgram | null = null;
  let cellTexture: WebGLTexture | null = null;
  let atlasTexture: WebGLTexture | null = null;
  let uniforms: Record<(typeof GLYPH_UNIFORMS)[number], WebGLUniformLocation | null> | null = null;
  let atlasKey = "";

  const createTexture = (unit: number, filter: number): WebGLTexture | null => {
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  };

  const build = () => {
    program = linkFullscreenProgram(gl!, GLYPH_FRAGMENT_SHADER);
    gl.useProgram(program);
    uniforms = uniformLocations(gl!, program, GLYPH_UNIFORMS);
    cellTexture = createTexture(0, gl.NEAREST);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, columns, rows);
    atlasTexture = createTexture(1, gl.LINEAR);
    gl.uniform1i(uniforms.cells, 0);
    gl.uniform1i(uniforms.atlas, 1);
    atlasKey = "";
  };

  const buildAtlas = (font: string, dpr: number) => {
    const key = `${font}|${dpr}`;
    if (key === atlasKey || !uniforms) return;
    const cell = paintGlyphAtlas(atlasCanvas, atlasContext, font, dpr);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
    gl.uniform2f(uniforms.atlasCell, cell.width, cell.height);
    gl.uniform1f(uniforms.glyphCount, GLYPHS.length);
    atlasKey = key;
  };

  try {
    build();
  } catch {
    return null;
  }

  return {
    mode: "webgl2",
    data,
    build,
    draw(palette, dpr, uploadCells) {
      if (!uniforms || gl.isContextLost()) return;
      buildAtlas(palette.fontFamily, dpr);
      const amb = palette.ambientIntensity;
      const mono = palette.spectrumCode === 5;
      const aura = palette.aura;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniforms.size, canvas.width, canvas.height);
      gl.uniform2f(uniforms.grid, columns, rows);
      gl.uniform2f(uniforms.cellPixels, RIPPLE.cellWidth * dpr, RIPPLE.cellHeight * dpr);
      gl.uniform3f(uniforms.ink, palette.ink[0] / 255, palette.ink[1] / 255, palette.ink[2] / 255);
      gl.uniform3f(
        uniforms.wave,
        palette.wave[0] / 255,
        palette.wave[1] / 255,
        palette.wave[2] / 255,
      );
      gl.uniform4f(
        uniforms.aura,
        aura ? aura.x * dpr : 0,
        aura ? aura.y * dpr : 0,
        (aura ? aura.radius : RIPPLE.auraRadius) * dpr,
        aura ? aura.strength * amb : 0,
      );
      gl.uniform4f(
        uniforms.optics,
        RIPPLE.auraTint * (mono ? 0.55 : 1),
        RIPPLE.prismTint * (mono ? 0.45 : 1),
        RIPPLE.prismCap,
        palette.prismStrength,
      );
      gl.uniform1f(uniforms.auraLift, RIPPLE.auraLift * amb);
      gl.uniform1f(uniforms.auraPhase, palette.auraPhase);
      gl.uniform1f(uniforms.lightMode, palette.dark ? 0 : 1);
      gl.uniform1f(uniforms.spectrumMode, palette.spectrumCode);
      const lobes = palette.nebula;
      const lobeUniforms = [uniforms.neb0, uniforms.neb1, uniforms.neb2];
      for (let i = 0; i < 3; i++) {
        const lobe = lobes?.[i];
        gl.uniform4f(
          lobeUniforms[i]!,
          lobe ? lobe.x * dpr : 0,
          lobe ? lobe.y * dpr : 0,
          lobe ? lobe.radius * dpr : 1,
          lobe ? lobe.strength * amb : 0,
        );
      }
      gl.uniform4f(
        uniforms.nebOpt,
        lobes?.[0]?.hue ?? 0,
        lobes?.[1]?.hue ?? 0,
        lobes?.[2]?.hue ?? 0,
        RIPPLE.nebulaTint * amb * (mono ? 0.45 : 1),
      );
      gl.uniform1f(uniforms.nebulaLift, RIPPLE.nebulaLift * amb);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cellTexture);
      if (uploadCells) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, columns, rows, gl.RGBA, gl.UNSIGNED_BYTE, data);
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    release() {},
    dispose() {
      gl.deleteProgram(program);
      gl.deleteTexture(cellTexture);
      gl.deleteTexture(atlasTexture);
      uniforms = null;
    },
  };
}

interface ScaledLobe {
  x: number;
  y: number;
  r: number;
  r2: number;
  s: number;
  hue: number;
}

/** CPU path: the same per-cell shading as the shader, blitted through one ImageData. */
function createGlyph2dRenderer(
  canvas: HTMLCanvasElement,
  columns: number,
  rows: number,
): GlyphRenderer | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const atlas = canvas.ownerDocument.createElement("canvas");
  const atlasCtx = atlas.getContext("2d", { willReadFrequently: true });
  if (!atlasCtx) return null;
  const data = new Uint8Array(columns * rows * 4);
  const auraTint: MutableRgb = [0, 0, 0];
  const prismTint: MutableRgb = [0, 0, 0];
  const nebulaSample: MutableRgb = [0, 0, 0];
  const lobes: ScaledLobe[] = [0, 1, 2].map(() => ({ x: 0, y: 0, r: 1, r2: 1, s: 0, hue: 0 }));
  let mask: Uint8Array | null = null;
  let atlasKey = "";
  let gw = 1;
  let gh = 1;
  let image: ImageData | null = null;
  let pixels: Uint32Array | null = null;

  const buildAtlas = (font: string, dpr: number): Uint8Array => {
    const key = `${font}|${dpr}`;
    if (key === atlasKey && mask) return mask;
    const cell = paintGlyphAtlas(atlas, atlasCtx, font, dpr);
    gw = cell.width;
    gh = cell.height;
    const source = atlasCtx.getImageData(0, 0, atlas.width, gh).data;
    const stride = atlas.width;
    const next = new Uint8Array(GLYPHS.length * gw * gh);
    for (let g = 0; g < GLYPHS.length; g++) {
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          next[(g * gh + y) * gw + x] = source[(y * stride + g * gw + x) * 4 + 3]!;
        }
      }
    }
    mask = next;
    atlasKey = key;
    return next;
  };

  return {
    mode: "2d",
    data,
    build() {
      atlasKey = "";
    },
    draw(palette, dpr) {
      const glyphMask = buildAtlas(palette.fontFamily, dpr);
      if (!image || !pixels || image.width !== canvas.width || image.height !== canvas.height) {
        image = ctx.createImageData(Math.max(1, canvas.width), Math.max(1, canvas.height));
        pixels = new Uint32Array(image.data.buffer);
      }
      pixels.fill(0);
      const out = pixels;
      const W = image.width;
      const H = image.height;
      const { ink, wave } = palette;
      const isLight = !palette.dark;
      const amb = palette.ambientIntensity;
      const code = palette.spectrumCode;
      const mono = code === 5;
      const aura = palette.aura;
      const auraStrength = (aura?.strength ?? 0) * amb;
      const auraOn = auraStrength > 0.001;
      const ax = (aura?.x ?? 0) * dpr;
      const ay = (aura?.y ?? 0) * dpr;
      const ar = Math.max(1, aura?.radius ?? RIPPLE.auraRadius) * dpr;
      const ar2 = ar * ar;
      let activeLobes = 0;
      for (let i = 0; i < 3; i++) {
        const from = amb > 0.001 ? palette.nebula?.[i] : undefined;
        const to = lobes[i]!;
        if (from && from.strength * amb > 0.001) {
          to.x = from.x * dpr;
          to.y = from.y * dpr;
          to.r = Math.max(1, from.radius * dpr);
          to.r2 = to.r * to.r;
          to.s = from.strength * amb;
          to.hue = from.hue;
          activeLobes++;
        } else {
          to.s = 0;
        }
      }
      const auraTintScale = RIPPLE.auraTint * (mono ? 0.55 : 1);
      const nebulaTintScale = RIPPLE.nebulaTint * amb * (mono ? 0.45 : 1);
      const nebulaLiftScale = RIPPLE.nebulaLift * amb;
      const prismGain = RIPPLE.prismTint * palette.prismStrength * (mono ? 0.45 : 1);
      const stepX = RIPPLE.cellWidth * dpr;
      const stepY = RIPPLE.cellHeight * dpr;
      const cellArea = gw * gh;
      for (let r = 0; r < rows; r++) {
        const dy0 = Math.round(r * stepY);
        if (dy0 >= H) break;
        const hRows = Math.min(gh, H - dy0);
        const cyPx = r * stepY + stepY / 2;
        const py = cyPx - ay;
        const py2 = py * py;
        for (let c = 0; c < columns; c++) {
          const at = (r * columns + c) * 4;
          let alpha = data[at + 1]! / 255;
          if (alpha <= 0) continue;
          const mixT = data[at + 2]! / 255;
          let cr = ink[0] + (wave[0] - ink[0]) * mixT;
          let cg = ink[1] + (wave[1] - ink[1]) * mixT;
          let cb = ink[2] + (wave[2] - ink[2]) * mixT;
          const packed = data[at + 3]!;
          const cxPx = c * stepX + stepX / 2;
          let wAura = 0;
          let auraT = 0;
          let auraHue = 0;
          if (auraOn) {
            const px = cxPx - ax;
            const d2 = px * px + py2;
            if (d2 < ar2) {
              const rNorm = Math.sqrt(d2) / ar;
              const u = 1 - rNorm;
              const s = u * u * (3 - 2 * u);
              wAura = s * (0.35 + 0.65 * s);
              auraT = wAura * auraTintScale * auraStrength;
              auraHue = Math.atan2(py, px + 1e-5) / TAU + 0.5 - rNorm * 0.45 + palette.auraPhase;
            }
          }
          let wNeb = 0;
          let nebR = 0;
          let nebG = 0;
          let nebB = 0;
          if (activeLobes > 0) {
            for (const lobe of lobes) {
              if (lobe.s <= 0) continue;
              const ndx = cxPx - lobe.x;
              const ndy = cyPx - lobe.y;
              const nd2 = ndx * ndx + ndy * ndy;
              if (nd2 >= lobe.r2) continue;
              const rn = Math.sqrt(nd2) / lobe.r;
              const u = 1 - rn;
              const s = u * u * (3 - 2 * u);
              const wi = s * (0.3 + 0.7 * s) * lobe.s;
              const angle = Math.atan2(ndy, ndx + 1e-5) / TAU;
              spectrumRgb(lobe.hue + angle * 0.22 - rn * 0.26, nebulaSample, !isLight, code);
              wNeb += wi;
              nebR += nebulaSample[0] * wi;
              nebG += nebulaSample[1] * wi;
              nebB += nebulaSample[2] * wi;
            }
          }
          const wNebC = wNeb > 1 ? 1 : wNeb;
          const nebT = wNebC * nebulaTintScale;
          const prismT =
            packed > 31 ? ((packed >> 5) / PRISM_LEVELS) * prismGain * (0.88 + 0.12 * wAura) : 0;
          if (isLight) {
            alpha = Math.min(
              0.88,
              alpha *
                (1 +
                  (RIPPLE.auraLift + 0.72) * wAura * auraStrength +
                  prismT * 0.62 +
                  nebulaLiftScale * 0.66 * wNebC),
            );
          } else if (wAura > 0 || wNebC > 0) {
            alpha = Math.min(
              1,
              alpha * (1 + RIPPLE.auraLift * wAura * auraStrength + nebulaLiftScale * wNebC),
            );
          }
          const total = auraT + prismT + nebT;
          if (total > 0.0001) {
            const capped = Math.min(RIPPLE.prismCap, total);
            const mixAmt = isLight ? Math.min(0.96, capped * 1.36) : capped;
            if (auraT > 0) spectrumRgb(auraHue, auraTint, !isLight, code);
            if (prismT > 0) spectrumRgb((packed & 31) / HUE_LEVELS, prismTint, !isLight, code);
            const hasNebula = wNeb > 0.0001;
            const nr = hasNebula ? nebR / wNeb : 0;
            const ng = hasNebula ? nebG / wNeb : 0;
            const nb = hasNebula ? nebB / wNeb : 0;
            const tr = (auraTint[0] * auraT + prismTint[0] * prismT + nr * nebT) / total;
            const tg = (auraTint[1] * auraT + prismTint[1] * prismT + ng * nebT) / total;
            const tb = (auraTint[2] * auraT + prismTint[2] * prismT + nb * nebT) / total;
            cr += (tr - cr) * mixAmt;
            cg += (tg - cg) * mixAmt;
            cb += (tb - cb) * mixAmt;
          }
          const a8 = Math.round(alpha * 256);
          const R = Math.round(cr) & 255;
          const G = Math.round(cg) & 255;
          const B = Math.round(cb) & 255;
          const rgb = LITTLE_ENDIAN ? (B << 16) | (G << 8) | R : (R << 24) | (G << 16) | (B << 8);
          const dx0 = Math.round(c * stepX);
          if (dx0 >= W) continue;
          const wCols = Math.min(gw, W - dx0);
          let m = (data[at]! % GLYPHS.length) * cellArea;
          let o = dy0 * W + dx0;
          for (let y = 0; y < hRows; y++, m += gw, o += W) {
            for (let x = 0; x < wCols; x++) {
              const coverage = glyphMask[m + x]!;
              if (coverage === 0) continue;
              const av = (coverage * a8) >> 8;
              out[o + x] = LITTLE_ENDIAN ? ((av << 24) | rgb) >>> 0 : (rgb | av) >>> 0;
            }
          }
        }
      }
      ctx.putImageData(image, 0, 0);
    },
    release() {
      image = null;
      pixels = null;
    },
    dispose() {},
  };
}

/** A rectangle, in CSS pixels relative to the canvas, where the field dims to keep text legible. */
export interface CalmZone {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly alpha?: number;
  readonly feather?: number;
}

interface NormalizedZone {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly alpha: number;
  readonly feather: number;
}

function normalizeZones(zones: readonly CalmZone[]): NormalizedZone[] {
  const out: NormalizedZone[] = [];
  for (const zone of zones) {
    const { x, y, w, h } = zone;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    out.push({
      x,
      y,
      w,
      h,
      alpha: clamp(zone.alpha ?? RIPPLE.calmAlpha, 0, 1),
      feather: Math.max(1, zone.feather ?? RIPPLE.calmFeather),
    });
  }
  return out;
}

const zonesKey = (zones: readonly NormalizedZone[]) =>
  zones
    .map(
      (z) =>
        `${Math.round(z.x)},${Math.round(z.y)},${Math.round(z.w)},${Math.round(z.h)},${z.alpha},${z.feather}`,
    )
    .join(";");

export interface GlyphFieldOptions {
  readonly columns: number;
  readonly rows: number;
  readonly waves: WaveField;
  readonly calmZones?: readonly CalmZone[];
  readonly force2D?: boolean;
  /** Called once a lost WebGL context is rebuilt, so the host can schedule a redraw. */
  readonly onContextRestored?: () => void;
}

export interface GlyphField {
  readonly mode: RendererMode;
  invalidate(): void;
  setCalmZones(zones: readonly CalmZone[]): void;
  busy(): boolean;
  isSettled(): boolean;
  triggerLiftoffBurst(normX?: number, normY?: number): boolean;
  triggerTideSwell(): boolean;
  needsDraw(nowMs: number, still: boolean): boolean;
  draw(nowMs: number, palette: GlyphPalette, still: boolean): void;
  /** Drops the backing store; the host resizes the canvas again before the next draw. */
  reclaim(): void;
  dispose(): void;
}

/** Glyph matrix lit by the wave field: WebGL2 when available, Canvas 2D otherwise. */
export function createGlyphField(
  canvas: HTMLCanvasElement,
  options: GlyphFieldOptions,
): GlyphField {
  const { columns, rows, waves } = options;
  const renderer =
    columns > 0 && rows > 0
      ? ((options.force2D ? null : createGlyphGlRenderer(canvas, columns, rows)) ??
        createGlyph2dRenderer(canvas, columns, rows))
      : null;
  const { cellWidth, cellHeight } = RIPPLE;
  const cells = columns * rows;
  const glow = new Float32Array(cells);
  const patch = new Float32Array(cells);
  const glyphs = new Uint8Array(cells);
  const edge = new Float32Array(cells);
  const mask = new Float32Array(cells);
  const breathSin = new Float32Array(cells);
  const breathCos = new Float32Array(cells);
  const wasLit = new Uint8Array(cells);
  const cloudColumns = new Map<number, Float32Array>();
  const columnClouds: Float32Array[] = [];
  const nebulaLobes: NebulaLobe[] = [0, 1, 2].map(() => ({
    x: 0,
    y: 0,
    radius: 1,
    strength: 0,
    hue: 0,
  }));
  const effective: EffectivePalette = {
    dark: true,
    ink: [0, 0, 0],
    wave: [0, 0, 0],
    fontFamily: "monospace",
    spectrumCode: 0,
    ambientIntensity: 1,
    prismStrength: 1,
    aura: null,
    auraPhase: 0,
    nebula: nebulaLobes,
  };
  let zones = normalizeZones(options.calmZones ?? []);
  let appliedZonesKey: string | null = null;
  let lastIdleRefreshMs = Number.NEGATIVE_INFINITY;
  let lastIdleDark: boolean | null = null;
  let nebulaEnabled = true;
  let lastTick = -1;
  let lastDraw = Number.NEGATIVE_INFINITY;
  let glowing = false;
  let prismBurst = 0;
  let stale = true;

  const featherCols = Math.max(1, columns * RIPPLE.edgeFeather);
  const featherRows = Math.max(1, rows * RIPPLE.edgeFeather);
  for (let row = 0; row < rows; row++) {
    const y = row * cellHeight + cellHeight / 2;
    const ey = smooth((Math.min(row, rows - 1 - row) + 0.5) / featherRows);
    for (let column = 0; column < columns; column++) {
      const cell = row * columns + column;
      const x = column * cellWidth + cellWidth / 2;
      patch[cell] = patchClear(x, y);
      const ex = smooth((Math.min(column, columns - 1 - column) + 0.5) / featherCols);
      edge[cell] = ex * ey;
      mask[cell] = ex * ey;
      const phase =
        fractalNoise(x / RIPPLE.breathScale + 53, y / RIPPLE.breathScale + 71) * TAU * 1.7;
      breathSin[cell] = Math.sin(phase);
      breathCos[cell] = Math.cos(phase);
    }
  }

  function applyZones() {
    const key = zonesKey(zones);
    if (key === appliedZonesKey) return;
    appliedZonesKey = key;
    for (let row = 0; row < rows; row++) {
      const y = row * cellHeight + cellHeight / 2;
      for (let column = 0; column < columns; column++) {
        const cell = row * columns + column;
        const x = column * cellWidth + cellWidth / 2;
        let calm = 1;
        for (const z of zones) {
          const dx = Math.max(z.x - x, 0, x - (z.x + z.w));
          const dy = Math.max(z.y - y, 0, y - (z.y + z.h));
          const signed =
            dx > 0 || dy > 0
              ? Math.sqrt(dx * dx + dy * dy)
              : -Math.min(x - z.x, z.x + z.w - x, y - z.y, z.y + z.h - y);
          if (signed >= z.feather) continue;
          const inset = z.feather * 0.35;
          const t = smooth((signed + inset) / (z.feather + inset));
          const f = z.alpha + (1 - z.alpha) * t;
          if (f < calm) calm = f;
        }
        mask[cell] = edge[cell]! * calm;
      }
    }
    stale = true;
  }

  const onContextLost = (event: Event) => event.preventDefault();
  const onContextRestored = () => {
    try {
      renderer?.build();
    } catch {
      return;
    }
    stale = true;
    options.onContextRestored?.();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  const tickAt = (nowMs: number, still: boolean) =>
    still ? 0 : Math.floor((nowMs / 1000) * RIPPLE.changeRate);

  function cloudColumn(absolute: number): Float32Array {
    let column = cloudColumns.get(absolute);
    if (!column) {
      column = new Float32Array(rows);
      for (let row = 0; row < rows; row++) {
        column[row] = cloudClear(
          absolute * cellWidth + cellWidth / 2,
          row * cellHeight + cellHeight / 2,
        );
      }
      cloudColumns.set(absolute, column);
    }
    return column;
  }

  function prepareEffective(palette: GlyphPalette, seconds: number, still: boolean) {
    const ambient = clamp(palette.ambientIntensity, 0, 1);
    effective.dark = palette.dark;
    effective.ink = palette.ink;
    effective.wave = palette.wave;
    effective.fontFamily = palette.fontFamily;
    effective.spectrumCode = palette.spectrumCode;
    effective.ambientIntensity = ambient;
    effective.aura = ambient <= 0.001 ? null : palette.aura;
    nebulaEnabled = ambient > 0.001;
    if (nebulaEnabled) {
      computeNebulaLobes(seconds, columns * cellWidth, rows * cellHeight, still, nebulaLobes);
    }
    effective.nebula = nebulaEnabled ? nebulaLobes : null;
    effective.prismStrength = clamp(palette.prismStrength, 0, 1) * ambient;
    effective.auraPhase = palette.auraPhase - Math.floor(palette.auraPhase);
  }

  const isBusy = () => waves.active() || glowing || prismBurst > 0;
  const decayBurst = (burst: number, dtSec: number, still: boolean) => {
    const next = still ? 0 : burst * Math.exp(-Math.max(0.016, dtSec) / 0.38);
    return next < 0.015 ? 0 : next;
  };

  return {
    mode: renderer ? renderer.mode : "none",
    invalidate() {
      stale = true;
    },
    setCalmZones(next) {
      zones = normalizeZones(next);
      stale = true;
    },
    busy: isBusy,
    isSettled: () => !isBusy(),
    triggerLiftoffBurst(normX = 0.5, normY = 0.62) {
      if (columns <= 0 || rows <= 0) return false;
      const column = Math.round(clamp(normX, 0, 1) * (columns - 1));
      const row = Math.round(clamp(normY, 0, 1) * (rows - 1));
      waves.disturb(column, row, {
        amplitudeScale: 1.55,
        radiusScale: 1.45,
        duration: 0.42,
        frequency: 6.4,
        loadWeight: 0.22,
      });
      waves.disturb(column, Math.max(0, row - 1), {
        amplitudeScale: 1.28,
        radiusScale: 2.35,
        duration: 0.56,
        frequency: 4.5,
        delay: 0.035,
        loadWeight: 0.22,
      });
      prismBurst = 1;
      stale = true;
      return true;
    },
    triggerTideSwell() {
      if (columns <= 0 || rows <= 0) return false;
      const baseRow = Math.max(0, rows - 1 - Math.min(2, Math.floor(rows * 0.06)));
      const anchors = [
        { nx: 0.5, delay: 0, amplitude: 0.78, radius: 1.32, duration: 0.62, frequency: 3.2 },
        { nx: 0.22, delay: 0.07, amplitude: 0.66, radius: 1.18, duration: 0.6, frequency: 3.1 },
        { nx: 0.78, delay: 0.14, amplitude: 0.66, radius: 1.18, duration: 0.6, frequency: 3.1 },
      ];
      for (const anchor of anchors) {
        waves.disturb(Math.round(anchor.nx * (columns - 1)), baseRow, {
          amplitudeScale: anchor.amplitude,
          radiusScale: anchor.radius,
          duration: anchor.duration,
          frequency: anchor.frequency,
          delay: anchor.delay,
          loadWeight: 0.16,
        });
      }
      stale = true;
      return true;
    },
    needsDraw(nowMs, still) {
      if (isCanvasDocHidden(canvas)) return false;
      if (stale || isBusy() || tickAt(nowMs, still) !== lastTick) return true;
      if (still || !nebulaEnabled) return false;
      return Math.abs(nowMs - lastDraw) >= RIPPLE.nebulaFrameMs;
    },
    draw(nowMs, palette, still) {
      if (columns <= 0 || rows <= 0 || isCanvasDocHidden(canvas)) return;
      const rawDt =
        lastDraw > Number.NEGATIVE_INFINITY ? Math.max(0, (nowMs - lastDraw) / 1000) : 0;
      if (!renderer) {
        // The trail and burst still have to decay, or busy() would hold the frame loop awake.
        glowing = false;
        prismBurst = waves.active() ? decayBurst(prismBurst, rawDt, still) : 0;
        lastDraw = nowMs;
        stale = false;
        return;
      }
      applyZones();
      const seconds = still ? 0 : nowMs / 1000;
      prepareEffective(palette, seconds, still);
      const burst = prismBurst;
      if (burst > 0) {
        effective.prismStrength = Math.min(
          1.35,
          Math.max(effective.prismStrength, 0.96) + 0.34 * burst,
        );
      }
      const dpr = canvas.width / (columns * cellWidth);
      const tick = tickAt(nowMs, still);
      const waveActive = waves.active();
      const needIdleRefresh =
        stale ||
        tick !== lastTick ||
        effective.dark !== lastIdleDark ||
        renderer.mode !== "webgl2" ||
        Math.abs(nowMs - lastIdleRefreshMs) >= IDLE_REFRESH_MS;

      // Only the aura and nebula uniforms moved, so the cell texture is reused as uploaded.
      if (!needIdleRefresh && !waveActive && !glowing && burst <= 0) {
        renderer.draw(effective, dpr, false);
        lastDraw = nowMs;
        return;
      }

      if (tick !== lastTick) {
        for (let row = 0; row < rows; row++) {
          for (let column = 0; column < columns; column++) {
            glyphs[row * columns + column] = glyphIndex(column, row, tick);
          }
        }
      }
      const drift = Math.floor((seconds * RIPPLE.cloudDrift) / cellWidth);
      if (needIdleRefresh) {
        for (const absolute of cloudColumns.keys()) {
          if (absolute < drift) cloudColumns.delete(absolute);
        }
        lastIdleRefreshMs = nowMs;
        lastIdleDark = effective.dark;
      }
      const decay = still
        ? 0
        : rawDt > 0
          ? Math.exp(-rawDt / RIPPLE.glowDecay)
          : waveActive
            ? 1
            : 0.88;
      const idleAlpha = effective.dark ? RIPPLE.idleAlphaDark : RIPPLE.idleAlphaLight;
      const themeScale = effective.dark ? 1 : RIPPLE.lightAlphaScale;
      const omega = (TAU / RIPPLE.breathPeriod) * seconds;
      const bs = Math.sin(omega);
      const bc = Math.cos(omega);
      const breathHalf = RIPPLE.breathDepth * 0.5;
      const cap = RIPPLE.waveAlphaCap;
      const prismThreshold = clamp(RIPPLE.prismThreshold * (1 - 0.38 * burst), 0, 0.95);
      const crestScale = 0.78 + 0.34 * burst;
      const bandScale = RIPPLE.prismBands / TAU;
      const invCap = 1 / cap;
      const inv2CellW = 1 / (2 * cellWidth);
      const inv2CellH = 1 / (2 * cellHeight);
      const invPrismSpan = 1 / Math.max(1e-4, 1 - prismThreshold);
      const idleThemeScale = idleAlpha * themeScale;
      const height = waves.height;
      const { data } = renderer;
      for (let c = 0; c < columns; c++) columnClouds[c] = cloudColumn(c + drift);
      let brightest = 0;
      for (let row = 0; row < rows; row++) {
        const rowBase = row * columns;
        const hasAbove = row > 0;
        const hasBelow = row < rows - 1;
        for (let column = 0; column < columns; column++) {
          const cell = rowBase + column;
          const here = height[cell]!;
          const previousGlow = glow[cell]!;
          const at = cell << 2;
          if (here === 0 && previousGlow === 0) {
            if (!needIdleRefresh && wasLit[cell] === 0) continue;
            wasLit[cell] = 0;
            const breath = 1 - breathHalf * (1 + bs * breathCos[cell]! + bc * breathSin[cell]!);
            const alpha = idleThemeScale * columnClouds[column]![row]! * breath * mask[cell]!;
            data[at] = glyphs[cell]!;
            data[at + 1] = alpha < INVISIBLE_ALPHA ? 0 : alpha >= 1 ? 255 : (alpha * 255 + 0.5) | 0;
            data[at + 2] = 0;
            data[at + 3] = 0;
            continue;
          }
          const breath = 1 - breathHalf * (1 + bs * breathCos[cell]! + bc * breathSin[cell]!);
          const strength = Math.tanh(RIPPLE.waveGain * (here < 0 ? -here : here));
          const decayed = previousGlow * decay;
          const shown = decayed > strength ? decayed : strength;
          const lit = shown < 0.01 ? 0 : shown;
          glow[cell] = lit;
          wasLit[cell] = lit > 0 ? 1 : 0;
          let alpha = idleAlpha * columnClouds[column]![row]! * breath;
          let packed = 0;
          let waveMix = strength;
          if (lit > 0) {
            if (lit > brightest) brightest = lit;
            const rawRatio =
              patch[cell]! * (lit * RIPPLE.glowAlpha + strength * RIPPLE.waveAlpha) * invCap;
            alpha += cap * Math.tanh(rawRatio);
            waveMix = Math.min(1, Math.max(strength * 1.15, lit * 0.42));
            const left = column > 0 ? height[cell - 1]! : here;
            const right = column < columns - 1 ? height[cell + 1]! : here;
            const above = hasAbove ? height[cell - columns]! : here;
            const below = hasBelow ? height[cell + columns]! : here;
            const gx = (right - left) * inv2CellW;
            const gy = (below - above) * inv2CellH;
            // Steep wavefronts and tall crests both disperse; the slope normal picks the hue band.
            const g = Math.max(
              Math.sqrt(gx * gx + gy * gy) * RIPPLE.prismSlopeScale,
              strength * crestScale,
            );
            if (g > prismThreshold) {
              const level = Math.round(smooth((g - prismThreshold) * invPrismSpan) * PRISM_LEVELS);
              if (level > 0) {
                let hue = Math.atan2(gy, gx + 1e-6) * bandScale + Math.tanh(here * 2.4) * 0.3;
                hue -= Math.floor(hue);
                packed = (level << 5) | (Math.floor(hue * HUE_LEVELS) & 31);
              }
            }
          }
          alpha *= mask[cell]! * themeScale;
          data[at] = glyphs[cell]!;
          data[at + 1] = alpha < INVISIBLE_ALPHA ? 0 : alpha >= 1 ? 255 : (alpha * 255 + 0.5) | 0;
          data[at + 2] = lit > 0 ? (waveMix * 255 + 0.5) | 0 : 0;
          data[at + 3] = packed;
        }
      }
      renderer.draw(effective, dpr, true);
      if (burst > 0) prismBurst = decayBurst(burst, rawDt, still);
      glowing = brightest > 0;
      if (!glowing && !waves.active()) {
        glow.fill(0);
        prismBurst = 0;
      }
      lastTick = tick;
      lastDraw = nowMs;
      stale = false;
    },
    reclaim() {
      canvas.width = 0;
      canvas.height = 0;
      renderer?.release();
      stale = true;
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      renderer?.dispose();
    },
  };
}

const HORIZON_PRISM_STOPS: Stops5 = [
  [66, 133, 244],
  [155, 114, 203],
  [234, 67, 53],
  [251, 188, 4],
  [92, 198, 252],
];
const HORIZON_DAYLIGHT_STOPS: Stops5 = [
  [37, 99, 235],
  [124, 58, 237],
  [234, 67, 53],
  [217, 119, 6],
  [2, 132, 199],
];

function horizonPrismRgb(t: number, out: MutableRgb, dark: boolean) {
  const stops = dark ? HORIZON_PRISM_STOPS : HORIZON_DAYLIGHT_STOPS;
  let f = (t - Math.floor(t)) * 5;
  const i = Math.min(4, Math.floor(f));
  f = smooth(f - i);
  const a = stops[i]!;
  const b = stops[(i + 1) % 5]!;
  out[0] = a[0] + (b[0] - a[0]) * f;
  out[1] = a[1] + (b[1] - a[1]) * f;
  out[2] = a[2] + (b[2] - a[2]) * f;
}

const HORIZON_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uDpr;
uniform float uTime;
uniform float uDark;
uniform float uReach;
uniform float uIntensity;
uniform float uStretch;
uniform float uPresence;
uniform float uPrism;
uniform float uSurge;
uniform float uSpeed;
uniform float uSpectrum;
uniform float uSemantic;
out vec4 outColor;

float hash(vec2 p) {
p = fract(p * vec2(123.34, 456.21));
p += dot(p, p + 45.32);
return fract(p.x * p.y);
}
float ign(vec2 p) {
return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
float noise(vec2 p) {
vec2 i = floor(p);
vec2 f = fract(p);
vec2 u = f * f * (3.0 - 2.0 * f);
return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
float v = 0.0;
float a = 0.5;
for (int i = 0; i < 4; i++) {
v += a * noise(p);
p = p * 2.03 + 17.1;
a *= 0.5;
}
return v;
}
float halftone(vec2 px, vec2 res, float y, float t, float cell, float msk) {
float persp = 1.0 / (0.55 + y);
vec2 g = vec2((px.x - res.x * 0.5) * persp, res.y * log(0.55 + y));
g.y += 10.0 * sin(g.x * 0.007 + t * 0.42) + 3.2 * sin(g.x * 0.019 - t * 0.28) - t * 1.5;
vec2 uvCell = g / cell;
vec2 c = fract(uvCell) - 0.5;
float dist = length(c);
float aa = clamp(fwidth(dist) * 1.15, 0.035, 0.14);
float r = 0.08 + 0.16 * msk;
return (1.0 - smoothstep(r - aa, r + aa * 0.35, dist)) * msk;
}
const vec3 DEEP_SPACE_BLUE = vec3(0.059, 0.090, 0.227);
const vec3 ZENITH_BLUE = vec3(0.192, 0.525, 1.000);
const vec3 SKY_BLUE = vec3(0.361, 0.776, 0.988);
const vec3 HAZE_BLUE = vec3(0.733, 0.886, 1.000);
const vec3 PRISM_COBALT = vec3(0.259, 0.522, 0.957);
const vec3 PRISM_IRIS = vec3(0.608, 0.447, 0.796);
const vec3 PRISM_CORAL = vec3(0.918, 0.263, 0.208);
const vec3 PRISM_AMBER = vec3(0.984, 0.737, 0.016);
const vec3 ICE_MIST = vec3(0.839, 0.933, 1.000);
const vec3 DAY_COBALT = vec3(0.145, 0.388, 0.922);
const vec3 DAY_IRIS = vec3(0.486, 0.227, 0.929);
const vec3 DAY_CORAL = vec3(0.918, 0.263, 0.208);
const vec3 DAY_AMBER = vec3(0.851, 0.467, 0.024);
const vec3 DAY_CERULEAN = vec3(0.008, 0.518, 0.780);
const vec3 WARM_DARK_A = vec3(0.580, 0.290, 0.204);
const vec3 WARM_DARK_B = vec3(0.851, 0.467, 0.341);
const vec3 WARM_DARK_C = vec3(0.933, 0.682, 0.365);
const vec3 DAY_TERRACOTTA = vec3(0.761, 0.349, 0.204);
const vec3 DAY_SIENNA = vec3(0.635, 0.247, 0.141);
const vec3 MONO_DARK_LO = vec3(0.620, 0.659, 0.725);
const vec3 MONO_DARK_HI = vec3(0.847, 0.878, 0.929);
const vec3 MONO_LIGHT_LO = vec3(0.267, 0.318, 0.400);
const vec3 MONO_LIGHT_HI = vec3(0.416, 0.475, 0.569);
const vec3 SEM_AMBER_D = vec3(0.949, 0.722, 0.294);
const vec3 SEM_AMBER_L = vec3(0.851, 0.467, 0.024);
const vec3 SEM_CORAL_D = vec3(0.851, 0.345, 0.365);
const vec3 SEM_CORAL_L = vec3(0.863, 0.149, 0.149);
const vec3 SEM_JADE_D = vec3(0.314, 0.745, 0.576);
const vec3 SEM_JADE_L = vec3(0.020, 0.588, 0.412);
vec3 blueLoop(float x) {
float t = fract(x) * 4.0;
float f = smoothstep(0.0, 1.0, fract(t));
vec3 indigo = mix(DEEP_SPACE_BLUE, ZENITH_BLUE, 0.84);
vec3 ice = mix(SKY_BLUE, HAZE_BLUE, 0.35);
if (t < 1.0) return mix(ZENITH_BLUE, indigo, f);
if (t < 2.0) return mix(indigo, SKY_BLUE, f);
if (t < 3.0) return mix(SKY_BLUE, ice, f);
return mix(ice, ZENITH_BLUE, f);
}
vec3 prismLoop(float x) {
float t = fract(x) * 5.0;
float f = smoothstep(0.0, 1.0, fract(t));
if (t < 1.0) return mix(PRISM_COBALT, PRISM_IRIS, f);
if (t < 2.0) return mix(PRISM_IRIS, PRISM_CORAL, f);
if (t < 3.0) return mix(PRISM_CORAL, PRISM_AMBER, f);
if (t < 4.0) return mix(PRISM_AMBER, SKY_BLUE, f);
return mix(SKY_BLUE, PRISM_COBALT, f);
}
vec3 daylightInkLoop(float x) {
float t = fract(x) * 5.0;
float f = smoothstep(0.0, 1.0, fract(t));
if (t < 1.0) return mix(DAY_COBALT, DAY_IRIS, f);
if (t < 2.0) return mix(DAY_IRIS, DAY_CORAL, f);
if (t < 3.0) return mix(DAY_CORAL, DAY_AMBER, f);
if (t < 4.0) return mix(DAY_AMBER, DAY_CERULEAN, f);
return mix(DAY_CERULEAN, DAY_COBALT, f);
}
vec3 spectrumBaseDark(float spec, float ph) {
float w = 0.5 + 0.5 * sin(ph * 6.2831853);
if (spec > 4.5) return mix(MONO_DARK_LO, MONO_DARK_HI, w);
if (spec > 3.5) return mix(vec3(0.820, 0.545, 0.200), SEM_AMBER_D, w);
if (spec > 2.5) return mix(vec3(0.440, 0.360, 0.820), PRISM_IRIS, w);
if (spec > 1.5) return blueLoop(ph);
if (spec > 0.5) return mix(WARM_DARK_A, WARM_DARK_B, 0.35 + 0.65 * w);
return blueLoop(ph);
}
vec3 spectrumPrismDark(float spec, float ph) {
float w = 0.5 + 0.5 * sin(ph * 6.2831853 + 1.1);
if (spec > 4.5) return mix(MONO_DARK_LO, MONO_DARK_HI, w);
if (spec > 3.5) return mix(SEM_AMBER_D, WARM_DARK_C, w);
if (spec > 2.5) return mix(PRISM_IRIS, vec3(0.710, 0.560, 0.960), w);
if (spec > 1.5) return mix(PRISM_COBALT, SKY_BLUE, w);
if (spec > 0.5) return mix(WARM_DARK_B, WARM_DARK_C, w);
return prismLoop(ph);
}
vec3 spectrumInkLight(float spec, float ph, float washPhase) {
float w = 0.5 + 0.5 * sin(ph * 6.2831853);
float sw = 0.5 + 0.5 * sin(washPhase);
if (spec > 4.5) return mix(MONO_LIGHT_LO, MONO_LIGHT_HI, 0.5 * (w + sw));
if (spec > 3.5) return mix(DAY_AMBER, vec3(0.706, 0.325, 0.035), w);
if (spec > 2.5) return mix(DAY_IRIS, vec3(0.310, 0.275, 0.898), w);
if (spec > 1.5) return mix(DAY_COBALT, DAY_CERULEAN, sw);
if (spec > 0.5) return mix(DAY_TERRACOTTA, mix(DAY_AMBER, DAY_SIENNA, sw), 0.45 + 0.45 * w);
return daylightInkLoop(ph);
}
vec3 semanticColor(float sem, float dark, float ph) {
float w = 0.5 + 0.5 * sin(ph * 6.2831853);
if (sem < 1.5) {
return dark > 0.5
  ? mix(SEM_AMBER_D, vec3(0.980, 0.835, 0.480), 0.35 * w)
  : mix(SEM_AMBER_L, vec3(0.706, 0.325, 0.035), 0.40 * w);
}
if (sem < 2.5) {
return dark > 0.5
  ? mix(SEM_CORAL_D, vec3(0.690, 0.235, 0.265), 0.40 * w)
  : mix(SEM_CORAL_L, vec3(0.620, 0.110, 0.120), 0.35 * w);
}
return dark > 0.5
  ? mix(SEM_JADE_D, SKY_BLUE, 0.38 * w)
  : mix(SEM_JADE_L, DAY_CERULEAN, 0.42 * w);
}
vec3 sm(vec3 a,float d,float p,float i,float w){return w>.001?mix(a,semanticColor(i,d,p),w):a;}
void main() {
vec2 uv = gl_FragCoord.xy / max(uRes, vec2(1.0));
float reach = max(uReach, 0.01);
float stretch = uStretch * (1.0 + 0.08 * (uSpeed - 1.0));
float surgeUp = max(uSurge, 0.0);
float yCut = uv.y / reach - 0.25 * stretch;
if (yCut > 1.6 + 0.22 * surgeUp) {
outColor = vec4(0.0);
return;
}
float topFeather = 1.0 - smoothstep(1.15 + 0.14 * surgeUp, 1.58 + 0.22 * surgeUp, yCut);
vec2 px = gl_FragCoord.xy / max(uDpr, 0.5);
vec2 res = uRes / max(uDpr, 0.5);
float t = uTime;
vec2 p = (px - res * 0.5) / max(res.y, 1.0);
vec2 q = p + 0.09 * vec2(fbm(p * 2.0 + vec2(t * 0.16, 0.0)), fbm(p * 2.0 + vec2(3.1, -t * 0.13))) - 0.045;
float y = uv.y / reach;
float waveA = sin(uv.x * 5.2 - t * 0.68);
float waveB = sin(uv.x * 8.6 + t * 0.46 + 1.4);
float curtain = 0.5 + 0.32 * waveA + 0.18 * waveB;
float jut = (fbm(vec2(px.x / 220.0 + t * 0.18, t * 0.11)) - 0.5) * 0.68 + (waveA * 0.65 + waveB * 0.35) * 0.24;
float h = y + stretch * (0.36 * jut + 0.11 * (fbm(vec2(px.x / 90.0 - t * 0.21, t * 0.14 + 3.0)) - 0.5));
float glow = exp(-max(h, 0.0) * max(h, 0.0) * 4.0) * (0.76 + 0.42 * curtain) * mix(0.35, 1.0, smoothstep(0.0, 0.3, uv.x) * (1.0 - smoothstep(0.7, 1.0, uv.x)));
float basePhase = px.x / max(res.x, 1.0) * 0.9 + t * 0.15 + 0.22 * fbm(q * 1.5);
float semId = floor(uSemantic + 0.001);
float semW = semId > 0.5 ? clamp(1.0 - (uSemantic - semId) / 0.98, 0.0, 1.0) : 0.0;
vec3 base = sm(spectrumBaseDark(uSpectrum, basePhase), 1.0, basePhase, semId, semW);
float n = fbm(q * 3.0 + t * 0.16);
float field = (1.0 - exp(-1.8 * glow * (0.75 + 0.45 * n))) / (1.0 - exp(-1.8 * 1.2));
float pPhase = uv.x * 1.18 - t * 0.18 + 0.28 * fbm(q * 2.1 + vec2(0.0, t * 0.12)) + 0.14 * y;
vec3 dotPrismTint = vec3(0.0);
float dotPrismMix = 0.0;
float dotBoost = 0.0;
float surgeArc = 0.0;
float surgeDy = 0.0;
float chimeWave = 0.0;
float chimePhase = 0.0;
float effPrism = uSpectrum > 4.5 ? uPrism * 0.28 : uPrism;
if (effPrism > 0.0001 || abs(uSurge) > 0.0001) {
vec3 pCol = sm(spectrumPrismDark(uSpectrum, pPhase), 1.0, pPhase, semId, semW);
if (effPrism > 0.0001) {
float wing = smoothstep(0.06, 0.42, field) * (1.0 - 0.52 * smoothstep(0.72, 0.98, field));
float caustics = 0.52 + 0.48 * smoothstep(-0.24, 0.26, jut);
base = mix(base, pCol, clamp(effPrism * 1.15 * wing * caustics, 0.0, 0.68));
dotPrismTint = pCol;
dotPrismMix = clamp(effPrism * 1.25 * (0.45 + 0.55 * caustics), 0.0, 0.78);
}
if (uSurge > 0.0001) {
float sp = clamp(uSurge, 0.0, 1.0);
float sEnv = sin(sp * 3.14159265) * (1.0 - 0.32 * sp);
float xRel = (uv.x - 0.5) * 2.0;
float xSpan = smoothstep(0.0, 0.22, uv.x) * (1.0 - smoothstep(0.78, 1.0, uv.x));
float frontY = 1.15 * (1.0 - pow(1.0 - sp, 1.45)) - 0.15 * xRel * xRel + 0.06 * jut;
float dy = y - frontY;
float arc = (dy >= 0.0 ? exp(-dy * dy * 24.0) : exp(-dy * dy * 5.2)) * sEnv * xSpan;
surgeArc = arc;
surgeDy = dy - sp * 0.35;
vec3 surgeLead = sm(uSpectrum > 4.5 ? MONO_DARK_HI : (uSpectrum > 0.5 && uSpectrum < 1.5 ? WARM_DARK_C : SKY_BLUE), 1.0, pPhase + 0.2, semId, semW);
vec3 surgeTrail = sm(spectrumPrismDark(uSpectrum, pPhase + surgeDy * 1.3), 1.0, pPhase + surgeDy * 1.3, semId, semW);
vec3 surgeCol = mix(surgeLead, surgeTrail, 0.62);
field = clamp(field + arc * 0.52, 0.0, 1.0);
base = mix(base, surgeCol, clamp(arc * 0.78, 0.0, 0.85));
dotBoost += arc * 0.58;
dotPrismTint = mix(dotPrismTint, surgeCol, clamp(arc * 0.85, 0.0, 1.0));
dotPrismMix = max(dotPrismMix, clamp(arc * 0.82, 0.0, 0.85));
} else if (uSurge < -0.0001) {
float cp = clamp(-uSurge, 0.0, 1.0);
float cEnv = sin(cp * 3.14159265) * (1.0 - 0.28 * cp);
float rx = abs(uv.x - 0.5);
float ringR = 0.04 + 0.43 * (1.0 - pow(1.0 - cp, 1.35));
float dr = (rx - ringR) / 0.135;
float hRip = exp(-dr * dr) + 0.32 * (1.0 - cp) * exp(-rx * rx * 18.0);
float setY = 0.70 * pow(1.0 - cp, 1.35) + 0.04;
float dsy = y - setY;
float vSet = exp(-dsy * dsy * 13.5) * (1.0 - smoothstep(1.05, 1.35, y));
float chime = hRip * vSet * cEnv;
chimeWave = chime;
chimePhase = uv.x * 1.5 + rx * 2.0 - cp * 0.35;
vec3 chimeLead = sm(uSpectrum > 4.5 ? MONO_DARK_HI : (uSpectrum > 0.5 && uSpectrum < 1.5 ? WARM_DARK_C : ICE_MIST), 1.0, chimePhase, semId, semW);
vec3 chimeCol = mix(mix(chimeLead, spectrumPrismDark(uSpectrum, chimePhase), 0.22), chimeLead, semW);
field = clamp(field + chime * 0.46, 0.0, 1.0);
base = mix(base, chimeCol, clamp(chime * 0.82, 0.0, 0.88));
dotBoost += chime * 0.42;
dotPrismTint = mix(dotPrismTint, chimeCol, clamp(chime * 0.8, 0.0, 1.0));
dotPrismMix = max(dotPrismMix, clamp(chime * 0.75, 0.0, 0.82));
}
}
float hot = 0.75 * smoothstep(0.65, 1.0, field);
field *= topFeather;
dotBoost *= topFeather;
float band = smoothstep(0.3, 0.55, field) * (1.0 - smoothstep(0.7, 0.98, field));
float dotMsk = clamp(band * 0.8 * smoothstep(0.12, 0.32, -jut) + dotBoost, 0.0, 1.0);
float dA = halftone(px, res, uv.y, t, 7.0, dotMsk);
float grain = hash(px + fract(t * 7.0) * 91.0) - 0.5;
vec3 c;
vec3 dc;
float a;
float da;
if (uDark > 0.5) {
vec3 fill = base * (1.0 + 0.25 * hot) * mix(0.72, 1.16, uIntensity);
c = fill + grain * 0.05;
dc = min(fill * 1.6, 1.0);
if (dotPrismMix > 0.0001) {
dc = mix(dc, min(dotPrismTint * 1.22 + 0.08, 1.0), dotPrismMix);
}
float breathMod = mix(0.68, 1.24, clamp(uIntensity, 0.0, 1.0));
a = clamp(field * 0.56 * breathMod * uPresence, 0.0, 1.0);
da = clamp(dA * sqrt(a) * 0.78, 0.0, 1.0);
} else {
float washPh = uv.x * 3.1 + t * 0.48 + 1.3 * n;
vec3 prismInk = sm(spectrumInkLight(uSpectrum, pPhase, washPh), 0.0, pPhase, semId, semW);
vec3 washBase = sm(uSpectrum > 0.5 ? spectrumInkLight(uSpectrum, basePhase, washPh) : mix(DAY_COBALT, DAY_CERULEAN, 0.5 + 0.5 * sin(washPh)), 0.0, basePhase, semId, semW);
float causticsL = 0.48 + 0.52 * smoothstep(-0.24, 0.26, jut);
float dichroicW = clamp((0.48 + 0.46 * effPrism) * (0.58 + 0.42 * causticsL), 0.0, 0.94);
vec3 inkRgb = mix(washBase, prismInk, dichroicW);
if (surgeArc > 0.0001) {
vec3 surgeInk = sm(mix(washBase, spectrumInkLight(uSpectrum, pPhase + surgeDy * 1.3, washPh), 0.68), 0.0, pPhase + surgeDy * 1.3, semId, semW);
inkRgb = mix(inkRgb, surgeInk, clamp(surgeArc * 0.85, 0.0, 0.90));
} else if (chimeWave > 0.0001) {
vec3 chimeInk = sm(mix(washBase, spectrumInkLight(uSpectrum, chimePhase, washPh), 0.45), 0.0, chimePhase, semId, semW);
inkRgb = mix(inkRgb, chimeInk, clamp(chimeWave * 0.86, 0.0, 0.90));
}
vec3 hotAnchor = mix(uSpectrum > 4.5 ? MONO_LIGHT_LO : (uSpectrum > 0.5 && uSpectrum < 1.5 ? DAY_SIENNA : DAY_COBALT * 0.84 + DAY_IRIS * 0.16), washBase * 0.88, semW);
inkRgb = mix(inkRgb, hotAnchor, hot * 0.24);
c = clamp(inkRgb + grain * 0.022, 0.0, 1.0);
dc = clamp(mix(washBase * 0.86, prismInk * 0.92, clamp(0.26 + dotPrismMix * 0.68, 0.0, 0.90)), 0.0, 1.0);
float effPres = pow(clamp(uPresence, 0.0, 1.0), 0.68);
float washGain = mix(1.02, 1.62, clamp(uIntensity, 0.0, 1.0));
a = clamp(field * 0.66 * washGain * effPres, 0.0, 0.84);
da = clamp(dA * (0.52 + 0.44 * sqrt(a)) * effPres, 0.0, 0.88);
}
float outAlpha = clamp(a + da * (1.0 - a), 0.0, 1.0);
vec3 premulRgb = clamp(c, 0.0, 1.0) * a * (1.0 - da) + clamp(dc, 0.0, 1.0) * da;
if (outAlpha > 0.0015) {
vec2 dp = gl_FragCoord.xy + fract(t * 3.0) * vec2(37.0, 19.0);
float tpdf = ign(dp) - ign(dp.yx + vec2(11.3, 27.1));
premulRgb += (tpdf / 255.0) * min(1.0, outAlpha * 2.5);
outAlpha = clamp(outAlpha + tpdf * (0.5 / 255.0), 0.0, 1.0);
}
outColor = clamp(vec4(premulRgb, outAlpha), 0.0, 1.0);
}`;

/** The raw horizon shader inputs; `semantic` carries the tone in its integer part. */
export interface HorizonUniforms {
  readonly timeSec: number;
  readonly dark: boolean;
  readonly intensity: number;
  readonly presence: number;
  readonly reach: number;
  readonly stretch: number;
  readonly prism: number;
  readonly surge: number;
  readonly speed: number;
  readonly spectrumCode: OpticalSpectrumCode;
  readonly semantic: number;
}

interface HorizonRenderer {
  readonly mode: "webgl2" | "2d";
  build(): void;
  clear(): void;
  draw(width: number, height: number, dpr: number, uniforms: HorizonUniforms): void;
  release(): void;
  dispose(): void;
}

const HORIZON_UNIFORMS = [
  "uRes",
  "uDpr",
  "uTime",
  "uDark",
  "uReach",
  "uIntensity",
  "uStretch",
  "uPresence",
  "uPrism",
  "uSurge",
  "uSpeed",
  "uSpectrum",
  "uSemantic",
] as const;

function createHorizonGlRenderer(canvas: HTMLCanvasElement): HorizonRenderer | null {
  const gl = canvas.getContext("webgl2", GL_CONTEXT_ATTRIBUTES);
  if (!gl) return null;
  let program: WebGLProgram | null = null;
  let u: Record<(typeof HORIZON_UNIFORMS)[number], WebGLUniformLocation | null> | null = null;
  const build = () => {
    program = linkFullscreenProgram(gl, HORIZON_FRAGMENT_SHADER);
    u = uniformLocations(gl, program, HORIZON_UNIFORMS);
  };
  try {
    build();
  } catch {
    return null;
  }
  return {
    mode: "webgl2",
    build,
    clear() {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    draw(width, height, dpr, uniforms) {
      if (!u || gl.isContextLost()) return;
      gl.viewport(0, 0, width, height);
      gl.useProgram(program);
      gl.uniform2f(u.uRes, width, height);
      gl.uniform1f(u.uDpr, dpr);
      gl.uniform1f(u.uTime, uniforms.timeSec);
      gl.uniform1f(u.uDark, uniforms.dark ? 1 : 0);
      gl.uniform1f(u.uReach, uniforms.reach);
      gl.uniform1f(u.uIntensity, uniforms.intensity);
      gl.uniform1f(u.uStretch, uniforms.stretch);
      gl.uniform1f(u.uPresence, uniforms.presence);
      gl.uniform1f(u.uPrism, uniforms.prism);
      gl.uniform1f(u.uSurge, uniforms.surge);
      gl.uniform1f(u.uSpeed, uniforms.speed);
      gl.uniform1f(u.uSpectrum, uniforms.spectrumCode);
      gl.uniform1f(u.uSemantic, uniforms.semantic);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    release() {},
    dispose() {
      gl.deleteProgram(program);
      program = null;
      u = null;
    },
  };
}

function sampleHorizonTone(
  spectrumCode: OpticalSpectrumCode,
  semantic: number,
  dark: boolean,
  phase: number,
  out: MutableRgb,
) {
  const w = 0.5 + 0.5 * Math.sin(phase * TAU);
  const set = (r: number, g: number, b: number) => {
    out[0] = r;
    out[1] = g;
    out[2] = b;
  };
  if (semantic === 1) {
    return dark
      ? set(242 + 8 * w, 184 + 28 * w, 75 + 47 * w)
      : set(217 - 37 * w, 119 - 36 * w, 6 + 3 * w);
  }
  if (semantic === 2) {
    return dark
      ? set(217 - 41 * w, 88 - 28 * w, 93 - 25 * w)
      : set(220 - 62 * w, 38 - 10 * w, 38 - 8 * w);
  }
  if (semantic >= 3) {
    return dark
      ? set(80 + 12 * w, 190 + 8 * w, 147 + 105 * w)
      : set(5 - 3 * w, 150 - 18 * w, 105 + 94 * w);
  }
  switch (spectrumCode) {
    case 5:
      return dark
        ? set(158 + 58 * w, 168 + 56 * w, 185 + 52 * w)
        : set(68 + 38 * w, 81 + 40 * w, 102 + 43 * w);
    case 4:
      return dark
        ? set(209 + 33 * w, 139 + 45 * w, 51 + 24 * w)
        : set(217 - 37 * w, 119 - 36 * w, 6 + 3 * w);
    case 3:
      return dark
        ? set(112 + 69 * w, 92 + 51 * w, 209 + 36 * w)
        : set(124 - 45 * w, 58 + 12 * w, 237 - 8 * w);
    case 2:
      return dark
        ? set(49 + 43 * w, 134 + 64 * w, 255 - 3 * w)
        : set(37 - 35 * w, 99 + 33 * w, 235 - 36 * w);
    case 1:
      return dark
        ? set(168 + 64 * w, 86 + 72 * w, 58 + 35 * w)
        : set(194 - 28 * w, 89 + 16 * w, 52 - 22 * w);
    case 0:
      return horizonPrismRgb(phase, out, dark);
  }
}

const expClamp = (value: number) => (value > 40 ? 0 : Math.exp(-value));
const toByte = (value: number) => Math.round(clamp(value, 0, 255)) & 255;

/** CPU path for the horizon: a coarser model of the shader, shaded per device-pixel block. */
function createHorizon2dRenderer(canvas: HTMLCanvasElement): HorizonRenderer | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  let image: ImageData | null = null;
  let pixels: Uint32Array | null = null;
  const prismRgb: MutableRgb = [0, 0, 0];
  const surgeRgb: MutableRgb = [0, 0, 0];
  const toneRgb: MutableRgb = [0, 0, 0];
  return {
    mode: "2d",
    build() {},
    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
    draw(w, h, dpr, uniforms) {
      if (!w || !h) return;
      if (!image || !pixels || image.width !== w || image.height !== h) {
        image = ctx.createImageData(w, h);
        pixels = new Uint32Array(image.data.buffer);
      }
      pixels.fill(0);
      const out = pixels;
      const { timeSec, dark, presence, surge, spectrumCode } = uniforms;
      const semantic = Math.floor(uniforms.semantic + 0.001);
      const intensity = clamp(uniforms.intensity, 0, 1);
      const rEff = Math.max(0.01, uniforms.reach);
      const stretchScale = 1 + 0.08 * (uniforms.speed - 1);
      const surgeUp = Math.max(0, surge);
      const effPrism = spectrumCode === 5 ? uniforms.prism * 0.28 : uniforms.prism;
      const hasPrism = effPrism > 0.0001;
      const hasSurge = Math.abs(surge) > 0.0001;
      const customMode = spectrumCode > 0 || semantic > 0;
      const scale = Math.max(0.5, dpr);
      const cssW = w / scale;
      const cssH = h / scale;
      const step = Math.max(1, Math.round(dpr));
      const lightPresence = dark ? presence : clamp(presence, 0, 1) ** 0.68;
      const washGain = dark ? 1 : 1.02 + 0.6 * intensity;
      const darkBreath = dark ? 0.68 + 0.56 * intensity : 1;
      const surgeScale = dark ? presence : 1;
      const tooFaint = (field: number) => (dark ? field : field * lightPresence) < 0.008;
      for (let py = 0; py < h; py += step) {
        const uvY = 1 - py / h;
        const yNorm = uvY / rEff;
        if (yNorm > 1.48 + 0.25 * surgeUp) continue;
        const persp = 1 / (0.55 + uvY);
        const gyBase = cssH * Math.log(0.55 + uvY);
        for (let px = 0; px < w; px += step) {
          const uvX = px / w;
          const cssX = px / scale;
          const waveA = Math.sin(uvX * 5.2 - timeSec * 0.68);
          const waveB = Math.sin(uvX * 8.6 + timeSec * 0.46 + 1.4);
          const curtain = 0.5 + 0.32 * waveA + 0.18 * waveB;
          const jut =
            (valueNoise(cssX / 220 + timeSec * 0.18, timeSec * 0.11) - 0.5) * 0.68 +
            (waveA * 0.65 + waveB * 0.35) * 0.24;
          const hJut = Math.max(0, yNorm + 0.25 * stretchScale * jut);
          const edgeFade =
            uvX < 0.3
              ? 0.35 + 0.65 * smooth(uvX / 0.3)
              : uvX > 0.7
                ? 0.35 + 0.65 * smooth((1 - uvX) / 0.3)
                : 1;
          const glow = Math.exp(-hJut * hJut * 4) * (0.76 + 0.42 * curtain) * edgeFade;
          let field = Math.min(1, glow * 1.12 * (dark ? darkBreath * presence : 1));
          if (!hasSurge && tooFaint(field)) continue;
          const mixSky = 0.5 + 0.5 * Math.sin(uvX * 3.2 + timeSec * 0.48);
          const pPhase =
            uvX * 1.18 -
            timeSec * 0.18 +
            0.28 * valueNoise(uvX * 3.1 + 1.7, yNorm * 1.6 - timeSec * 0.12) +
            0.14 * yNorm;
          const caustics = smooth((jut + 0.24) / 0.5);
          let baseR: number;
          let baseG: number;
          let baseB: number;
          let dotR = 0;
          let dotG = 0;
          let dotB = 0;
          if (dark) {
            if (customMode) {
              sampleHorizonTone(spectrumCode, semantic, true, uvX * 0.8 + timeSec * 0.12, toneRgb);
            } else {
              toneRgb[0] = 49 + 43 * mixSky;
              toneRgb[1] = 134 + 64 * mixSky;
              toneRgb[2] = 255 - 3 * mixSky;
            }
            [baseR, baseG, baseB] = toneRgb;
          } else {
            // Daylight is a dichroic ink wash: saturated pigment over the page, never a white fog.
            sampleHorizonTone(spectrumCode, semantic, false, pPhase, prismRgb);
            if (customMode) {
              sampleHorizonTone(spectrumCode, semantic, false, uvX * 0.5 + timeSec * 0.08, toneRgb);
            } else {
              toneRgb[0] = 37 - 35 * mixSky;
              toneRgb[1] = 99 + 33 * mixSky;
              toneRgb[2] = 235 - 36 * mixSky;
            }
            const dichroic = Math.min(
              0.94,
              (0.48 + 0.46 * effPrism) * (0.58 + 0.42 * (0.48 + 0.52 * caustics)),
            );
            baseR = toneRgb[0] + (prismRgb[0] - toneRgb[0]) * dichroic;
            baseG = toneRgb[1] + (prismRgb[1] - toneRgb[1]) * dichroic;
            baseB = toneRgb[2] + (prismRgb[2] - toneRgb[2]) * dichroic;
            const dotMix = Math.min(0.9, 0.26 + effPrism * 0.64);
            const dotBase = customMode ? toneRgb.map((channel) => channel * 0.86) : [32, 85, 202];
            dotR = dotBase[0]! * (1 - dotMix) + prismRgb[0] * 0.92 * dotMix;
            dotG = dotBase[1]! * (1 - dotMix) + prismRgb[1] * 0.92 * dotMix;
            dotB = dotBase[2]! * (1 - dotMix) + prismRgb[2] * 0.92 * dotMix;
          }
          let dotBoost = 0;
          if (dark && hasPrism) {
            sampleHorizonTone(spectrumCode, semantic, true, pPhase + 0.18, prismRgb);
            const wing = smooth((field - 0.04) / 0.32) * (1 - 0.5 * smooth((field - 0.68) / 0.28));
            const wPrism = Math.min(0.68, effPrism * 1.2 * wing * (0.52 + 0.48 * caustics));
            baseR += (prismRgb[0] - baseR) * wPrism;
            baseG += (prismRgb[1] - baseG) * wPrism;
            baseB += (prismRgb[2] - baseB) * wPrism;
          }
          if (surge > 0.0001) {
            const sp = Math.min(1, surge);
            const envelope = Math.sin(sp * Math.PI) * (1 - 0.32 * sp);
            const xRel = (uvX - 0.5) * 2;
            const xSpan = smooth(uvX / 0.22) * (1 - smooth((uvX - 0.78) / 0.22));
            const frontY = 1.15 * (1 - (1 - sp) ** 1.45) - 0.15 * xRel * xRel + 0.06 * jut;
            const dy = yNorm - frontY;
            const arc =
              (dy >= 0 ? Math.exp(-dy * dy * 24) : Math.exp(-dy * dy * 5.2)) * envelope * xSpan;
            field = Math.min(1, field + arc * 0.52 * surgeScale);
            sampleHorizonTone(
              spectrumCode,
              semantic,
              dark,
              pPhase + dy * 1.3 - sp * 0.35,
              surgeRgb,
            );
            const lead = customMode ? surgeRgb : dark ? [92, 198, 252] : [37, 99, 235];
            const wArc = Math.min(0.88, arc * 0.82);
            baseR += (lead[0]! * 0.34 + surgeRgb[0] * 0.66 - baseR) * wArc;
            baseG += (lead[1]! * 0.34 + surgeRgb[1] * 0.66 - baseG) * wArc;
            baseB += (lead[2]! * 0.34 + surgeRgb[2] * 0.66 - baseB) * wArc;
            dotBoost += arc * 0.58 * surgeScale;
          } else if (surge < -0.0001) {
            const cp = Math.min(1, -surge);
            const envelope = Math.sin(cp * Math.PI) * (1 - 0.28 * cp);
            const rx = Math.abs(uvX - 0.5);
            const ringR = 0.04 + 0.43 * (1 - (1 - cp) ** 1.35);
            const dr = (rx - ringR) / 0.135;
            const ripple = Math.exp(-dr * dr) + 0.32 * (1 - cp) * expClamp(rx * rx * 18);
            const dsy = yNorm - (0.7 * (1 - cp) ** 1.35 + 0.04);
            const settle = Math.exp(-dsy * dsy * 13.5) * (1 - smooth((yNorm - 1.05) / 0.3));
            const chime = ripple * settle * envelope;
            field = Math.min(1, field + chime * 0.46 * surgeScale);
            sampleHorizonTone(
              spectrumCode,
              semantic,
              dark,
              uvX * 1.5 + rx * 2 - cp * 0.35,
              surgeRgb,
            );
            const lead = dark ? [214, 238, 255] : [2, 132, 199];
            const leadMix = customMode ? 0 : dark ? 0.78 : 0.55;
            const wChime = Math.min(0.88, chime * 0.84);
            baseR += (lead[0]! * leadMix + surgeRgb[0] * (1 - leadMix) - baseR) * wChime;
            baseG += (lead[1]! * leadMix + surgeRgb[1] * (1 - leadMix) - baseG) * wChime;
            baseB += (lead[2]! * leadMix + surgeRgb[2] * (1 - leadMix) - baseB) * wChime;
            dotBoost += chime * 0.42 * surgeScale;
          }
          if (tooFaint(field)) continue;
          const gx = (cssX - cssW * 0.5) * persp;
          const gy = gyBase + 10 * Math.sin(gx * 0.007 + timeSec * 0.42) - timeSec * 1.4;
          const cellX = gx / 7 - Math.floor(gx / 7) - 0.5;
          const cellY = gy / 7 - Math.floor(gy / 7) - 0.5;
          const dist = Math.sqrt(cellX * cellX + cellY * cellY);
          const band = Math.min(
            1,
            smooth((field - 0.25) / 0.25) * (1 - smooth((field - 0.72) / 0.26)) + dotBoost,
          );
          let fillA: number;
          let dotA: number;
          let R: number;
          let G: number;
          let B: number;
          if (dark) {
            dotA = dist < 0.26 ? (1 - smooth((dist - 0.12) / 0.14)) * band * 0.65 : 0;
            fillA = field * 0.48;
            const mono = spectrumCode === 5;
            R = toByte(baseR + dotA * (mono ? 36 : 72));
            G = toByte(baseG + dotA * (mono ? 36 : 56));
            B = toByte(baseB + dotA * (mono ? 38 : 24));
          } else {
            fillA = Math.min(0.84, field * 0.66 * washGain * lightPresence);
            dotA =
              dist < 0.24
                ? Math.min(
                    0.88,
                    (1 - smooth((dist - 0.14) / 0.1)) *
                      band *
                      (0.52 + 0.44 * Math.sqrt(fillA)) *
                      lightPresence,
                  )
                : 0;
            const hot = 0.24 * smooth((field - 0.65) / 0.35);
            const inkR = baseR * (1 - hot) + (customMode ? baseR * 0.85 : 46) * hot;
            const inkG = baseG * (1 - hot) + (customMode ? baseG * 0.85 : 92) * hot;
            const inkB = baseB * (1 - hot) + (customMode ? baseB * 0.85 : 235) * hot;
            const composite = fillA + dotA * (1 - fillA);
            if (composite <= 0.002) continue;
            const wFill = (fillA * (1 - dotA)) / composite;
            const wDot = dotA / composite;
            R = toByte(inkR * wFill + dotR * wDot);
            G = toByte(inkG * wFill + dotG * wDot);
            B = toByte(inkB * wFill + dotB * wDot);
          }
          const A = Math.round(clamp(fillA + dotA * (1 - fillA), 0, 1) * 255) & 255;
          if (A === 0) continue;
          const packed = LITTLE_ENDIAN
            ? ((A << 24) | (B << 16) | (G << 8) | R) >>> 0
            : ((R << 24) | (G << 16) | (B << 8) | A) >>> 0;
          for (let sy = 0; sy < step && py + sy < h; sy++) {
            const rowOffset = (py + sy) * w + px;
            for (let sx = 0; sx < step && px + sx < w; sx++) out[rowOffset + sx] = packed;
          }
        }
      }
      ctx.putImageData(image, 0, 0);
    },
    release() {
      image = null;
      pixels = null;
    },
    dispose() {},
  };
}

/** Backing-store scale for the horizon: it is a soft gradient, so it renders below native DPR. */
export function resolveHorizonDpr(devicePixelRatio: number, baseScale = 0.72): number {
  const raw = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  if (raw <= 1) return Math.max(0.5, raw * baseScale);
  return clamp(raw * Math.min(0.68, baseScale * 0.9), 0.72, 1.35);
}

const DEFAULT_HORIZON = { reach: 0.47, prism: 0, surge: 0, speed: 1 } as const;
const MIN_HORIZON_DPR = 0.5;
const MAX_HORIZON_DPR = 1.75;

export interface HorizonDrawOptions {
  readonly dark: boolean;
  readonly strength?: number | undefined;
  readonly reach?: number | undefined;
  readonly prism?: number | undefined;
  readonly surge?: number | undefined;
  readonly speed?: number | undefined;
  readonly spectrumCode?: OpticalSpectrumCode | undefined;
  readonly semantic?: AuraSemantic | undefined;
  readonly ambientIntensity?: number | undefined;
  readonly still?: boolean | undefined;
}

export interface HorizonGlowOptions {
  readonly force2D?: boolean;
  /** Called once a lost WebGL context is rebuilt, so the host can schedule a redraw. */
  readonly onContextRestored?: () => void;
}

export interface HorizonGlow {
  readonly mode: RendererMode;
  resize(width: number, height: number, dpr: number): void;
  invalidate(): void;
  clear(): void;
  /** Self-paced flow: owns the flow clock, the breath and the semantic crossfade. */
  draw(nowMs: number, options: HorizonDrawOptions): boolean;
  drawStaticSnapshot(options: HorizonDrawOptions): boolean;
  /** Paints exactly the given uniforms, for hosts that run their own phase machine. */
  drawUniforms(uniforms: HorizonUniforms): boolean;
  isSleeping(): boolean;
  /** Drops the backing store; `resize` brings it back. */
  reclaim(): void;
  dispose(): void;
}

/** Bottom light curtain with halftone dots: WebGL2 when available, Canvas 2D otherwise. */
export function mountBrandHorizonGlow(
  canvas: HTMLCanvasElement,
  options: HorizonGlowOptions = {},
): HorizonGlow {
  const renderer =
    (options.force2D ? null : createHorizonGlRenderer(canvas)) ?? createHorizon2dRenderer(canvas);
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let startMs: number | null = null;
  let lastClockMs: number | null = null;
  let flowSec = 0;
  let lastDrawMs = Number.NEGATIVE_INFINITY;
  let lastKey = "";
  let semanticMix = 0;
  let semanticHold = 0;
  let clearedZero = false;
  let stale = true;
  let sleeping = false;

  const onContextLost = (event: Event) => event.preventDefault();
  const onContextRestored = () => {
    try {
      renderer?.build();
    } catch {
      return;
    }
    stale = true;
    options.onContextRestored?.();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  const canDraw = () =>
    renderer !== null && canvas.width > 0 && canvas.height > 0 && !isCanvasDocHidden(canvas);

  function clearCanvas() {
    renderer?.clear();
    clearedZero = true;
    sleeping = true;
  }

  function render(nowMs: number, opts: HorizonDrawOptions, forceStatic: boolean): boolean {
    if (!renderer || !canDraw()) return false;
    const still = forceStatic || opts.still === true;
    const ambient = clamp(opts.ambientIntensity ?? 1, 0, 1);
    const strength = clamp(opts.strength ?? 1, 0, 1) * ambient;
    if (ambient <= 0 || (forceStatic && strength <= 0)) {
      if (clearedZero) sleeping = true;
      else clearCanvas();
      return false;
    }
    const reach = clamp(opts.reach ?? DEFAULT_HORIZON.reach, 0.05, 1);
    const prism = clamp(opts.prism ?? DEFAULT_HORIZON.prism, 0, 1);
    const surge = clamp(opts.surge ?? DEFAULT_HORIZON.surge, -1, 1);
    const speed = clamp(opts.speed ?? DEFAULT_HORIZON.speed, 0, 3);
    const spectrumCode = opts.spectrumCode ?? 0;
    const semantic = opts.semantic ?? 0;
    // A caller that steers any parameter gets the glow at full presence, without the intro ramp.
    const steered =
      opts.reach !== undefined ||
      opts.prism !== undefined ||
      opts.surge !== undefined ||
      opts.speed !== undefined ||
      opts.spectrumCode !== undefined ||
      opts.semantic !== undefined ||
      opts.ambientIntensity !== undefined;

    startMs ??= nowMs;
    const realSec = still ? 0 : Math.max(0, (nowMs - startMs) / 1000);
    const ramp = still || steered ? 1 : -(Math.cos(Math.PI * clamp(realSec / 1.4, 0, 1)) - 1) * 0.5;
    const basePresence = Math.max(0.22, ramp);
    const semanticTarget = semantic > 0 ? 1 : 0;
    const key = `${opts.dark}|${spectrumCode}|${semantic}|${strength.toFixed(2)}|${reach.toFixed(3)}|${prism.toFixed(3)}|${surge.toFixed(3)}|${speed.toFixed(2)}`;
    const dirty = forceStatic || key !== lastKey || Math.abs(semanticTarget - semanticMix) > 0.005;
    const frameGap = renderer.mode === "webgl2" ? 0 : steered ? 14 : basePresence < 1 ? 33 : 42;
    const tooSoon = frameGap > 0 && Math.abs(nowMs - lastDrawMs) < frameGap;
    if (!stale && !dirty && (still || tooSoon)) {
      if (forceStatic) sleeping = true;
      return false;
    }

    let dtSec = 0;
    if (still) {
      if (forceStatic && flowSec === 0) flowSec = HORIZON_STATIC_FLOW_SEC;
      lastClockMs = nowMs;
      sleeping = true;
    } else {
      sleeping = false;
      if (lastClockMs === null) {
        flowSec = Math.min(HORIZON_STATIC_FLOW_SEC, realSec * speed);
      } else if (nowMs >= lastClockMs) {
        dtSec = Math.min(0.35, (nowMs - lastClockMs) / 1000);
        flowSec += dtSec * speed;
      }
      lastClockMs = nowMs;
    }
    if (semantic > 0) semanticHold = semantic;
    semanticMix = still ? semanticTarget : advanceSemanticMix(semanticMix, semanticTarget, dtSec);
    const breath = forceStatic ? HORIZON_STATIC_BREATH : still ? 0.58 : horizonBreath(flowSec);
    const untouched = !steered && strength >= 0.999;
    renderer.draw(canvas.width, canvas.height, dpr, {
      timeSec: HORIZON_TIME_OFFSET_SEC + flowSec,
      dark: opts.dark,
      intensity: untouched ? breath * (0.2 + 0.8 * strength) : breath * (0.55 + 0.45 * strength),
      presence: basePresence * horizonPresenceGain(strength),
      reach,
      stretch: HORIZON_STRETCH,
      prism,
      surge,
      speed,
      spectrumCode,
      semantic: encodeSemanticUniform(semanticHold, semanticMix),
    });
    clearedZero = false;
    lastDrawMs = nowMs;
    lastKey = key;
    stale = false;
    return true;
  }

  return {
    mode: renderer ? renderer.mode : "none",
    resize(width, height, nextDpr) {
      const w = Math.max(0, Math.round(width));
      const h = Math.max(0, Math.round(height));
      const scale = clamp(nextDpr, MIN_HORIZON_DPR, MAX_HORIZON_DPR);
      const pixelW = Math.max(1, Math.round(w * scale));
      const pixelH = Math.max(1, Math.round(h * scale));
      const unchanged =
        w === cssW &&
        h === cssH &&
        scale === dpr &&
        canvas.width === pixelW &&
        canvas.height === pixelH;
      if (unchanged) return;
      cssW = w;
      cssH = h;
      dpr = scale;
      if (w > 0 && h > 0) {
        canvas.width = pixelW;
        canvas.height = pixelH;
      }
      clearedZero = false;
      stale = true;
    },
    invalidate() {
      stale = true;
    },
    clear: clearCanvas,
    draw: (nowMs, opts) => render(nowMs, opts, false),
    drawStaticSnapshot(opts) {
      stale = true;
      return render(lastClockMs ?? 0, opts, true);
    },
    drawUniforms(uniforms) {
      if (!renderer || !canDraw()) return false;
      renderer.draw(canvas.width, canvas.height, dpr, uniforms);
      clearedZero = false;
      stale = false;
      sleeping = false;
      return true;
    },
    isSleeping: () => sleeping,
    reclaim() {
      canvas.width = 0;
      canvas.height = 0;
      renderer?.release();
      stale = true;
      sleeping = true;
    },
    dispose() {
      sleeping = true;
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      renderer?.dispose();
    },
  };
}
