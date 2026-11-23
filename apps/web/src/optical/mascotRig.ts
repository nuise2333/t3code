import { observeResize } from "~/lib/observeResize";

// Pixel companions (Clawd the crab, the purple cat, three mini crabs) ported from Obsidian Prism's
// dual-mascot-rig.js. Canvas2D on a 3px grid, 100ms ticks (400ms while dozing), 0fps when hidden,
// blurred or under reduced motion.

const PX = 3;
const TICK = 100;
const DOZE_TICK = 400;

export const OFFICIAL_OPEN_REF = [
  "..############..",
  "..############..",
  "..##o######o##..",
  "..##o######o##..",
  "..############..",
  "################",
  "################",
  "..############..",
  "...#.#....#.#...",
  "...#.#....#.#...",
] as const;

interface Frame {
  readonly rows: readonly string[];
  readonly ox: number;
  readonly oy: number;
  readonly grounded?: boolean;
}
type FrameDict = Record<string, Frame>;
type Palette = Readonly<Record<string, string>>;
type ColorResolver = (ch: string, gx: number, gy: number, palette: Palette) => string | undefined;
type OverlayPainter = (
  ctx: CanvasRenderingContext2D,
  oxGrid: number,
  oyGrid: number,
  pxSize: number,
) => void;

const SHARED_PROP_PALETTE: Palette = {
  k: "#9c958c",
  w: "#fbf8f1",
  c: "#ecdfc6",
  g: "#a8a194",
  B: "#5b8fb9",
  b: "#cfe3ee",
  r: "#cc4f45",
  y: "#e8b64a",
  h: "rgba(20, 20, 19, 0.20)",
  d: "#9a8e80",
  D: "#6f8ca6",
  p: "#ef9aa6",
  n: "#8b5e3c",
  l: "#6a6158",
  e: "#78716a",
  F: "#9e3324",
  f: "#c9642a",
  Y: "#e0a23c",
  V: "#fff1dc",
  m: "rgba(120, 112, 104, 0.55)",
  G: "#7dff9b",
  t: "rgba(125, 255, 155, 0.38)",
  N: "#ff6bd6",
  u: "rgba(255, 107, 214, 0.38)",
  W: "#effff3",
  Z: "#232120",
  z: "#756f69",
  A: "#3d8bff",
  E: "#d6e8ff",
  C: "#2753a8",
  i: "rgba(80, 150, 255, 0.78)",
  I: "rgba(80, 150, 255, 0.32)",
  L: "#ff3b30",
  H: "#ffd6d2",
  x: "#b3312a",
  j: "rgba(255, 80, 60, 0.78)",
  J: "rgba(255, 80, 60, 0.32)",
  P: "#d87e64",
  M: "#ded6cc",
  R: "#ff3b4f",
  a: "#c6d9f7",
  v: "#788eac",
};

const PALETTES: Readonly<Record<string, Palette>> = {
  clawd: {
    ...SHARED_PROP_PALETTE,
    "#": "#d97757",
    s: "#bf684c",
    o: "#141413",
    O: "#d97757",
    q: "#e8a88e",
    Q: "#f1cbbb",
  },
  cat: {
    ...SHARED_PROP_PALETTE,
    "#": "#947fd6",
    s: "#735eb5",
    o: "#141413",
    k: "#a89fc4",
    B: "#6a8fd6",
    O: "#947fd6",
    q: "#b6a7e6",
    Q: "#d9cff6",
  },
  cowboy: {
    "#": "#d97757",
    s: "#bf684c",
    o: "#141413",
    H: "#8b5e3c",
    R: "#a6744e",
    h: "rgba(20, 20, 19, 0.18)",
  },
  shades: {
    "#": "#e0896b",
    s: "#c16f53",
    o: "#141413",
    G: "#141413",
    g: "#6d778a",
    w: "#ffffff",
    h: "rgba(20, 20, 19, 0.18)",
  },
  wizard: {
    "#": "#8a74cf",
    s: "#6a56aa",
    o: "#141413",
    M: "#5c4b9e",
    y: "#e8b64a",
    b: "#cfe3ee",
    h: "rgba(20, 20, 19, 0.18)",
  },
};
const EMPTY_PALETTE: Palette = {};
const paletteFor = (id: string): Palette => PALETTES[id] ?? EMPTY_PALETTE;

const F = (rows: readonly string[], ox = 0, oy = 0, grounded = false): Frame =>
  grounded ? { rows, ox, oy, grounded: true } : { rows, ox, oy };

const frameWidth = (fr: Frame) => Math.max(...fr.rows.map((r) => r.length));

function mirrorFrame(fr: Frame, partW: number): Frame {
  const w = frameWidth(fr);
  const rows = fr.rows.map((r) => [...r.padEnd(w, ".")].reverse().join(""));
  return F(rows, partW - (fr.ox + w), fr.oy, Boolean(fr.grounded));
}

function recolorFrame(fr: Frame, map: Readonly<Record<string, string>>): Frame {
  return { ...fr, rows: fr.rows.map((r) => r.replace(/./g, (ch) => map[ch] ?? ch)) };
}

const SPRITE_ATLAS_RAW =
  "c.shadow!w12=2,10,g:12h;w14=1,10,g:14h;w10=3,10,g:10h|c.body!stand=2,0:12#*8;tall=2,-1:12#*9;squash=1,2:.12s./14#*6;squash2=1,4:.12s./14#*4;flat=2,7:12s/12#*2;turnL=2,0:11#s*8;turnR=2,0:s11#*8;leanR=2,0:.12#*4/12#.*4;leanL=1,0:12#.*4/.12#*4;peek=2,4:12#*4|c.eyes!open=4,2:o6.o*2;openL=3,2:o6.o*2;openR=5,2:o6.o*2;half=4,3:o6.o;shut=3,3:oo6.oo;happy=3,2:.o6.o./o.o4.o.o;squint=4,2:o6.o/.o4.o./o6.o;wide=3,2:oo6.oo*2;peekOpen=4,6:o6.o*2;peekHalf=4,7:o6.o;flatEyes=4,8:oo4.oo;blink=3,3:ss6.ss;upL=3,1:o6.o*2;up=4,1:o6.o*2;upR=5,1:o6.o*2|c.mouth!small=6,5:.ss.;yawn=6,5:4s/.ss.|c.legs!stand=2,8:.#.#4.#.#.*2;crouch=2,9:.#.#4.#.#.;tuck=2,8:..#.#..#.#..*2;walkA=2,8:.#.s4.#.s./.#6.#3.;walkB=2,8:.s.#4.s.#./3.#6.#.;dangle=2,8:.#.#4.#.#./.#.#8.*2;dangle2=2,8:.#.#4.#.#./8.#.#.*2;flailA=2,8:#3.#..#3.#/#10.#;flailB=2,8:..#.#..#.#../4.#..#4.;flailC=2,8:#..#4.#..#/3.#4.#..#|c.clawL!stub=0,5:##*2;front=0,5:ss*2;up=0,-2:##*2/#.;peekGrip=1,7:ss;flatLeft=0,8:ss;open=0,4:##/.#/##|c.clawR!stub=14,5:##*2;front=14,5:ss*2;up=14,-2:##*2/.#;low=14,8:3#*2;reach1=14,4:3.##/5#;write1=13,6:ss*2;write2=14,5:ss*2;peekGrip=13,7:ss;flatRight=14,8:ss;open=14,4:##/#./##;waveOut=14,-1:.##*2/#..|k.ears!stand=2,-1:#10.#/##8.##;nod=2,0:#10.#/##8.##;loaf=2,2:#10.#/##8.##;airplane=0,0:##12.##/3#10.3#;peek=2,3:#10.#/##8.##;flat=1,6:#12.#;twitchL=2,-1:11.#/##8.##;twitchR=2,-1:#11./##8.##|k.body!stand=2,1:12#*7;loaf=1,4:.12s./14#*5;stretch=2,0:s11#/12#*2/.11#*2/..10#/12#*2;turnL=2,1:11#s*7;turnR=2,1:s11#*7;leanR=2,1:.12#*4/12#.*3;leanL=1,1:12#.*4/.12#*3|k.eyes!loafShut=3,6:oo6.oo;loafHalf=4,6:o6.o|k.paws!none=0,0:;groom1=12,4:ss*2;groom2=12,3:ss*2;cheer=0,2:#14.#*2;up=0,-1:##12.##*2;peekGrip=1,7:ss10.ss;write1=13,5:ss*2;write2=14,6:ss*2;upR=14,0:##*2|k.tail!up=14,3:.s/.#*2/##;sway=14,3:.#*2/s#/#.;curl=14,4:##/.#/s#;loaf=14,6:.#*2/s#;puff=14,2:.#/##*2/s#/#.|p!quill1=15,3:..B/.B./k..;sheet=12,8:6c/ckk3c/6g;mug=13,4:..4D/3DbwD/D.DbbD/3DbbD/..4D;cloth1=13,2:cw../w3c/.cwc/..c.;cloth2=14,3:..cw/3cw/.cwc/..c.;bowl=12,7:5w/DBwBD/.3D.;bowlEmpty=12,8:D3gD/.3D.;chop1=12,4:3.n/..n./.n../n3.;chop2=12,3:3.n/..n./.n../w3.;fishDish=11,7:.PPsPP./7D/.5D.;fishBone=11,7:.M.M.M./7D/.5D.;envS=12,5:6d/ddwwdd/dwddwd/d4wd/6d;envSOpen=12,4:..dd../.dwwd./6d/d4wd*2/6d;letter=14,1:7d/d5cd/d3gccd/d5cd/d4gcd/d5cd/dggccrd/7d;seed=15,8,g:On/nO;p1=16,7,g:O/l*2;p2=16,6,g:O/l*3;p3=14,5,g:..O../..l../O.l.O/.3l./..l..;p4=14,3,g:..O../O.l.O/.3l./O.l.O/.3l./..l..*2;d1=13,0,g:3.O3./O5.O/.O3.O./7./O5.O/7.*2/3.O3.;d2=13,-2,g:.q3.q./3.q3./q5.q/7./.q3.q./7./3.q3.;wilt1=14,3,g:..q../q.l.q/.3l./q.l.q/.3l./..l..*2;wilt2=14,4,g:q4./.q.q./..ll./.q.l./..ll./..l..;wilt3=15,6,g:Q.Q/.l./Ql./.l.;bfUp=13,-4:B3.B/BB.BB/.BkB./..k..;bfDn=13,-4:5.*2/BBkBB/.BkB.;bfRest=7,-3:..B../.BB../..k..;stickUp=14,-9:WW/GG*6;stickLT=9,-9:5.tt/WG3.tt/.GG..tt/..GG.tt/3.GGtt/4.GGt/5.GG;stickRT=14,-9:tt5./tt3.GW/tt..GG./tt.GG../ttGG3./tGG4./GG5.;sirenDim=5,-4:..LL../.4x.*2/6l;sirenL=5,-4:..Lx../.HLxx./.LLxx./6l;sirenF=5,-4:..HH../.LHHL./.4L./6l;sirenR=5,-4:..xL../.xxLH./.xxLL./6l;beamL=-1,-7:J5./.j4./..j3./6./J3j../6./.Jjj..;beamF=4,-7:J..JJ..J/.j.jj.j.;micStand=1,4,g:6.ZZ6./6.Zz6./6.ZZ6./6.Z7.*2/5.4Z5.;micSink1=1,6,g:6.ZZ6./6.Zz6./6.ZZ6./5.4Z5.;micSink2=1,8,g:6.ZZ6./5.4Z5.;smoke=6,-4:.m./mm./.mm/.m.;iceCrystal=5,-6:..av../.aavv./3a3v/.aavv./..av..;laser0=16,7,g:.p./pRp/.p.;laser1=18,8,g:.R./RpR;laser2=15,8,g:pRp/.R.;blueprint=12,2:7B/B4EBB/BE3BEB/B4EBB/BE3BEB/7B;headband=1,1:.12L.L/..10H..L;goalFlame0=4,-7,g:3.Y3./..fYf../.FfYfF./FfYVYfF;goalFlame1=4,-7,g:..Y4./.fYf..Y/FfYVYf./.FfYfF.;goggles=3,0:gAAg..gAAg/gEAg..gEAg;iceCrystalSpin=6,-7:.av./aavv*2/.av.;flag0=14,-6:l4A./lAAyA./l4A./l5.*4;flag1=14,-6:l..3A/lAAyAA/l3A../l5.*4;shadesProp=3,2:4Z..4Z/ZEZZ..ZEZZ;surfboard=1,8,g:..10A../.A10EA.;waveSplash0=-3,6,g:..E./E.A./.AA.;waveSplash1=-3,6,g:E3./.EA./AA..;cloudBig=12,2:..3w../.w3Ew./5wbw/.5b.;cloudMid=13,3:.3w./wEEbw/.3b.;cubeGlow=13,3:.y.y./A3EA/AEyEA/5A;hourglass0=13,1:5n/.byb./..y../.b.b./5n;hourglass1=13,1:5n/.b.b./..y../.byb./5n;pocketWatch=12,4:..y../.ywy./ywnwy/.3y.;micHand=13,2:.ZZ./ZwZZ/.gg./..g.*2;spotlight=5,-9:..VV../.VyyV./V.yy.V;book0=12,4:5B/B3wB/BwgwB/B3wB/5B;book1=12,4:BB.BB/BwBwB/BwgwB/BwBwB/BB.BB;bulbOff=5,-8:..gg../.g..g.*2/..cc..;bulbOn=5,-9:y.yy.y/.yVVy./y4Vy/..yy../..cc..;hotCup0=12,3:.m..m./m..m../5D./D3nDD/D3nD./.3D..;hotCup1=12,3:m..m../.m..m./5D./D3nDD/D3nD./.3D..;donut0=12,4:.3p./pywpp/pp.pn/5n/.3n.;donut1=12,4:.pp../pyw../pp.pn/5n/.3n.;habCactus=0,0,g:3.P3./..lGl../l.lGl../lGlGl.l/..lGlGl/.5n./..3n..;habLamp=0,0,g:..3l../.l3Vl./.l3Yl./..3l../3.z3.*4/..3z..;habHourglass=0,0,g:.5n./..byb../3.y3./..byb../.5n.|s!heart=5,-7:.r.r./5r/.3r./..r..;spark=5,-8:..y..*2/5y/..y..*2;z1=10,-6:4k/..k./.k../4k;z2=12,-9:3k/.k./3k;vein=5,-7:.r.r./rr.rr/5./rr.rr/.r.r.;bang=6,-8:.r.*3/3./.r.;q=5,-9:.3k./k3.k/3.k./..k../5./..k..;note=5,-8:..kk./..k.k/..k../3k../kk3.;sweat=13,-4:.B./BbB*2/.B.;tilde=5,-7:.k3./k.k.k/3.k.;dozeZ0=12,-3:3k/.k./3k;dozeZ1=13,-7:4k/..k./.k../4k;dozeZ2=14,-12:5k/3.k./..k../.k3./5k;fireSpark0=5,-8:..Y../f3.V/..f..;fireSpark1=5,-9:.V..f/..Y../f4.;fireSpark2=5,-8:f..Y./4.V/.f3.;sleepBubble0=12,4:.b./bEb/.b.;sleepBubble1=12,3:.bb./bEwb/bEEb/.bb.|m!cowboy=0,-2:5.6H5./3.10H3./..12R../..12#../..##o6#o##../16#/..12#../3.#.#4.#.#3.;shades=0,0:..12#../..4Gg##g4G../..12G../16#/..12#../3.#.#4.#.#3.;wizard=0,-3:7.MM7./6.MyMM6./5.6M5./..12M../..12#../..##o6#o##../16#/..12#../3.#.#4.#.#3.|ma.cowboy!trick=0,-2:4.6H6./..10H4./.12R3./..12#../..##o6#o##../16#/..12#../..#..#4.#..#..|ma.shades!trick=0,0:..12#../..GwGGw##GwGGw../..12G../16#/..12#../3.#.#4.#.#3.|ma.wizard!trick=0,-3:5.y10./4.yMyMM7./5.6M5./..12M../..12#../..##o6#o##../16#/..12#y./3.#.#4.#.#.y.";

interface SpriteAtlas {
  c: Record<string, FrameDict>;
  k: Record<string, FrameDict>;
  p: FrameDict;
  s: FrameDict;
  m: FrameDict;
  ma: Record<string, FrameDict>;
}

/** Format: `group[.sub]!name=ox,oy[,g]:row/row*repeat;...|...`, rows run-length encoded as `12#`. */
export function decodeSpriteAtlas(raw: string): SpriteAtlas {
  const out: SpriteAtlas = { c: {}, k: {}, p: {}, s: {}, m: {}, ma: {} };
  for (const sec of raw.split("|")) {
    const bi = sec.indexOf("!");
    const [top, sub] = sec.slice(0, bi).split(".");
    const grp: FrameDict = {};
    for (const item of sec.slice(bi + 1).split(";")) {
      const eq = item.indexOf("=");
      const co = item.indexOf(":", eq + 1);
      const [ox, oy, fl] = item.slice(eq + 1, co).split(",");
      const body = item.slice(co + 1);
      const rows: string[] = [];
      if (body) {
        for (const seg of body.split("/")) {
          const st = seg.indexOf("*");
          const rRaw = st >= 0 ? seg.slice(0, st) : seg;
          const n = st >= 0 ? Number(seg.slice(st + 1)) : 1;
          const row = rRaw.replace(/(\d+)(.)/g, (_, cnt: string, ch: string) =>
            ch.repeat(Number(cnt)),
          );
          for (let i = 0; i < n; i++) rows.push(row);
        }
      }
      grp[item.slice(0, eq)] = F(rows, Number(ox), Number(oy), fl === "g");
    }
    if (top === "p" || top === "s" || top === "m") out[top] = grp;
    else if ((top === "c" || top === "k" || top === "ma") && sub !== undefined) out[top][sub] = grp;
  }
  return out;
}

interface CharacterParts {
  readonly shadow: FrameDict;
  readonly body: FrameDict;
  readonly eyes: FrameDict;
  readonly mouth: FrameDict;
  readonly legs: FrameDict;
  readonly clawL: FrameDict;
  readonly clawR: FrameDict;
  readonly ears: FrameDict;
  readonly paws: FrameDict;
  readonly tail: FrameDict;
}

const ATLAS = decodeSpriteAtlas(SPRITE_ATLAS_RAW);
const group = (set: Record<string, FrameDict>, name: string): FrameDict => (set[name] ??= {});

function must(dict: FrameDict, key: string): Frame {
  const frame = dict[key];
  if (!frame) throw new Error(`mascotRig: missing sprite ${key}`);
  return frame;
}

const CLAWD_PARTS: CharacterParts = {
  shadow: group(ATLAS.c, "shadow"),
  body: group(ATLAS.c, "body"),
  eyes: group(ATLAS.c, "eyes"),
  mouth: group(ATLAS.c, "mouth"),
  legs: group(ATLAS.c, "legs"),
  clawL: group(ATLAS.c, "clawL"),
  clawR: group(ATLAS.c, "clawR"),
  ears: {},
  paws: {},
  tail: {},
};
const CAT_PARTS: CharacterParts = {
  shadow: CLAWD_PARTS.shadow,
  body: group(ATLAS.k, "body"),
  eyes: group(ATLAS.k, "eyes"),
  mouth: CLAWD_PARTS.mouth,
  legs: CLAWD_PARTS.legs,
  clawL: {},
  clawR: {},
  ears: group(ATLAS.k, "ears"),
  paws: group(ATLAS.k, "paws"),
  tail: group(ATLAS.k, "tail"),
};
CAT_PARTS.body.squash = must(CLAWD_PARTS.body, "squash");
CAT_PARTS.body.flat = must(CLAWD_PARTS.body, "flat");
CAT_PARTS.body.peek = must(CLAWD_PARTS.body, "peek");
for (const [ek, ef] of Object.entries(CLAWD_PARTS.eyes)) {
  if (ek === "peekHalf") continue;
  CAT_PARTS.eyes[ek] = ek === "peekOpen" || ek === "flatEyes" ? ef : { ...ef, oy: ef.oy + 1 };
}

const PROPS: FrameDict = ATLAS.p;
{
  const quill1 = must(PROPS, "quill1");
  const bfUp = must(PROPS, "bfUp");
  const bfDn = must(PROPS, "bfDn");
  const iceCrystal = must(PROPS, "iceCrystal");
  PROPS.quill2 = { ...quill1, ox: quill1.ox + 1, oy: quill1.oy + 1 };
  PROPS.bfLeftUp = { ...bfUp, ox: bfUp.ox - 12, oy: bfUp.oy - 1 };
  PROPS.bfLeftDn = { ...bfDn, ox: bfDn.ox - 12, oy: bfDn.oy - 1 };
  PROPS.iceCrystalHi = { ...iceCrystal, oy: iceCrystal.oy - 1 };
}
const SYMS: FrameDict = ATLAS.s;
const MINI_SPRITES: FrameDict = ATLAS.m;
const MINI_ANIM_FRAMES: Record<string, FrameDict> = ATLAS.ma;
for (const id of ["cowboy", "shades", "wizard"]) {
  const b = must(MINI_SPRITES, id);
  group(MINI_ANIM_FRAMES, id).walkB = {
    ox: b.ox,
    oy: b.oy,
    rows: [...b.rows.slice(0, -1), "..s#.#....#.#s.."],
  };
}
for (const k of ["stickUp", "stickLT", "stickRT"]) {
  PROPS[`${k}M`] = recolorFrame(mirrorFrame(must(PROPS, k), 16), { G: "N", t: "u" });
}
PROPS.beamR = mirrorFrame(must(PROPS, "beamL"), 16);
for (const k of ["sirenDim", "sirenL", "sirenF", "sirenR", "beamL", "beamR", "beamF"]) {
  PROPS[`${k}B`] = recolorFrame(must(PROPS, k), { L: "A", H: "E", x: "C", j: "i", J: "I" });
}

// The backdrop fire is generated around the crab silhouette, keeping a white rim glow 'V'.
{
  const sil = new Set<string>();
  for (let y = 0; y <= 7; y++) for (let x = 2; x <= 13; x++) sil.add(`${x},${y}`);
  for (let y = 5; y <= 6; y++) for (const x of [0, 1, 14, 15]) sil.add(`${x},${y}`);
  for (let y = 8; y <= 9; y++) for (const x of [3, 5, 10, 12]) sil.add(`${x},${y}`);
  const glow = (x: number, y: number) =>
    y <= 9 &&
    !sil.has(`${x},${y}`) &&
    [-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => sil.has(`${x + dx},${y + dy}`)));
  const X0 = -3;
  const W = 22;
  type Tongue = readonly [cx: number, h: number, sl: number, sr: number, lean: number];
  const TONGUES: readonly (readonly Tongue[])[] = [
    [
      [-1, 15, 3, 3, 1],
      [3, 2, 3, 3, 0],
      [7, 10, 2, 3, -1.5],
      [11, 4, 3, 3, 0],
      [16, 14, 3, 3, -0.5],
    ],
    [
      [-1, 14, 3, 3, 1.5],
      [3, 3, 3, 3, 0],
      [7, 11, 3, 2, -2],
      [11, 3, 3, 3, 0],
      [16, 15, 3, 3, -1],
    ],
  ];
  const base = (x: number) => (x >= 2 && x <= 13 ? 0 : x >= 0 && x <= 15 ? 5 : 8);
  const mk = (k: number, f: number): Frame => {
    const tips = (TONGUES[f % 2] ?? []).map(([cx, h, sl, sr, lean], i) => {
      const by = base(cx);
      return {
        cx,
        by,
        ty: by - Math.round(h * k),
        sl,
        sr,
        h,
        sw: lean + 2.4 * Math.sin((f * Math.PI) / 2 + i * 1.3),
      };
    });
    const heat = (x: number, y: number) =>
      Math.max(
        -1,
        ...tips.map(({ cx, by, ty, sl, sr, sw }) => {
          const rel = Math.max(0, Math.min(1, (by - y) / Math.max(1, by - ty)));
          const c = cx + sw * rel * rel;
          return y - ty - (x < c ? sl : sr) * Math.abs(x - c);
        }),
      );
    const embers = new Set<string>();
    tips.forEach(({ cx, ty, h, sw }, i) => {
      if (i % 3 === f % 3 && h * k >= 4) {
        embers.add(`${Math.round(cx + sw + (i % 2 ? 1 : -1))},${ty - 2}`);
      }
    });
    let y0 = 0;
    for (let y = -16; y <= 9; y++) {
      for (let i = 0; i < W; i++) {
        if (heat(X0 + i, y) >= 0 || embers.has(`${X0 + i},${y}`)) y0 = Math.min(y0, y);
      }
    }
    const cells: string[] = [];
    for (let y = y0 - 1; y <= 9; y++) {
      cells.push(
        Array.from({ length: W }, (_, i) => {
          const x = X0 + i;
          if (sil.has(`${x},${y}`)) return ".";
          if (glow(x, y)) return "V";
          if (embers.has(`${x},${y}`)) return "f";
          const e = heat(x, y);
          return e < 0 ? "." : e < 1 ? "F" : e < 4 ? "f" : "Y";
        }).join(""),
      );
    }
    return F(cells, X0, y0 - 1, true);
  };
  for (const [lv, k] of [
    [1, 0.35],
    [2, 0.7],
    [3, 1.05],
  ] as const) {
    for (let f = 0; f < 4; f++) PROPS[`fire${lv}${f}`] = mk(k, f);
  }
}

// Rigid layers translate whole under squash; symbol layers only move their anchor when mirrored.
const RIGID_LAYERS = new WeakSet<Frame>();
const SYM_LAYERS = new WeakSet<Frame>();
for (const l of Object.values(PROPS)) RIGID_LAYERS.add(l);
for (const l of Object.values(SYMS)) {
  RIGID_LAYERS.add(l);
  SYM_LAYERS.add(l);
}

const sym = (key: string): Frame | null => SYMS[key] ?? null;

const SHIFT_CACHE = new WeakMap<Frame, Map<string, Frame>>();
function shiftFrame(fr: Frame | null | undefined, dx: number, dy: number): Frame | null {
  if (!fr || (!dx && !dy)) return fr ?? null;
  let bucket = SHIFT_CACHE.get(fr);
  if (!bucket) {
    bucket = new Map();
    SHIFT_CACHE.set(fr, bucket);
  }
  const key = `${dx},${dy}`;
  let out = bucket.get(key);
  if (!out) {
    out = { ...fr, ox: fr.ox + dx, oy: fr.oy + dy };
    bucket.set(key, out);
    if (RIGID_LAYERS.has(fr)) RIGID_LAYERS.add(out);
    if (SYM_LAYERS.has(fr)) SYM_LAYERS.add(out);
  }
  return out;
}

/** Composites Clawd's standing parts onto the official 16x10 reference grid. */
export function resolveClawdStandGrid(): string[] {
  const grid = Array.from({ length: 10 }, () => Array<string>(16).fill("."));
  const paint = (part: Frame) => {
    part.rows.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        const ch = row[rx];
        if (ch === undefined || ch === "." || ch === " ") continue;
        const x = part.ox + rx;
        const y = part.oy + ry;
        const line = grid[y];
        if (line && x >= 0 && x < 16) line[x] = ch;
      }
    });
  };
  paint(must(CLAWD_PARTS.legs, "stand"));
  paint(must(CLAWD_PARTS.body, "stand"));
  paint(must(CLAWD_PARTS.eyes, "open"));
  paint(must(CLAWD_PARTS.clawL, "stub"));
  paint(must(CLAWD_PARTS.clawR, "stub"));
  return grid.map((r) => r.join(""));
}

function drawLayerSet(
  ctx: CanvasRenderingContext2D,
  oxGrid: number,
  oyGrid: number,
  pxSize: number,
  palette: Palette,
  layers: readonly Frame[],
  colorResolver: ColorResolver | null = null,
): void {
  let lf = "";
  for (const part of layers) {
    if (!part.rows.length) continue;
    for (let ry = 0; ry < part.rows.length; ry++) {
      const row = part.rows[ry] ?? "";
      const py = (oyGrid + part.oy + ry) * pxSize;
      const gy = part.oy + ry;
      for (let rx = 0; rx < row.length; rx++) {
        const ch = row[rx] ?? ".";
        if (ch === "." || ch === " ") continue;
        const gx = part.ox + rx;
        const color = colorResolver ? colorResolver(ch, gx, gy, palette) : palette[ch];
        if (!color) continue;
        let r = 1;
        while (rx + r < row.length) {
          const nc = row[rx + r] ?? ".";
          if (nc === "." || nc === " ") break;
          if ((colorResolver ? colorResolver(nc, gx + r, gy, palette) : palette[nc]) !== color) {
            break;
          }
          r++;
        }
        if (color !== lf) ctx.fillStyle = lf = color;
        ctx.fillRect((oxGrid + gx) * pxSize, py, pxSize * r, pxSize);
        rx += r - 1;
      }
    }
  }
}

// Integer-cell squash: elastic body parts composite into one grid, then whole rows/columns are
// removed or duplicated at the seams nearest the center (preferring flat body lines, protecting
// eyes, shade and grounded legs). Every block stays an exact PX square.
function compositeGrid(layers: readonly Frame[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const part of layers) {
    part.rows.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        const ch = row[rx];
        if (ch === "." || ch === " ") continue;
        const x = part.ox + rx;
        const y = part.oy + ry;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    });
  }
  if (minX === Infinity) return null;
  const W = maxX - minX + 1;
  const H = maxY - minY + 1;
  const g = Array.from({ length: H }, () => Array<string>(W).fill("."));
  for (const part of layers) {
    part.rows.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        const ch = row[rx];
        if (ch === undefined || ch === "." || ch === " ") continue;
        const line = g[part.oy + ry - minY];
        if (line) line[part.ox + rx - minX] = ch;
      }
    });
  }
  return { g, minX, minY, W, H };
}

function pickSeams(
  lines: readonly string[],
  count: number,
  remove: boolean,
  protectTail: number,
): Set<number> {
  const n = lines.length;
  if (!count || n < 3) return new Set();
  const center = (n - 1) / 2;
  const cand: { i: number; score: number; pure: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const line = lines[i] ?? "";
    const blank = !/[^.]/.test(line);
    const pure = !blank && /^[#.]+$/.test(line);
    const same = (i > 0 && lines[i - 1] === line) || (i < n - 1 && lines[i + 1] === line);
    let score = Math.abs(i - center) + (pure ? 0 : same ? 2 : 20);
    if (blank) score += 40;
    if (protectTail && i >= n - protectTail) score += 30;
    if (i === 0 || i === n - 1) score += 8;
    cand.push({ i, score, pure });
  }
  cand.sort((a, b) => a.score - b.score || a.i - b.i);
  const chosen = new Set<number>();
  const limit = Math.min(count, n - 2);
  // Removing a non-flat line requires a surviving identical neighbour so the feature never vanishes.
  for (const c of cand) {
    if (chosen.size >= limit) break;
    if (remove && !c.pure) {
      const ok = (j: number) => j >= 0 && j < n && !chosen.has(j) && lines[j] === lines[c.i];
      if (!ok(c.i - 1) && !ok(c.i + 1)) continue;
    }
    chosen.add(c.i);
  }
  for (const c of cand) {
    if (chosen.size >= limit) break;
    chosen.add(c.i);
  }
  return chosen;
}

function buildSeamMap(n: number, removeSet: Set<number>, dupSet: Set<number>): number[] {
  const map: number[] = [];
  for (let i = 0; i < n; i++) {
    if (removeSet.has(i)) continue;
    map.push(i);
    if (dupSet.has(i)) map.push(i);
  }
  return map;
}

/** sqW / sqH are whole-cell deltas: positive stretches, negative squashes. */
function squashLayersToGrid(layers: readonly Frame[], sqW: number, sqH: number) {
  const comp = compositeGrid(layers);
  if (!comp) return null;
  const { g, minX, minY, W, H } = comp;
  const rowsStr = g.map((r) => r.join(""));
  const colsStr = Array.from({ length: W }, (_, x) => g.map((r) => r[x] ?? ".").join(""));
  const dw = Math.max(-(W - 2), Math.round(sqW || 0));
  const dh = Math.max(-(H - 2), Math.round(sqH || 0));
  const colPick = pickSeams(colsStr, Math.abs(dw), dw < 0, 0);
  const rowPick = pickSeams(rowsStr, Math.abs(dh), dh < 0, 2);
  const colMap = buildSeamMap(W, dw < 0 ? colPick : new Set(), dw > 0 ? colPick : new Set());
  const rowMap = buildSeamMap(H, dh < 0 ? rowPick : new Set(), dh > 0 ? rowPick : new Set());
  const newW = colMap.length;
  const newH = rowMap.length;
  const left = minX + Math.round((W - newW) / 2);
  const top = minY + (H - newH);
  const rows = rowMap.map((ry) => colMap.map((cx) => g[ry]?.[cx] ?? ".").join(""));
  const targetOf = (map: readonly number[], src: number, n: number) => {
    for (let s = src; s < n; s++) {
      const t = map.indexOf(s);
      if (t >= 0) return t;
    }
    return map.length;
  };
  const shiftY = (y: number) => {
    if (y > minY + H - 1) return 0;
    const src = Math.max(0, y - minY);
    return top + targetOf(rowMap, src, H) - (minY + src);
  };
  const shiftX = (x: number) => {
    const src = Math.max(0, Math.min(W - 1, x - minX));
    return left + targetOf(colMap, src, W) - (minX + src);
  };
  return { layer: F(rows, left, top), shiftX, shiftY };
}

const LAYER_SIG_MAP = new WeakMap<Frame, string>();

function computeLayersFrameIdx(layers: readonly Frame[]): string {
  let key = "";
  for (const l of layers) {
    let sig = LAYER_SIG_MAP.get(l);
    if (sig === undefined) {
      sig = `${l.ox || 0},${l.oy || 0},${l.grounded ? 1 : 0}:${l.rows.join("/")}`;
      LAYER_SIG_MAP.set(l, sig);
    }
    key += (key ? "|" : "") + sig;
  }
  return key;
}

const CTX_CACHE = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D | null>();
function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  let ctx = CTX_CACHE.get(canvas);
  if (ctx === undefined) {
    ctx = canvas.getContext("2d");
    CTX_CACHE.set(canvas, ctx);
  }
  return ctx;
}

interface RenderLayerOptions {
  readonly mirror?: boolean;
  readonly tyPx?: number;
  readonly sqW?: number;
  readonly sqH?: number;
  readonly clipBottomY?: number | undefined;
  readonly colorResolver?: ColorResolver | null;
  readonly overlayPainter?: OverlayPainter | null;
}

function renderPixelLayers(
  canvas: HTMLCanvasElement,
  dpr: number,
  oxGrid: number,
  oyGrid: number,
  pxSize: number,
  palette: Palette,
  layers: readonly Frame[],
  options: RenderLayerOptions = {},
): void {
  const ctx = contextOf(canvas);
  if (!ctx) return;
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.imageSmoothingEnabled = false;

  const mirror = Boolean(options.mirror);
  // Vertical offsets snap to whole cells so the grid never shears.
  const tyPx = Math.round(Number(options.tyPx || 0) / pxSize) * pxSize;
  const clipBottomY = options.clipBottomY;
  const sqW = Math.round(options.sqW ?? 0);
  const sqH = Math.round(options.sqH ?? 0);
  const anchorX = (oxGrid + 8) * pxSize;
  const colorResolver = options.colorResolver ?? null;
  const overlayPainter = options.overlayPainter ?? null;

  const groundedLayers: Frame[] = [];
  const bodyLayers: Frame[] = [];
  const rigidLayers: Frame[] = [];
  for (const layer of layers) {
    if (layer.grounded) groundedLayers.push(layer);
    else if (RIGID_LAYERS.has(layer)) rigidLayers.push(layer);
    else bodyLayers.push(layer);
  }

  let elasticLayers: Frame[] | undefined;
  if ((sqW || sqH) && bodyLayers.length) {
    const sq = squashLayersToGrid(bodyLayers, sqW, sqH);
    if (sq) {
      elasticLayers = [sq.layer];
      for (const r of rigidLayers) {
        const w = Math.max(1, ...r.rows.map((row) => row.length));
        // Averaging both edges keeps centered symbols centered while side props follow their side.
        const dx = Math.round((sq.shiftX(r.ox) + sq.shiftX(r.ox + w - 1)) / 2);
        const dy = sq.shiftY(r.oy + r.rows.length - 1);
        const shifted = shiftFrame(r, dx, dy);
        if (shifted) elasticLayers.push(shifted);
      }
    }
  }
  elasticLayers ??= [...bodyLayers, ...rigidLayers];

  ctx.save();
  if (typeof clipBottomY === "number") {
    ctx.beginPath();
    ctx.rect(0, 0, cssW, clipBottomY);
    ctx.clip();
  }

  // Shadow, fire backdrop and other grounded layers ignore squash.
  if (groundedLayers.length) {
    ctx.save();
    if (mirror) {
      ctx.translate(anchorX, 0);
      ctx.scale(-1, 1);
      ctx.translate(-anchorX, 0);
    }
    drawLayerSet(ctx, oxGrid, oyGrid, pxSize, palette, groundedLayers);
    ctx.restore();
  }

  ctx.save();
  ctx.translate(0, tyPx);
  if (mirror) {
    const flipSet: Frame[] = [];
    const symSet: Frame[] = [];
    for (const l of elasticLayers) {
      if (SYM_LAYERS.has(l)) symSet.push(l);
      else flipSet.push(l);
    }
    ctx.save();
    ctx.translate(anchorX, 0);
    ctx.scale(-1, 1);
    ctx.translate(-anchorX, 0);
    drawLayerSet(ctx, oxGrid, oyGrid, pxSize, palette, flipSet, colorResolver);
    overlayPainter?.(ctx, oxGrid, oyGrid, pxSize);
    ctx.restore();
    if (symSet.length) {
      const placed = symSet.map((s) => {
        const w = Math.max(1, ...s.rows.map((r) => r.length));
        return { ...s, ox: 16 - (s.ox + w) };
      });
      drawLayerSet(ctx, oxGrid, oyGrid, pxSize, palette, placed, colorResolver);
    }
  } else {
    drawLayerSet(ctx, oxGrid, oyGrid, pxSize, palette, elasticLayers, colorResolver);
    overlayPainter?.(ctx, oxGrid, oyGrid, pxSize);
  }
  ctx.restore();
  ctx.restore();
}

const BLINKABLE_POSES = new Set(["idle", "walk", "lookNod", "readAlong", "gaze"]);
const SLOW_TAIL_POSES = new Set(["idle", "lookNod", "readAlong", "gaze"]);
// Poses with something on the head hide the orchestrator crystal; so do centered symbols.
const CRYSTAL_HIDE_POSES = new Set([
  "siren",
  "onFire",
  "cheerSticks",
  "peek",
  "flat",
  "rickroll",
  "carry",
  "slashGoal",
  "slashBoost",
  "slashSchedule",
  "slashGrill",
  "slashLearnBulb",
]);
const CRYSTAL_OK_SYMS = new Set(
  ["sweat", "z1", "z2", "dozeZ0", "dozeZ1", "dozeZ2", "sleepBubble0", "sleepBubble1"].flatMap(
    (k) => SYMS[k] ?? [],
  ),
);
/** yawnStretch yawns for this many ticks, then stretches. */
const YAWN_STRETCH_SPLIT = 10;

const PLANT_STAGES_C = [
  [5, "seed"],
  [9, "p1"],
  [13, "p2"],
  [17, "p3"],
  [23, "p4"],
  [27, "wilt1"],
  [31, "wilt2"],
] as const;
const PLANT_STAGES_K = [
  [5, "seed"],
  [9, "p1"],
  [13, "p2"],
  [17, "p3"],
  [23, "p4"],
] as const;
const pickStage = (t: readonly (readonly [number, string])[], v: number, fb: string): string => {
  for (const [lim, k] of t) if (v < lim) return k;
  return fb;
};

type PartRef = string | Frame | null;
type PartKey =
  | "backProp"
  | "shadow"
  | "body"
  | "eyes"
  | "legs"
  | "mouth"
  | "prop1"
  | "prop2"
  | "extraSym"
  | "clawL"
  | "clawR"
  | "ears"
  | "paws"
  | "tail";
type PoseState = Record<PartKey, PartRef> & { sink: number };

type BlinkStage = "half" | "closed";
type Side = "L" | "R";
type FaceDir = "left" | "right";

interface ClipOptions {
  readonly clipTick?: number;
  readonly sym?: string | null;
  readonly blinkStage?: BlinkStage | null;
  readonly blink?: boolean;
  readonly breath?: boolean;
  readonly earTwitch?: Side | null;
  readonly clawSnap?: Side | null;
  readonly clipParam?: number | null;
  readonly reduced?: boolean;
  readonly crystal?: boolean;
  readonly crystalBob?: boolean;
  readonly eyeScan?: number;
  readonly noShadow?: boolean;
  readonly dir?: FaceDir;
}

interface PoseCtx {
  readonly isCat: boolean;
  readonly p: CharacterParts;
  readonly poseKey: string;
  readonly tickIdx: number;
  readonly lt: number;
  readonly frameMod: number;
  readonly clipMod: number;
  readonly phase4: number;
  readonly opts: ClipOptions;
  readonly sym: Frame | null;
}

// DSL fields: sh=shadow b=body e=eyes l=legs L=clawL R=clawR a=ears w=paws t=tail 1=prop1 2=prop2
// y=extraSym (only without sym) z=sink. Suffixes: ~f frameMod, ~c clipMod, ~4 phase4, ~3 tick%3;
// a bare ~ is null. C:/K: limit a rule to the crab or the cat.
const POSE_DSL_RAW =
  "flat:sh=w14,b=flat,e=flatEyes,l=~,C:L=flatLeft,C:R=flatRight,K:a=flat,K:t=curl|dangle:sh=~,e=wide,l=dangle/flailA/dangle2/flailB~4,C:b=turnL/turnR~f,C:L=up,C:R=up,K:a=airplane,K:t=puff|write:l=crouch,z=1,1=sheet,2=quill1/quill2~f,C:b=stand/turnR~f,C:R=write1/write2~f,K:a=stand/nod~f,K:w=write1/write2~f,K:t=sway/curl~f|happy:e=happy,C:b=squash/stand~f,C:l=crouch/stand~f,C:L=up,C:R=up,K:a=nod/stand~f,K:w=cheer,K:t=up/puff~f|pet:e=happy,C:b=squash/stand~f,C:l=crouch/stand~f,C:L=up,C:R=up,K:a=nod/stand~f,K:w=cheer,K:t=up/puff~f|jiggle:l=flailA/flailB/flailC~3,e=happy,C:L=up,C:R=up,K:a=stand,K:t=puff|peek:sh=~,b=peek,l=~,C:L=peekGrip,C:R=peekGrip,K:a=peek,K:e=peekOpen,K:w=peekGrip,K:t=loaf|angry:b=squash/stand~f,l=walkA/walkB~f,C:e=squint,K:a=airplane,K:e=wide,K:t=puff|groom:K:a=nod,K:e=shut,K:w=groom1/groom2~f|tilt:b=turnL,e=half,K:a=nod,K:t=curl|wow:e=wide,C:b=tall,C:L=up,C:R=up,K:a=stand,K:w=up,K:t=puff|sulk:b=turnL,e=squint/shut~c,l=tuck,y=vein,C:L=front,C:R=front,K:a=airplane,K:t=curl|polish:b=turnR,1=mug,2=cloth1/cloth2~c,C:R=front,K:a=stand|chaseDot:K:a=airplane,K:b=squash/stretch~c,K:e=wide,K:l=walkA/stand~c,K:t=puff,K:y=spark|stretch:e=shut,y=tilde,C:b=tall,C:l=stand,C:L=up,C:R=up,K:a=stand,K:b=stretch,K:t=puff|spinHop:b=turnR/stand/turnL/squash~4,e=open/open/open/happy~4,l=tuck/tuck/tuck/crouch~4,K:t=puff|cheerSticks:b=squash/stand~f,l=crouch/stand~f,e=happy,1=stickLT/stickUp/stickRT/stickUp~4,2=stickRTM/stickUpM/stickLTM/stickUpM~4,y=note,C:L=up,C:R=up,K:a=stand/nod~c,K:w=up,K:t=puff|chatGreet:b=stand/squash~c,e=happy,y=heart/note~c,C:L=up/stub~c,K:a=nod,K:t=up/puff~c|balance:e=wide,C:L=open,C:R=open,K:a=airplane,K:w=cheer,K:t=puff|worry:e=half/squint~c,l=tuck,y=sweat,C:L=front,C:R=front,K:a=airplane,K:t=curl|salute:e=happy,y=spark,C:R=up,K:a=stand,K:w=upR,K:t=up|carry:C:e=up,C:L=open,C:R=open|slashTeam:e=happy,1=flag0/flag1~c,y=spark,C:R=up,K:a=stand,K:w=upR,K:t=puff|slashBrowser:b=leanR/turnR~c,1=shadesProp,2=surfboard,y=spark,K:a=airplane,K:t=puff|slashGrill:e=squint,1=spotlight,2=micHand,y=q,C:R=front,K:a=nod,K:w=write1,K:t=curl|slashLearnBook:e=half/open~c,1=book0/book1~c,y=note,C:R=front,K:a=nod,K:w=write1,K:t=sway|nightSip:e=half/happy~c,1=hotCup0/hotCup1~c,y=tilde,C:R=front,K:a=nod,K:t=curl|feedCoffee:e=happy,1=hotCup0/hotCup1~c,y=heart,C:R=front,K:a=nod/stand~f,K:t=up/puff~f";

const DSL_KEY_MAP: Readonly<Record<string, PartKey | "sink">> = {
  sh: "shadow",
  b: "body",
  e: "eyes",
  l: "legs",
  L: "clawL",
  R: "clawR",
  a: "ears",
  w: "paws",
  t: "tail",
  1: "prop1",
  2: "prop2",
  y: "extraSym",
  z: "sink",
};
type DslMode = "" | "f" | "c" | "4" | "3";
type DslRule = readonly [
  scope: 0 | 1 | 2,
  prop: PartKey | "sink",
  mode: DslMode,
  value: string | readonly string[] | number | null,
];
const isDslMode = (m: string): m is DslMode =>
  m === "" || m === "f" || m === "c" || m === "4" || m === "3";

const POSE_DSL: Record<string, readonly DslRule[]> = {};
for (const seg of POSE_DSL_RAW.split("|")) {
  const idx = seg.indexOf(":");
  const rules: DslRule[] = [];
  for (const kv of seg.slice(idx + 1).split(",")) {
    let scope: 0 | 1 | 2 = 0;
    let rest = kv;
    if (rest[1] === ":") {
      scope = rest[0] === "K" ? 2 : 1;
      rest = rest.slice(2);
    }
    const eq = rest.indexOf("=");
    const prop = DSL_KEY_MAP[rest.slice(0, eq)];
    if (!prop) continue;
    const rawV = rest.slice(eq + 1);
    const tIdx = rawV.indexOf("~");
    if (rawV === "~") rules.push([scope, prop, "", null]);
    else if (tIdx >= 0) {
      const mode = rawV.slice(tIdx + 1);
      if (isDslMode(mode)) rules.push([scope, prop, mode, rawV.slice(0, tIdx).split("/")]);
    } else rules.push([scope, prop, "", prop === "sink" ? Number(rawV) : rawV]);
  }
  POSE_DSL[seg.slice(0, idx)] = rules;
}

function applyDslPose(s: PoseState, rules: readonly DslRule[] | undefined, c: PoseCtx): void {
  for (const [sc, prop, mode, val] of rules ?? []) {
    if ((sc === 1 && c.isCat) || (sc === 2 && !c.isCat)) continue;
    let v: string | number | null;
    if (Array.isArray(val)) {
      const at =
        mode === "f"
          ? c.frameMod
            ? 0
            : 1
          : mode === "c"
            ? c.clipMod
              ? 0
              : 1
            : mode === "4"
              ? c.phase4
              : c.tickIdx % 3;
      v = val[at] ?? null;
    } else v = typeof val === "string" || typeof val === "number" ? val : null;
    if (prop === "sink") s.sink = typeof v === "number" ? v : 0;
    else if (prop === "extraSym") {
      if (!c.sym) s.extraSym = typeof v === "number" ? null : v;
    } else s[prop] = typeof v === "number" ? null : v;
  }
}

type PoseRecipe = (s: PoseState, c: PoseCtx) => void;

const loafRecipe: PoseRecipe = (s, { isCat, poseKey, phase4, tickIdx }) => {
  if (!isCat) return;
  s.shadow = "w14";
  s.ears = "loaf";
  s.body = "loaf";
  s.legs = null;
  s.eyes = poseKey === "sleep" || phase4 === 3 ? "loafShut" : "loafHalf";
  s.tail = poseKey === "sleep" ? "loaf" : Math.floor(tickIdx / 4) % 2 ? "loaf" : "curl";
};

const POSE_RECIPES: Readonly<Record<string, PoseRecipe | null>> = {
  idle: null,
  squash(s, { isCat, p }) {
    s.shadow = "w14";
    s.body = "squash";
    s.legs = "crouch";
    if (isCat) {
      s.ears = "nod";
      s.eyes = "half";
    } else s.eyes = shiftFrame(p.eyes.squint, 0, 1);
  },
  loaf: loafRecipe,
  sleep(s, c) {
    if (c.isCat) loafRecipe(s, c);
    else {
      s.body = "squash";
      s.eyes = "shut";
      s.legs = "tuck";
    }
  },
  walk(s, { isCat, tickIdx, opts }) {
    const b = Math.floor(tickIdx / 2) % 4;
    s.legs = ["walkA", "stand", "walkB", "stand"][b] ?? "stand";
    if (b % 2 === 0) s.sink = 1;
    if (isCat) s.tail = b < 2 ? "up" : "sway";
    else s.body = opts.dir === "left" ? "turnL" : "turnR";
  },
  peek(s, c) {
    applyDslPose(s, POSE_DSL.peek, c);
    if (!c.isCat) s.eyes = c.phase4 === 3 ? "peekHalf" : "peekOpen";
  },
  polish(s, c) {
    applyDslPose(s, POSE_DSL.polish, c);
    s.eyes = c.phase4 === 2 ? "happy" : "open";
  },
  chaseDot(s, c) {
    if (!c.isCat) return;
    applyDslPose(s, POSE_DSL.chaseDot, c);
    s.prop1 = `laser${c.lt % 3}`;
  },
  eat(s, { isCat, lt, clipMod, sym: cs }) {
    const d = lt > (isCat ? 20 : 22);
    const em = lt > (isCat ? 18 : 20);
    s.body = d ? "stand" : "squash";
    s.legs = d ? "stand" : "crouch";
    s.eyes = d ? "happy" : isCat ? "half" : clipMod ? "half" : "open";
    s.prop1 = em ? "bowlEmpty" : "bowl";
    s.prop2 = em ? null : clipMod ? "chop2" : "chop1";
    s.extraSym = d ? sym("heart") : cs;
    if (isCat) s.ears = "nod";
  },
  eatFish(s, { isCat, lt, clipMod, sym: cs }) {
    const d = lt > 20;
    s.body = d ? "stand" : "squash";
    s.legs = d ? "stand" : "crouch";
    s.eyes = d ? "happy" : isCat ? (clipMod ? "half" : "open") : "half";
    s.prop1 = lt > 18 ? "fishBone" : "fishDish";
    s.extraSym = d ? sym("heart") : cs;
    if (isCat) {
      s.ears = d ? "stand" : "nod";
      s.tail = clipMod ? "sway" : "up";
    }
  },
  catStretch(s, { isCat, lt }) {
    if (!isCat) return;
    if (lt >= 18) {
      s.ears = "loaf";
      s.body = "loaf";
      s.eyes = "loafHalf";
      s.legs = null;
      s.tail = "loaf";
      s.extraSym = sym("z1");
    } else {
      s.ears = "nod";
      s.body = "stretch";
      s.eyes = "shut";
      s.tail = "up";
      s.extraSym = sym("tilde");
    }
  },
  letter(s, { isCat, lt, sym: cs }) {
    s.body = "turnR";
    s.eyes = lt >= 10 && lt <= 18 ? "half" : lt > 18 ? "happy" : "open";
    s.prop1 = lt < 6 ? "envS" : lt < 11 ? "envSOpen" : "letter";
    s.extraSym = lt > 18 ? sym("heart") : cs;
    if (isCat) s.ears = "nod";
  },
  plant(s, { isCat, lt, sym: cs, p }) {
    s.legs = lt < 8 ? "crouch" : "stand";
    if (isCat) {
      s.ears = "nod";
      s.body = lt < 8 ? "squash" : "stand";
      s.eyes = lt >= 16 && lt <= 24 ? "happy" : "open";
      s.prop1 = pickStage(PLANT_STAGES_K, lt, "wilt2");
      s.prop2 = lt >= 17 && lt < 21 ? "d1" : null;
    } else {
      s.body = lt < 8 ? "squash2" : "stand";
      s.clawR = lt < 8 ? "low" : "stub";
      s.eyes =
        lt < 8
          ? shiftFrame(p.eyes.open, 0, 3)
          : lt >= 16 && lt <= 24
            ? "happy"
            : lt > 24
              ? "half"
              : "open";
      s.prop1 = pickStage(PLANT_STAGES_C, lt, "wilt3");
      s.prop2 = lt >= 17 && lt < 21 ? "d1" : lt >= 21 && lt < 23 ? "d2" : null;
      s.extraSym = lt > 28 ? sym("sweat") : cs;
    }
  },
  butterfly(s, { isCat, lt, clipMod, sym: cs }) {
    const lp = lt % 16 >= 8;
    const r = lt >= 24 && lt <= 30;
    s.eyes = r ? "happy" : lp ? "openL" : "openR";
    s.prop1 = r ? "bfRest" : lp ? (clipMod ? "bfLeftUp" : "bfLeftDn") : clipMod ? "bfUp" : "bfDn";
    s.extraSym = r ? sym("spark") : cs;
    if (isCat) {
      s.ears = r ? "nod" : "stand";
      s.tail = clipMod ? "sway" : "puff";
    } else s.clawR = lt % 10 < 5 ? "reach1" : "stub";
  },
  onFire(s, { lt }) {
    const cool = lt >= 30;
    s.backProp = cool ? null : `fire${lt < 5 ? 1 : lt < 10 ? 2 : 3}${lt % 4}`;
    s.prop1 = "mug";
    s.eyes = "open";
    s.extraSym = cool ? (PROPS.smoke ?? null) : sym(`fireSpark${lt % 3}`);
  },
  rickroll(s, { isCat, lt, clipMod, phase4, sym: cs }) {
    s.body = ["leanR", "squash", "leanL", "stand"][phase4] ?? "stand";
    s.eyes = clipMod ? "happy" : "open";
    s.prop1 = lt > 33 ? "micSink2" : lt > 30 ? "micSink1" : "micStand";
    s.extraSym = cs || sym("note");
    if (isCat) {
      s.ears = clipMod ? "stand" : "nod";
      s.paws = "cheer";
    } else {
      s.clawL = clipMod ? "up" : "stub";
      s.clawR = clipMod ? "stub" : "up";
    }
  },
  siren(s, { isCat, lt, clipMod }) {
    const x = Math.floor(lt / 6) % 2 ? "B" : "";
    const i = lt % 4;
    const bn = ["beamL", "beamF", "beamR", null][i] ?? null;
    s.body = clipMod ? "squash" : "stand";
    s.eyes = "wide";
    s.prop1 = `${["sirenL", "sirenF", "sirenR", "sirenDim"][i] ?? "sirenDim"}${x}`;
    s.prop2 = bn ? bn + x : null;
    s.extraSym = clipMod ? sym("bang") : sym("sweat");
    if (isCat) s.ears = "airplane";
  },
  lookNod(s, { isCat, lt, opts, sym: cs }) {
    const fL = opts.dir === "left";
    const at = Number(opts.clipParam ?? (isCat ? 9 : 5));
    const nod = lt >= at && lt < at + 2;
    s.body = fL ? "turnL" : "turnR";
    s.eyes = nod ? "happy" : fL ? "openL" : "openR";
    if (nod) {
      s.sink = 1;
      s.legs = "crouch";
    }
    s.extraSym = cs || (lt >= at + 2 && lt < at + 8 ? (isCat ? sym("heart") : sym("note")) : null);
  },
  readAlong(s, { isCat, lt, sym: cs }) {
    const on = lt >= 2 && lt < 14 && (lt - 2) % 4 < 2;
    s.eyes = on ? "half" : "open";
    if (on) {
      s.sink = 1;
      s.legs = "crouch";
    }
    s.extraSym = cs || (isCat ? null : sym("note"));
  },
  yawn(s, { isCat, lt, sym: cs }) {
    if (lt < 2) {
      if (isCat) s.ears = "nod";
      s.eyes = "half";
      s.mouth = "small";
    } else if (lt < 9) {
      s.eyes = "shut";
      s.mouth = "yawn";
      s.extraSym = cs || (lt >= 4 ? sym("tilde") : null);
      if (isCat) {
        s.ears = "nod";
        s.tail = "puff";
      } else {
        s.body = "tall";
        s.clawL = "up";
        s.clawR = "up";
      }
    } else {
      s.eyes = "half";
      if (isCat) s.tail = "curl";
    }
  },
  wave(s, { isCat, lt, sym: cs }) {
    const w = lt < 12;
    const b = Math.floor(lt / 2) % 2;
    s.eyes = "happy";
    if (isCat) {
      s.ears = "nod";
      s.paws = w && !b ? "upR" : "none";
      s.extraSym = cs || sym("note");
    } else {
      s.clawR = w ? (b ? "waveOut" : "up") : "stub";
      s.extraSym = cs || (w ? sym("note") : sym("heart"));
    }
  },
  gaze(s, { isCat, opts }) {
    const fL = opts.dir === "left";
    const up = opts.clipParam === 1;
    s.body = fL ? "turnL" : "turnR";
    s.eyes = up ? (fL ? "upL" : "upR") : fL ? "openL" : "openR";
    if (isCat && (opts.earTwitch === "L" || opts.earTwitch === "R")) {
      s.ears = opts.earTwitch === "L" ? "twitchL" : "twitchR";
    }
  },
  slashPlan(s, { isCat, lt, sym: cs }) {
    s.body = "turnR";
    s.prop1 = "blueprint";
    s.eyes = lt >= 14 ? "happy" : "open";
    if (lt >= 8 && lt < 11) {
      s.sink = 1;
      s.legs = "crouch";
    }
    s.extraSym = cs || (lt >= 14 ? sym("spark") : sym("note"));
    if (isCat) {
      s.ears = "nod";
      s.paws = "write1";
      s.tail = "sway";
    } else s.clawR = "front";
  },
  slashGoal(s, { isCat, lt, clipMod, sym: cs }) {
    const charge = lt < 8;
    s.backProp = clipMod ? "goalFlame1" : "goalFlame0";
    s.body = charge ? "squash" : "stand";
    s.legs = charge ? "crouch" : "stand";
    s.eyes = lt >= 14 ? "happy" : "squint";
    s.prop1 = "headband";
    s.extraSym = cs || sym("spark");
    if (isCat) {
      s.ears = charge ? "nod" : "stand";
      s.paws = charge ? "cheer" : "up";
      s.tail = "puff";
    } else {
      s.clawL = charge ? "front" : "up";
      s.clawR = charge ? "front" : "up";
    }
  },
  slashBoost(s, { isCat, phase4, sym: cs }) {
    s.eyes = "wide";
    s.prop1 = "goggles";
    s.prop2 =
      ["iceCrystal", "iceCrystalSpin", "iceCrystalHi", "iceCrystalSpin"][phase4] ?? "iceCrystal";
    s.extraSym = cs || sym("spark");
    if (isCat) {
      s.ears = "stand";
      s.paws = "up";
      s.tail = "puff";
    } else {
      s.clawL = "up";
      s.clawR = "up";
    }
  },
  slashBrowser(s, c) {
    applyDslPose(s, POSE_DSL.slashBrowser, c);
    s.backProp = c.clipMod ? "waveSplash1" : "waveSplash0";
  },
  slashCompact(s, { isCat, lt, clipMod, sym: cs }) {
    const done = lt >= 16;
    s.body = done ? "stand" : clipMod ? "squash" : "leanR";
    s.legs = done ? "stand" : clipMod ? "crouch" : "stand";
    s.eyes = done ? "happy" : "squint";
    s.prop1 = lt < 9 ? "cloudBig" : lt < 16 ? "cloudMid" : "cubeGlow";
    s.extraSym = cs || (done ? sym("spark") : null);
    if (isCat) {
      s.ears = done ? "stand" : "nod";
      s.paws = done ? "up" : "cheer";
      s.tail = done ? "puff" : "sway";
    } else {
      s.clawL = done ? "up" : "front";
      s.clawR = done ? "up" : "front";
    }
  },
  slashSchedule(s, { isCat, lt, clipMod, sym: cs }) {
    const nod = lt >= 10 && lt < 14;
    s.prop1 = clipMod ? "hourglass1" : "hourglass0";
    s.prop2 = "pocketWatch";
    s.eyes = nod ? "happy" : clipMod ? "half" : "open";
    if (nod) {
      s.sink = 1;
      s.legs = "crouch";
    }
    s.extraSym = cs || sym("note");
    if (isCat) {
      s.ears = "nod";
      s.tail = "sway";
    } else s.clawR = "front";
  },
  slashLearnBulb(s, { isCat, lt, sym: cs }) {
    const lit = lt >= 9;
    s.prop1 = lit ? "bulbOn" : "bulbOff";
    s.eyes = lit ? "happy" : "half";
    s.extraSym = cs || (lit ? sym("spark") : sym("q"));
    if (isCat) {
      s.ears = lit ? "stand" : "nod";
      s.tail = lit ? "puff" : "curl";
    } else if (lit) s.clawR = "up";
  },
  feedDonut(s, { isCat, lt, clipMod, sym: cs }) {
    s.body = clipMod ? "squash" : "stand";
    s.legs = clipMod ? "crouch" : "stand";
    s.eyes = "happy";
    s.prop1 = lt < 10 ? "donut0" : "donut1";
    s.extraSym = cs || sym("heart");
    if (isCat) {
      s.ears = clipMod ? "nod" : "stand";
      s.tail = clipMod ? "up" : "puff";
    } else s.clawR = "front";
  },
};

export const ALL_POSE_KEYS: readonly string[] = Array.from(
  new Set([...Object.keys(POSE_DSL), ...Object.keys(POSE_RECIPES), "yawnStretch"]),
);

function resolvePart(dict: FrameDict, val: PartRef | undefined): Frame | null {
  return typeof val === "string" ? (dict[val] ?? null) : (val ?? null);
}

type MascotKind = "clawd" | "cat";

/** Resolves one pose frame for one character into its ordered draw layers. */
export function buildClipLayers(
  kind: MascotKind,
  poseKey: string,
  tickIdx: number,
  opts: ClipOptions = {},
): Frame[] {
  if (poseKey === "yawnStretch") {
    const lt = Number(opts.clipTick ?? tickIdx);
    const first = lt < YAWN_STRETCH_SPLIT;
    return buildClipLayers(kind, first ? "yawn" : "stretch", tickIdx, {
      ...opts,
      clipTick: first ? lt : lt - YAWN_STRETCH_SPLIT,
    });
  }
  const isCat = kind === "cat";
  const p = isCat ? CAT_PARTS : CLAWD_PARTS;
  const frameMod = tickIdx % 2;
  const phase4 = tickIdx % 4;
  const clipSym = opts.sym ? sym(opts.sym) : null;
  const lt = Number(opts.clipTick ?? tickIdx);
  const clipMod = lt % 2;
  const blinkStage = opts.blinkStage || (opts.blink ? "closed" : null);

  const s: PoseState = {
    backProp: null,
    shadow: opts.noShadow ? null : "w12",
    body: "stand",
    eyes: opts.eyeScan === -1 ? "openL" : opts.eyeScan === 1 ? "openR" : "open",
    legs: "stand",
    mouth: null,
    prop1: null,
    prop2: null,
    extraSym: clipSym,
    sink: 0,
    clawL: isCat ? null : "stub",
    clawR: isCat ? null : "stub",
    ears: isCat ? "stand" : null,
    paws: isCat ? "none" : null,
    tail: isCat ? (["up", "sway", "curl", "up"][phase4] ?? "up") : null,
  };

  const ctx: PoseCtx = {
    isCat,
    p,
    poseKey,
    tickIdx,
    lt,
    frameMod,
    clipMod,
    phase4,
    opts,
    sym: clipSym,
  };
  if (Object.hasOwn(POSE_RECIPES, poseKey)) POSE_RECIPES[poseKey]?.(s, ctx);
  else if (POSE_DSL[poseKey]) applyDslPose(s, POSE_DSL[poseKey], ctx);

  if (isCat && s.body === "squash" && s.ears === "stand") s.ears = "nod";
  if (isCat && SLOW_TAIL_POSES.has(poseKey)) {
    s.tail = opts.reduced ? "up" : Math.floor(tickIdx / 3) % 2 ? "sway" : "up";
  }
  if (poseKey === "idle") {
    if (isCat) {
      if (opts.earTwitch === "L") s.ears = "twitchL";
      else if (opts.earTwitch === "R") s.ears = "twitchR";
    } else if (opts.clawSnap === "L") s.clawL = "open";
    else if (opts.clawSnap === "R") s.clawR = "open";
    if (opts.breath) {
      s.sink = 1;
      s.legs = "crouch";
      if (s.shadow) s.shadow = "w14";
    }
  }

  const backProp = resolvePart(PROPS, s.backProp);
  const shadow = resolvePart(p.shadow, s.shadow);
  const legs = resolvePart(p.legs, s.legs);
  let body = resolvePart(p.body, s.body);
  let mouth = resolvePart(p.mouth, s.mouth);
  let eyes = resolvePart(p.eyes, s.eyes);
  const prop1 = resolvePart(PROPS, s.prop1);
  const prop2 = resolvePart(PROPS, s.prop2);
  const extraSym = resolvePart(SYMS, s.extraSym);

  if (blinkStage && BLINKABLE_POSES.has(poseKey)) {
    const eyeDx =
      eyes === p.eyes.open ? 0 : eyes === p.eyes.openL ? -1 : eyes === p.eyes.openR ? 1 : null;
    if (eyeDx !== null) {
      eyes = shiftFrame(blinkStage === "half" ? p.eyes.half : p.eyes.blink, eyeDx, 0);
    }
  }

  const present = (layers: readonly (Frame | null)[]) =>
    layers.filter((l): l is Frame => Boolean(l));

  if (!isCat) {
    let clawL = resolvePart(p.clawL, s.clawL);
    let clawR = resolvePart(p.clawR, s.clawR);
    if (s.body === "squash") {
      if (clawL === p.clawL.up) clawL = shiftFrame(clawL, 0, 2);
      if (clawR === p.clawR.up) clawR = shiftFrame(clawR, 0, 2);
    }
    if (s.sink) {
      body = shiftFrame(body, 0, s.sink);
      eyes = shiftFrame(eyes, 0, s.sink);
      clawL = shiftFrame(clawL, 0, s.sink);
      clawR = shiftFrame(clawR, 0, s.sink);
      mouth = shiftFrame(mouth, 0, s.sink);
    }
    let crystal: Frame | null = null;
    if (
      opts.crystal &&
      !CRYSTAL_HIDE_POSES.has(poseKey) &&
      !(extraSym && !CRYSTAL_OK_SYMS.has(extraSym))
    ) {
      crystal = (opts.crystalBob ? PROPS.iceCrystalHi : PROPS.iceCrystal) ?? null;
    }
    return present([
      backProp,
      shadow,
      legs,
      body,
      mouth,
      eyes,
      clawL,
      clawR,
      prop1,
      prop2,
      crystal,
      extraSym,
    ]);
  }

  let ears = resolvePart(p.ears, s.ears);
  let paws = resolvePart(p.paws, s.paws);
  let tail = resolvePart(p.tail, s.tail);
  if (s.sink) {
    body = shiftFrame(body, 0, s.sink);
    ears = shiftFrame(ears, 0, s.sink);
    eyes = shiftFrame(eyes, 0, s.sink);
    paws = shiftFrame(paws, 0, s.sink);
    tail = shiftFrame(tail, 0, s.sink);
    mouth = shiftFrame(mouth, 0, s.sink);
  }
  return present([
    backProp,
    shadow,
    tail,
    legs,
    body,
    mouth,
    ears,
    eyes,
    paws,
    prop1,
    prop2,
    extraSym,
  ]);
}

// Random blink: 1x2 pupil -> 1x1 -> closed (shade line) -> 1x1 -> 1x2.
const BLINK_SINGLE: readonly BlinkStage[] = ["half", "closed", "half"];
const BLINK_DOUBLE: readonly BlinkStage[] = ["half", "closed", "half", "closed", "half"];
const MINI_BLINK_CACHE = new WeakMap<Frame, Frame>();
function miniBlinkFrame(fr: Frame): Frame {
  let out = MINI_BLINK_CACHE.get(fr);
  if (!out) {
    out = recolorFrame(fr, { o: "s" });
    MINI_BLINK_CACHE.set(fr, out);
  }
  return out;
}

type PairEncounter =
  | { readonly kind: "bump"; readonly sign: number }
  | {
      readonly kind: "passBy";
      readonly mover: "A" | "B";
      readonly stationary: "A" | "B";
      readonly dir: number;
    };

interface PairEncounterInput {
  readonly xA?: number;
  readonly yA?: number;
  readonly walkingA?: boolean;
  readonly dirA?: number;
  readonly xB?: number;
  readonly yB?: number;
  readonly walkingB?: boolean;
  readonly dirB?: number;
  readonly contactDist?: number;
  readonly verticalTol?: number;
}

function classifyPairEncounter(opts: PairEncounterInput = {}): PairEncounter | null {
  const {
    xA = 0,
    yA = 0,
    walkingA = false,
    dirA = 1,
    xB = 0,
    yB = 0,
    walkingB = false,
    dirB = -1,
    contactDist = 42,
    verticalTol = 22,
  } = opts;
  if (Math.abs(yA - yB) > verticalTol) return null;
  const dx = xB - xA;
  if (Math.abs(dx) >= contactDist) return null;
  if (!walkingA && !walkingB) return null;
  const sign = dx >= 0 ? 1 : -1;
  const dA = dirA >= 0 ? 1 : -1;
  const dB = dirB >= 0 ? 1 : -1;
  if (walkingA && walkingB && dA * sign > 0 && dB * sign < 0) return { kind: "bump", sign };
  if (walkingA && !walkingB && dA * sign > 0 && Math.abs(dx) >= 10) {
    return { kind: "passBy", mover: "A", stationary: "B", dir: dA };
  }
  if (walkingB && !walkingA && dB * sign < 0 && Math.abs(dx) >= 10) {
    return { kind: "passBy", mover: "B", stationary: "A", dir: dB };
  }
  if (walkingA && walkingB && dA === dB && Math.abs(dx) >= 8) {
    const rearIsA = dA > 0 ? xA < xB : xA > xB;
    return {
      kind: "passBy",
      mover: rearIsA ? "A" : "B",
      stationary: rearIsA ? "B" : "A",
      dir: dA,
    };
  }
  return null;
}

interface CorridorCrab {
  readonly id: string;
  act: unknown;
  x: number;
  px: number;
  dir: number;
  speed: number;
  bumpUntilTick: number;
  passHopUntilTick: number;
  cooldownTick: number;
  blinkAt: number;
}

interface CorridorOptions {
  readonly minX?: number;
  readonly maxX?: number;
  readonly contactDist?: number;
  readonly nowTick?: number;
}

const CRAB_ENCOUNTER_SEQ = new WeakMap<readonly CorridorCrab[], Map<string, number>>();
const finiteOr = (v: number | undefined, fb: number) =>
  v !== undefined && Number.isFinite(v) ? v : fb;

/** Walks free mini crabs along the corridor; head-on contacts alternate bump and vault-over. */
function stepMiniCrabCorridor(
  crabs: readonly CorridorCrab[],
  opts: CorridorOptions = {},
): { type: "crabBump" | "crabPass"; pair: string }[] {
  const minX = finiteOr(opts.minX, 2);
  const maxX = Math.max(minX + 16, finiteOr(opts.maxX, 220));
  const contactDist = finiteOr(opts.contactDist, 26);
  const nowTick = finiteOr(opts.nowTick, 0);
  const events: { type: "crabBump" | "crabPass"; pair: string }[] = [];
  if (crabs.length === 0) return events;

  let pairCounts = CRAB_ENCOUNTER_SEQ.get(crabs);
  if (!pairCounts) {
    pairCounts = new Map();
    CRAB_ENCOUNTER_SEQ.set(crabs, pairCounts);
  }

  for (const mc of crabs) {
    if (mc.act) continue;
    if (!Number.isFinite(mc.px)) mc.px = Number.isFinite(mc.x) ? mc.x : minX;
    if ((mc.bumpUntilTick || -1) > nowTick) {
      mc.px = Math.max(minX, Math.min(maxX, mc.px));
      continue;
    }
    const spd = Number.isFinite(mc.speed) ? mc.speed : 1.0;
    mc.dir = mc.dir >= 0 ? 1 : -1;
    let next = mc.px + mc.dir * spd;
    if (next <= minX) {
      next = minX;
      mc.dir = 1;
    } else if (next >= maxX) {
      next = maxX;
      mc.dir = -1;
    }
    mc.px = next;
  }

  const vault = (
    vaulter: CorridorCrab,
    yielded: CorridorCrab,
    a: CorridorCrab,
    b: CorridorCrab,
  ) => {
    vaulter.px = Math.max(minX, Math.min(maxX, vaulter.px + vaulter.dir * 8));
    vaulter.passHopUntilTick = nowTick + 4;
    yielded.blinkAt = nowTick;
    a.cooldownTick = nowTick + 9;
    b.cooldownTick = nowTick + 9;
    events.push({ type: "crabPass", pair: `${vaulter.id}-${yielded.id}` });
  };

  for (let i = 0; i < crabs.length; i++) {
    const a = crabs[i];
    if (!a || a.act || (a.cooldownTick || -99) > nowTick) continue;
    for (let j = i + 1; j < crabs.length; j++) {
      const b = crabs[j];
      if (!b || b.act || (b.cooldownTick || -99) > nowTick) continue;
      const dx = b.px - a.px;
      if (Math.abs(dx) >= contactDist) continue;
      const sign = dx >= 0 ? 1 : -1;
      const dA = a.dir >= 0 ? 1 : -1;
      const dB = b.dir >= 0 ? 1 : -1;
      const headOn = dA * sign > 0 && dB * sign < 0;
      const sameDirChase = dA === dB && Math.abs(dx) >= 4;
      if (!headOn && !sameDirChase) continue;

      if (headOn) {
        const pairKey = [a.id, b.id].sort().join("-");
        const count = pairCounts.get(pairKey) ?? 0;
        pairCounts.set(pairKey, count + 1);
        if (count % 2 === 0) {
          a.px = Math.max(minX, Math.min(maxX, a.px - sign * 3));
          b.px = Math.max(minX, Math.min(maxX, b.px + sign * 3));
          a.dir = -sign;
          b.dir = sign;
          a.bumpUntilTick = nowTick + 3;
          b.bumpUntilTick = nowTick + 3;
          a.cooldownTick = nowTick + 8;
          b.cooldownTick = nowTick + 8;
          events.push({ type: "crabBump", pair: `${a.id}-${b.id}` });
        } else vault(a, b, a, b);
      } else {
        const rearIsA = dA > 0 ? a.px < b.px : a.px > b.px;
        vault(rearIsA ? a : b, rearIsA ? b : a, a, b);
      }
      break;
    }
  }
  return events;
}

const CHROMA_STOPS: readonly (readonly [number, number, number])[] = [
  [0x42, 0x85, 0xf4],
  [0x9b, 0x72, 0xcb],
  [0xea, 0x43, 0x35],
  [0xfb, 0xbc, 0x04],
  [0x5c, 0xc6, 0xfc],
];
const CHROMA_HEX = ["#4285F4", "#9B72CB", "#EA4335", "#FBBC04", "#5CC6FC"] as const;
const CHROMA_CACHE = new Map<number, string>();

/** The prismatic coat's diagonal spectrum at a grid cell; `phase` scrolls it. */
function evalChromaColorAt(gx: number, gy: number, phase = 0, isShadow = false): string {
  const sum = gx + gy;
  const pNorm = ((phase % 1) + 1) % 1;
  const pStep = Math.round(pNorm * 12);
  const cacheable =
    Number.isInteger(sum) && sum >= -64 && sum <= 128 && Math.abs(pNorm * 12 - pStep) < 1e-5;
  let cKey = 0;
  if (cacheable) {
    cKey = ((pStep % 12) << 9) | ((sum + 64) << 1) | (isShadow ? 1 : 0);
    const hit = CHROMA_CACHE.get(cKey);
    if (hit) return hit;
  }
  const raw = (sum * 0.068 - (cacheable ? (pStep % 12) / 12 : phase)) % 1;
  const u = (raw < 0 ? raw + 1 : raw) * CHROMA_STOPS.length;
  const i0 = Math.floor(u) % CHROMA_STOPS.length;
  const i1 = (i0 + 1) % CHROMA_STOPS.length;
  const t = u - Math.floor(u);
  const s = t * t * (3 - 2 * t);
  const [r0, g0, b0] = CHROMA_STOPS[i0] ?? [0, 0, 0];
  const [r1, g1, b1] = CHROMA_STOPS[i1] ?? [0, 0, 0];
  let r = r0 + (r1 - r0) * s;
  let g = g0 + (g1 - g0) * s;
  let b = b0 + (b1 - b0) * s;
  if (isShadow) {
    r = r * 0.68 + 18 * 0.14;
    g = g * 0.68 + 22 * 0.14;
    b = b * 0.72 + 40 * 0.14;
  }
  const hex = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  const out = `#${hex(r)}${hex(g)}${hex(b)}`;
  if (cacheable) CHROMA_CACHE.set(cKey, out);
  return out;
}

interface GroundBody {
  cx: number;
  readonly halfW: number;
  readonly locked?: boolean;
}

/** One-dimensional push-apart of grounded bodies toward open space; keeps `minGap` clear. */
export function resolveGroundSeparation<T extends GroundBody>(
  bodies: T[],
  stageMinX = 12,
  stageMaxX = 708,
  minGap = 6,
): T[] {
  const clampBody = (b: T) => {
    b.cx = Math.max(stageMinX + b.halfW, Math.min(stageMaxX - b.halfW, b.cx));
  };
  if (bodies.length < 2) {
    const only = bodies[0];
    if (bodies.length === 1 && only && !only.locked) clampBody(only);
    return bodies;
  }
  const span = Math.max(40, stageMaxX - stageMinX);
  const totalHalfW = bodies.reduce((s, b) => s + b.halfW * 2, 0);
  const maxFeasibleGap = Math.max(0, (span - totalHalfW) / (bodies.length - 1));
  const effGap = Math.min(minGap, maxFeasibleGap);

  const ordered = bodies
    .map((b, idx) => ({ b, idx }))
    .sort((a, z) => (Math.abs(a.b.cx - z.b.cx) > 0.01 ? a.b.cx - z.b.cx : a.idx - z.idx))
    .map((x) => x.b);

  for (const b of ordered) if (!b.locked) clampBody(b);

  for (let iter = 0; iter < 6; iter++) {
    let moved = false;
    for (let i = 0; i < ordered.length - 1; i++) {
      const left = ordered[i];
      const right = ordered[i + 1];
      if (!left || !right) continue;
      const req = left.halfW + right.halfW + effGap;
      const dist = right.cx - left.cx;
      if (dist >= req - 0.01) continue;
      const overlap = req - dist;
      moved = true;
      if (left.locked && right.locked) continue;
      if (left.locked) right.cx += overlap;
      else if (right.locked) left.cx -= overlap;
      else {
        const leftRoom = Math.max(0, left.cx - left.halfW - stageMinX);
        const rightRoom = Math.max(0, stageMaxX - (right.cx + right.halfW));
        const sumRoom = leftRoom + rightRoom;
        const wRight = sumRoom > 1 ? rightRoom / sumRoom : 0.5;
        left.cx -= overlap * (1 - wRight);
        right.cx += overlap * wRight;
      }
      if (!left.locked) clampBody(left);
      if (!right.locked) clampBody(right);
    }
    // Two one-way sweeps clear what a wall squeezed back in.
    for (let i = 0; i < ordered.length - 1; i++) {
      const l = ordered[i];
      const r = ordered[i + 1];
      if (!l || !r) continue;
      const req = l.halfW + r.halfW + effGap;
      if (r.cx - l.cx < req && !r.locked) r.cx = Math.min(stageMaxX - r.halfW, l.cx + req);
    }
    for (let i = ordered.length - 1; i > 0; i--) {
      const l = ordered[i - 1];
      const r = ordered[i];
      if (!l || !r) continue;
      const req = l.halfW + r.halfW + effGap;
      if (r.cx - l.cx < req && !l.locked) l.cx = Math.max(stageMinX + l.halfW, r.cx - req);
    }
    if (!moved) break;
  }
  return bodies;
}

type ObstacleAction = "leapfrog" | "autoPerch" | "greetTurn";

/** Leap over the obstacle, hop onto its head, or stop, greet and turn back. */
function chooseObstacleAction(
  opts: { readonly canLeap?: boolean; readonly canPerch?: boolean; readonly roll?: number } = {},
): ObstacleAction {
  const canLeap = opts.canLeap !== false;
  const canPerch = Boolean(opts.canPerch);
  const roll = finiteOr(opts.roll, Math.random());
  if (canLeap && canPerch) {
    if (roll < 0.42) return "leapfrog";
    if (roll < 0.74) return "autoPerch";
    return "greetTurn";
  }
  if (canLeap) return roll < 0.58 ? "leapfrog" : "greetTurn";
  if (canPerch) return roll < 0.52 ? "autoPerch" : "greetTurn";
  return "greetTurn";
}

/** Two companions may stack; the mini crabs raise the tower to five. */
const maxTowerDepth = (miniPileEnabled: boolean): number => (miniPileEnabled ? 5 : 2);

export const canJoinTower = (baseLen: number, riderLen: number, miniPileEnabled: boolean) =>
  baseLen + riderLen <= maxTowerDepth(miniPileEnabled);

const CHROMA_TAP_WINDOW_MS = 2600;
const CHROMA_TAPS = 4;

interface ChromaGates {
  tuned: boolean;
  forged: boolean;
}

/** Tapping the cat while it is in a tower toggles the coat once it is on, or once both gates opened. */
export const isChromaTapEligible = (towerLen: number, coatOn: boolean, gates: ChromaGates) =>
  towerLen >= 2 && (coatOn || (gates.tuned && gates.forged));

/** Records a tap; true (and the window resets) on the fourth tap within 2.6s. */
export function registerChromaTap(tapTimes: number[], now: number): boolean {
  while (tapTimes.length && now - (tapTimes[0] ?? now) > CHROMA_TAP_WINDOW_MS) tapTimes.shift();
  tapTimes.push(now);
  if (tapTimes.length < CHROMA_TAPS) return false;
  tapTimes.length = 0;
  return true;
}

type MascotCamp = "claude" | "gemini";
type MascotYieldMode = "none" | "peek" | "leap";

export interface StagePoseInput {
  readonly actorId: MascotKind;
  readonly camp: MascotCamp;
  readonly yieldMode: MascotYieldMode;
  readonly hasError: boolean;
  readonly streaming: boolean;
  readonly dozing: boolean;
  readonly now: number;
  readonly pose: string;
}

/** Stage-driven pose once drags, beat sequences and clips are out of the way. */
export function resolveStagePose(input: StagePoseInput): string {
  if (input.yieldMode === "peek") return "peek";
  const isLeader =
    (input.camp === "claude" && input.actorId === "clawd") ||
    (input.camp !== "claude" && input.actorId === "cat");
  if (input.hasError && isLeader) return "angry";
  if (input.streaming) return isLeader ? "write" : input.actorId === "cat" ? "loaf" : "sleep";
  if (input.dozing) return "sleep";
  if (!isLeader && input.actorId === "cat" && Math.floor(input.now / 9000) % 2 === 1) {
    return "loaf";
  }
  return input.pose || "idle";
}

type MiniSprite = "walk" | "trick" | "wave" | "sit" | "still";
interface MiniSeg {
  readonly ticks: number;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly arc?: number;
  readonly sprite: MiniSprite;
  readonly hop?: boolean;
  readonly face?: number;
}
interface MiniAct {
  readonly type: "wave" | "scatter" | "chase" | "ride";
  readonly start: number;
  readonly segs: readonly MiniSeg[];
  readonly abort?: (segIdx: number) => boolean;
  readonly onAbort?: () => void;
}
interface Leap {
  readonly cx0: number;
  readonly cx1: number;
  readonly peak: number;
  readonly startTick: number;
  readonly ticks: number;
  readonly landOnto: string | null;
}
interface SeqStep {
  readonly pose: string;
  readonly ticks: number;
  readonly sqW: number;
  readonly sqH: number;
  readonly lift: number;
}
type SeqTuple = readonly [pose: string, ticks: number, sqW?: number, sqH?: number, lift?: number];
interface IdleFx {
  blinkStage: BlinkStage | null;
  breath: boolean;
  earTwitch: Side | null;
  clawSnap: Side | null;
  glance: number;
}
interface RenderCache {
  poseKey: string | null;
  frameIdx: string | null;
  flip: boolean | null;
  tintState: string | null;
  tyPx: number | null;
  sqW: number | null;
  sqH: number | null;
  lastRot: number | null;
  clipBottomY: number | undefined | null;
  cw: number;
  ch: number;
}

interface EntBase {
  readonly id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  balRot: number;
  dragging: boolean;
  ballisticActive: boolean;
  flying: number;
  stackedOn: string | null;
  leap: Leap | null;
  perchUntil: number;
  mirror: boolean;
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  lastDomX: number | null;
  lastDomY: number | null;
  lastDomZ: string | null;
  lastDomRot: number;
  lastDomDirect: boolean | null;
  lastDomDrag: boolean | null;
  glideSeq: number;
  glideUntil: number;
  prevCx: number | null;
  sideEdgeSnap: boolean;
  sidePushOriginX: number | null;
  sideEdgeOffset: number;
  sideEdgeDirectUntil: number;
  reboundNoBump: boolean;
}

interface Actor extends EntBase {
  readonly kind: MascotKind;
  readonly label: string;
  pose: string;
  overridePose: string | null;
  overrideUntil: number;
  overrideRot: number;
  clipStartTick: number;
  sym: string | null;
  symUntil: number;
  throws: number;
  lastThrowAt: number;
  pokeCount: number;
  lastPokeAt: number;
  nodY: number;
  nodUntil: number;
  eyeScan: number;
  patrolDir: number;
  seq: SeqStep[] | null;
  seqStartTick: number;
  seqThen: (() => void) | null;
  blinkTick: number;
  blinkDouble: boolean;
  nextBlinkTick: number;
  breathTick: number;
  nextBreathTick: number;
  twitchTick: number;
  twitchLen: number;
  twitchSide: Side;
  nextTwitchTick: number;
  snapTick: number;
  snapSide: Side;
  nextSnapTick: number;
  glanceDir: number;
  glanceUntil: number;
  glanceSecond: boolean;
  nextGlanceAt: number;
  faceDir: FaceDir | null;
  clipParam: number | null;
  forceTwitchStart: number;
  forceTwitchSide: Side;
  passBoostUntil: number;
  walkStepTick: number;
  readonly lastRender: RenderCache;
}

interface Mini extends EntBase, CorridorCrab {
  readonly kind: "mini";
  act: MiniAct | null;
  nextBlink: number;
  lastX: number;
  lastFrameKey: string | null;
}

type Ent = Actor | Mini;
const isMiniEnt = (ent: Ent | null | undefined): ent is Mini => Boolean(ent && ent.kind === "mini");

interface StartClipOptions {
  readonly rot?: number;
  readonly mirror?: boolean;
  readonly face?: FaceDir | null;
  readonly param?: number | null;
  readonly sym?: string | null | undefined;
  readonly symDurationMs?: number;
  readonly patrolDir?: number;
}

interface ResetOptions {
  readonly keepFly?: boolean;
  readonly keepBallistic?: boolean;
  readonly keepVel?: boolean;
  readonly keepAct?: boolean;
  readonly keepPose?: boolean;
  readonly keepMirror?: boolean;
  readonly keepSeq?: boolean;
}

interface BallisticOptions {
  readonly noSnap?: boolean;
  readonly anticipate?: boolean;
  readonly reboundTargetX?: number;
  readonly reboundNoBump?: boolean;
}

type TheaterStep =
  | {
      readonly at: number;
      readonly who: MascotKind;
      readonly pose: string;
      readonly dur: number;
      readonly opts?: StartClipOptions;
    }
  | { readonly at: number; readonly run: "crabsWave" | "resetHome" };

export interface MascotStageState {
  readonly camp: MascotCamp;
  readonly streaming: boolean;
  /** 3 writes at full speed; anything lower writes at half speed. */
  readonly streamTier: number;
  readonly hasError: boolean;
  readonly yieldMode: MascotYieldMode;
  readonly leapOffsetY: number;
  readonly popoverRightWidth: number;
  readonly miniPileEnabled: boolean;
  readonly orchestrator: boolean;
  readonly reducedMotion: boolean;
}

type MascotEvent =
  | "activity"
  | "slash-cmd"
  | "effort-tier"
  | "vial-high"
  | "aura-complete"
  | "campSwitch"
  | "model-shift"
  | "vial-opened"
  | "code-copied"
  | "files-changed"
  | "complete"
  | "orchestrator"
  | "streamDone"
  | "ripple"
  | "send"
  | "host-sleep";

interface MascotNotifyPayload {
  readonly cmd?: string;
  readonly tier?: string;
  readonly on?: boolean;
  readonly error?: boolean;
  readonly x?: number;
  readonly sleep?: boolean;
}

export interface MascotStage {
  setState(next: Partial<MascotStageState>): void;
  notify(event: MascotEvent, payload?: MascotNotifyPayload): void;
  park(on?: boolean): void;
  resume(): void;
  syncPowerState(): void;
  dispose(): void;
}

const WIN_BLUR_ATTR = "data-optical-win-blur";
const MASCOT_DRAG_ATTR = "data-optical-mascot-drag";
const PEEK_ATTR = "data-optical-mascot-peek";
const CHROMA_STORE_KEY = "t3.optical.chroma_v1";
const ACTOR_IDS = ["cat", "clawd"] as const;
// Survives remounts within the page session, like the upstream host-element expando.
const SESSION_CHROMA_GATES: ChromaGates = { tuned: false, forged: false };

const readChromaSaved = () => {
  try {
    return window.localStorage.getItem(CHROMA_STORE_KEY) === "1";
  } catch {
    return false;
  }
};
const writeChromaSaved = (on: boolean) => {
  try {
    if (on) window.localStorage.setItem(CHROMA_STORE_KEY, "1");
    else window.localStorage.removeItem(CHROMA_STORE_KEY);
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
};

/** Mounts the stage into `hostEl` (emptied first); positions are relative to its bottom-left. */
export function mountMascotStage(
  hostEl: HTMLElement,
  options: Partial<MascotStageState> = {},
): MascotStage {
  const doc = hostEl.ownerDocument;
  const win = doc.defaultView ?? window;
  let hostSleep = false;
  let wb = false;
  const isDocHidden = () => doc.hidden;
  const isAttrB = () => {
    const val = doc.documentElement.getAttribute(WIN_BLUR_ATTR);
    if (val === "1") return true;
    if (val === "0") return false;
    return doc.documentElement.hasAttribute(WIN_BLUR_ATTR);
  };
  const isWindowBlurred = () => isDocHidden() || isAttrB() || wb;
  const isHostSleeping = () => hostSleep;
  const readDpr = () => Math.min(win.devicePixelRatio || 1, 2);
  let dpr = readDpr();
  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const ticksIn = (minMs: number, maxMs: number) =>
    Math.max(1, Math.round(rand(minMs, maxMs) / TICK));

  let tickIdx = 0;
  let disposed = false;
  let parked = false;
  let vramReclaimed = false;
  const isHostDetached = () => !hostEl.isConnected;
  const isVramSleepState = () =>
    disposed || parked || isDocHidden() || isHostSleeping() || isHostDetached();

  let reducedMotion = false;
  let reducedMq: MediaQueryList | null = null;
  const onReducedChange = (e: MediaQueryListEvent) => {
    reducedMotion = e.matches;
    if (reducedMotion) freezeMotion();
    else lastActivityAt = performance.now();
    syncHeartbeat();
  };
  try {
    reducedMq = win.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion = reducedMq.matches;
    reducedMq.addEventListener("change", onReducedChange);
  } catch {
    reducedMotion = false;
    reducedMq = null;
  }
  if (options.reducedMotion !== undefined) reducedMotion = options.reducedMotion;

  const pendingTimers = new Set<number>();
  const later = (ms: number, fn: () => void): number => {
    const id = win.setTimeout(() => {
      pendingTimers.delete(id);
      if (!disposed) fn();
    }, ms);
    pendingTimers.add(id);
    return id;
  };

  // A 96x84 canvas (32x28 cells): feet land at y=81px, leaving room above for fire and props.
  const CANVAS_W = 96;
  const CANVAS_H = 84;
  const OX = 8;
  const OY = 17;

  hostEl.replaceChildren();

  const createCanvas = (className: string) => {
    const cv = doc.createElement("canvas");
    cv.className = className;
    return cv;
  };

  const baseState = (el: HTMLElement, canvas: HTMLCanvasElement) => ({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    rot: 0,
    balRot: 0,
    dragging: false,
    ballisticActive: false,
    flying: 0,
    stackedOn: null,
    leap: null,
    perchUntil: 0,
    mirror: false,
    el,
    canvas,
    lastDomX: null,
    lastDomY: null,
    lastDomZ: null,
    lastDomRot: 0,
    lastDomDirect: null,
    lastDomDrag: null,
    glideSeq: 0,
    glideUntil: 0,
    prevCx: null,
    sideEdgeSnap: false,
    sidePushOriginX: null,
    sideEdgeOffset: 0,
    sideEdgeDirectUntil: 0,
    reboundNoBump: false,
  });

  const createActorState = (id: MascotKind, label: string, phaseTicks: number): Actor => {
    const btn = doc.createElement("div");
    btn.className = "optical-mascot-actor";
    btn.setAttribute("data-mascot-id", id);
    btn.setAttribute("data-no-press-spring", "1");
    btn.setAttribute("role", "button");
    // Pointer-only toys; a tab stop would add two dead stops to the composer.
    btn.setAttribute("tabindex", "-1");
    btn.setAttribute("aria-label", label);
    const cv = createCanvas("optical-mascot-canvas");
    cv.width = Math.round(CANVAS_W * dpr);
    cv.height = Math.round(CANVAS_H * dpr);
    cv.style.transformOrigin = `${(OX + 8) * PX}px ${(OY + 10) * PX}px`;
    btn.appendChild(cv);
    return {
      ...baseState(btn, cv),
      id,
      kind: id,
      label,
      pose: "idle",
      overridePose: null,
      overrideUntil: 0,
      overrideRot: 0,
      clipStartTick: 0,
      sym: null,
      symUntil: 0,
      throws: 0,
      lastThrowAt: 0,
      pokeCount: 0,
      lastPokeAt: 0,
      nodY: 0,
      nodUntil: 0,
      eyeScan: 0,
      patrolDir: 1,
      seq: null,
      seqStartTick: 0,
      seqThen: null,
      blinkTick: -99,
      blinkDouble: false,
      nextBlinkTick: phaseTicks + ticksIn(2400, 6000),
      breathTick: -99,
      nextBreathTick: phaseTicks + ticksIn(2800, 4200),
      twitchTick: -99,
      twitchLen: 1,
      twitchSide: "R",
      nextTwitchTick: phaseTicks + ticksIn(6000, 10000),
      snapTick: -99,
      snapSide: "R",
      nextSnapTick: phaseTicks + ticksIn(8000, 12000),
      glanceDir: 0,
      glanceUntil: 0,
      glanceSecond: false,
      nextGlanceAt: performance.now() + phaseTicks * TICK + rand(3000, 7000),
      faceDir: null,
      clipParam: null,
      forceTwitchStart: -99,
      forceTwitchSide: "R",
      passBoostUntil: 0,
      walkStepTick: -1,
      lastRender: {
        poseKey: null,
        frameIdx: null,
        flip: null,
        tintState: null,
        tyPx: null,
        sqW: null,
        sqH: null,
        lastRot: null,
        clipBottomY: null,
        cw: 0,
        ch: 0,
      },
    };
  };

  const actors: Record<MascotKind, Actor> = {
    clawd: createActorState("clawd", "Claude Clawd", 0),
    cat: createActorState("cat", "Gemini Cat", 14),
  };

  const miniGroupEl = doc.createElement("div");
  miniGroupEl.className = "optical-mascot-minis";
  miniGroupEl.style.zIndex = "auto";
  const miniCrabs: Mini[] = (
    [
      ["cowboy", 16, 1, 1.05],
      ["shades", 76, -1, 0.86],
      ["wizard", 136, 1, 1.18],
    ] as const
  ).map(([id, x, dir, speed]): Mini => {
    const cv = createCanvas("optical-mascot-mini");
    cv.width = Math.round(40 * dpr);
    cv.height = Math.round(32 * dpr);
    cv.dataset.miniCrab = id;
    cv.style.pointerEvents = "auto";
    cv.style.cursor = "grab";
    cv.style.touchAction = "none";
    cv.style.transformOrigin = "20px 26px";
    miniGroupEl.appendChild(cv);
    return {
      ...baseState(cv, cv),
      id,
      kind: "mini",
      x,
      dir,
      speed,
      blinkAt: -99,
      nextBlink: ticksIn(1500, 6000),
      lastX: x,
      px: x,
      bumpUntilTick: -1,
      passHopUntilTick: -1,
      cooldownTick: -1,
      act: null,
      lastFrameKey: null,
    };
  });
  hostEl.appendChild(miniGroupEl);
  hostEl.appendChild(actors.cat.el);
  hostEl.appendChild(actors.clawd.el);

  const rAF = (fn: FrameRequestCallback) => win.requestAnimationFrame(fn);

  let camp: MascotCamp = options.camp === "claude" ? "claude" : "gemini";
  let streaming = Boolean(options.streaming);
  let streamTier = Number(options.streamTier || 2);
  let hasError = Boolean(options.hasError);
  let yieldMode: MascotYieldMode = options.yieldMode || "none";
  let leapOffsetY = Number(options.leapOffsetY || 0);
  let popoverRightWidth = Number(options.popoverRightWidth || 0);
  let miniPileEnabled = Boolean(options.miniPileEnabled);
  let orchestrator = Boolean(options.orchestrator);
  let prismaticCoat = readChromaSaved();
  const chromaGates = SESSION_CHROMA_GATES;
  const chromaTapTimes: number[] = [];
  let chromaPhase = 0;
  const chromaSparks: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
    color: string;
    size: number;
  }[] = [];
  let fxCanvasCleared = true;

  // Dozing: 45s (30s late at night) without activity yawns, then sleeps; any activity wakes.
  const DOZE_AFTER_MS = 45000;
  const DOZE_AFTER_NIGHT_MS = 30000;
  let dozing = false;
  let lastActivityAt = performance.now();
  let lastHandoffAt = 0;
  let duetUntil = 0;
  let lastCrabStepTick = -1;
  const pairCooldowns = new Map<string, number>();
  const canTriggerPair = (key: string, now: number, cdMs: number) => {
    const until = pairCooldowns.get(key) ?? 0;
    if (now < until) return false;
    pairCooldowns.set(key, now + cdMs);
    return true;
  };
  let theaterTimer = 0;
  let theaterCursor = 0;
  let tickTimer: number | null = null;
  let currentTickMs = 0;
  let lastMiniDisplay: string | null = null;

  const fxCanvas = createCanvas("optical-mascot-fx");
  const releaseFxCanvas = () => {
    fxCanvas.width = fxCanvas.height = 0;
    fxCanvas.style.width = fxCanvas.style.height = "0px";
    fxCanvas.style.display = "none";
    fxCanvasCleared = true;
  };
  releaseFxCanvas();
  hostEl.appendChild(fxCanvas);

  // Corner habitat prop behind the pair; draws one frame on a state change, otherwise 0fps.
  const habitatCanvas = createCanvas("optical-mascot-habitat");
  habitatCanvas.setAttribute("aria-hidden", "true");
  hostEl.appendChild(habitatCanvas);
  let scheduleWatchUntil = 0;
  let lastHabitatKey = "";
  const isLateNight = () => {
    const h = new Date().getHours();
    return h >= 23 || h < 5;
  };
  const resolveHabitatMode = () => {
    if (Date.now() < scheduleWatchUntil) return "hourglass";
    return isLateNight() ? "lamp" : "cactus";
  };
  const renderHabitatProp = (force = false) => {
    if (isVramSleepState()) return;
    const mode = resolveHabitatMode();
    const key = `${mode}:${dpr}`;
    if (!force && key === lastHabitatKey && habitatCanvas.width > 0 && habitatCanvas.height > 0) {
      return;
    }
    lastHabitatKey = key;
    const cssW = 24;
    const cssH = 30;
    habitatCanvas.width = Math.round(cssW * dpr);
    habitatCanvas.height = Math.round(cssH * dpr);
    const ctx = contextOf(habitatCanvas);
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.imageSmoothingEnabled = false;
    const propKey =
      mode === "lamp" ? "habLamp" : mode === "hourglass" ? "habHourglass" : "habCactus";
    const spr = PROPS[propKey];
    if (!spr) return;
    const cell = 3;
    const oy = Math.max(0, Math.floor(cssH / cell) - spr.rows.length);
    drawLayerSet(ctx, 0, oy, cell, paletteFor("clawd"), [spr]);
    habitatCanvas.setAttribute("data-habitat-mode", mode);
  };
  renderHabitatProp(true);

  // Sleeping canvases shrink to 0x0 so a hidden, parked or detached stage holds no GPU memory.
  const reclaimStageVram = () => {
    if (vramReclaimed) return;
    vramReclaimed = true;
    releaseFxCanvas();
    habitatCanvas.width = 0;
    habitatCanvas.height = 0;
    lastHabitatKey = "";
    for (const id of ACTOR_IDS) {
      const a = actors[id];
      a.canvas.width = 0;
      a.canvas.height = 0;
      a.lastRender.poseKey = null;
      a.lastRender.cw = 0;
      a.lastRender.ch = 0;
    }
    for (const mc of miniCrabs) {
      mc.canvas.width = 0;
      mc.canvas.height = 0;
      mc.lastFrameKey = null;
    }
  };

  const sizeCanvases = () => {
    for (const id of ACTOR_IDS) {
      const a = actors[id];
      a.canvas.width = Math.round(CANVAS_W * dpr);
      a.canvas.height = Math.round(CANVAS_H * dpr);
      a.lastRender.poseKey = null;
    }
    for (const mc of miniCrabs) {
      mc.canvas.width = Math.round(40 * dpr);
      mc.canvas.height = Math.round(32 * dpr);
      mc.lastFrameKey = null;
    }
  };

  const restoreStageVram = () => {
    if (!vramReclaimed && actors.cat.canvas.width > 0 && actors.clawd.canvas.width > 0) {
      return false;
    }
    dpr = readDpr();
    vramReclaimed = false;
    sizeCanvases();
    lastHabitatKey = "";
    return true;
  };

  // Towers: any entity can ride another; pulling the base lets the riders fall into place.
  const miniById = new Map(miniCrabs.map((m) => [m.id, m]));
  const getEnt = (id: string | null | undefined): Ent | null =>
    id === "cat" || id === "clawd" ? actors[id] : id ? (miniById.get(id) ?? null) : null;
  const entHalfW = (ent: Ent) => (isMiniEnt(ent) ? 13 : 22);
  const mountStepH = (holderId: string) => (holderId === "cat" || holderId === "clawd" ? 26 : 16);
  const allActiveEnts = (): Ent[] =>
    miniPileEnabled ? [actors.cat, actors.clawd, ...miniCrabs] : [actors.cat, actors.clawd];
  const maxTowerDepthAllowed = () => maxTowerDepth(miniPileEnabled);

  const syncStageDpr = () => {
    const nextDpr = readDpr();
    if (nextDpr === dpr) return false;
    dpr = nextDpr;
    sizeCanvases();
    return true;
  };

  const cleanups: (() => void)[] = [];
  let rootMascotDragAttr = false;
  const syncMascotDragRootAttr = () => {
    const anyDragging =
      !disposed &&
      (actors.cat.dragging || actors.clawd.dragging || miniCrabs.some((mc) => mc.dragging));
    if (rootMascotDragAttr === anyDragging) return;
    rootMascotDragAttr = anyDragging;
    if (anyDragging) doc.documentElement.setAttribute(MASCOT_DRAG_ATTR, "1");
    else doc.documentElement.removeAttribute(MASCOT_DRAG_ATTR);
  };
  let hasMeasuredHostWidth = hostEl.clientWidth > 0;
  let cachedHostWidth = hasMeasuredHostWidth ? hostEl.clientWidth : 0;
  let pdOn = false;
  let reboundTm: number | null = null;
  let resizeRaf = 0;
  let pendPrevW = 0;
  let pendNextW = 0;
  const isStageResizing = () => pdOn;
  const snapRot = (deg: number) => {
    const v = Number(deg) || 0;
    return Math.abs(v) < 0.05 ? 0 : Math.round(v * 100) / 100;
  };
  const applyMiniTransform = (mc: Mini, tx: number, ty: number, tz: string | null, rot = 0) => {
    const dom = mc.canvas;
    const nextRot = snapRot(rot);
    if (mc.lastDomX !== tx || mc.lastDomY !== ty || mc.lastDomRot !== nextRot) {
      mc.lastDomX = tx;
      mc.lastDomY = ty;
      mc.lastDomRot = nextRot;
      dom.style.transform = nextRot
        ? `translate3d(${tx}px, ${ty}px, 0) rotate(${nextRot}deg)`
        : `translate3d(${tx}px, ${ty}px, 0)`;
    }
    if (tz != null && mc.lastDomZ !== tz) {
      mc.lastDomZ = tz;
      dom.style.zIndex = tz;
    }
  };
  const clearReboundTimer = () => {
    if (reboundTm) {
      win.clearTimeout(reboundTm);
      pendingTimers.delete(reboundTm);
      reboundTm = null;
    }
  };
  {
    const onPd = () => {
      pdOn = true;
    };
    // Releasing a pointer ends a panel or window resize drag; snapped companions spring back.
    const onPu = () => {
      const wasDown = pdOn;
      pdOn = false;
      if (wasDown) onStageResizeReleased();
    };
    const pOpt = { capture: true, passive: true };
    win.addEventListener("pointerdown", onPd, pOpt);
    win.addEventListener("pointerup", onPu, pOpt);
    win.addEventListener("pointercancel", onPu, pOpt);
    win.addEventListener("blur", onPu);
    cleanups.push(() => {
      clearReboundTimer();
      if (resizeRaf) {
        win.cancelAnimationFrame(resizeRaf);
        resizeRaf = 0;
      }
      win.removeEventListener("pointerdown", onPd, pOpt);
      win.removeEventListener("pointerup", onPu, pOpt);
      win.removeEventListener("pointercancel", onPu, pOpt);
      win.removeEventListener("blur", onPu);
    });
  }
  const maxXFor = (w: number) =>
    Math.max(
      8,
      Math.max(
        96,
        w - 14 - (popoverRightWidth > 0 ? Math.min(w - 150, popoverRightWidth + 16) : 0),
      ) - 80,
    );
  const miniZ = (m: Mini) => {
    const depth = m.stackedOn ? getStackDepth(m.id) : 0;
    return m.dragging ? "39" : depth > 0 ? String(25 + depth * 2) : "25";
  };
  const syncTower = (a: Ent, now = performance.now()) => {
    if (isMiniEnt(a)) {
      const direct = syncDirectMotionDomAttr(a, a.canvas);
      const tx = snapCoord(Number.isFinite(a.px) ? a.px : a.x, direct);
      const ty = snapCoord(a.y || 0, direct);
      applyMiniTransform(a, tx, ty, miniZ(a), a.dragging || a.ballisticActive ? a.rot : 0);
    } else {
      applyActorTransform(a, now);
    }
    for (const cid of getTowerMembers(a.id)) {
      if (cid === a.id) continue;
      const r = getEnt(cid);
      if (!r) continue;
      if (isMiniEnt(r)) {
        const direct = syncDirectMotionDomAttr(r, r.canvas);
        const tx = snapCoord(getEntWorldCx(a) - 32, direct);
        const ty = snapCoord(computeWorldFootY(r), direct);
        r.px = tx;
        r.lastX = Math.round(tx);
        applyMiniTransform(r, tx, ty, miniZ(r), 0);
      } else {
        applyActorTransform(r, now);
      }
    }
  };
  const freeMain = (a: Actor) => !a.dragging && !a.stackedOn;
  const applyReboundGlide = (a: Ent) => {
    if (reducedMotion) return;
    const now = performance.now();
    for (const cid of getTowerMembers(a.id)) {
      const ent = getEnt(cid);
      if (!ent) continue;
      const seq = (ent.glideSeq += 1);
      ent.glideUntil = now + 320;
      ent.el.style.transition = "transform 320ms cubic-bezier(.22,1,.36,1)";
      later(340, () => {
        if (
          !disposed &&
          ent.glideSeq === seq &&
          !ent.lastDomDirect &&
          ent.el.style.transition.includes("320ms")
        ) {
          ent.el.style.transition = "";
          ent.glideUntil = 0;
        }
      });
    }
  };
  const launchRebound = (a: Actor, targetCapX: number) => {
    if (disposed || !freeMain(a) || !a.sideEdgeSnap || a.sidePushOriginX == null) return;
    const ox = a.sidePushOriginX;
    const fm = maxXFor(Math.max(readStageWidth(), cachedHostWidth));
    const tx = Math.max(8, Math.min(ox, targetCapX, fm));
    const dist = tx - a.x;
    a.sideEdgeSnap = false;
    a.sidePushOriginX = null;
    a.sideEdgeOffset = 0;
    a.sideEdgeDirectUntil = 0;
    if (dist >= 28 && !reducedMotion && !findDirectRider(a.id)) {
      const vy0 = -Math.max(4.6, Math.min(8.2, 4.4 + dist / 220));
      let svy = vy0;
      let sy = 0;
      let sb = 0;
      let sGain = 0;
      let sMul = 1;
      for (let t = 0; t < 160; t++) {
        svy += 0.44;
        sMul *= 0.988;
        svy *= 0.988;
        sy += svy;
        sGain += sMul;
        if (sy >= 0) {
          sy = 0;
          if (Math.abs(svy) > 2.4 && sb < 2) {
            svy = -svy * 0.36;
            sMul *= 0.82;
            sb += 1;
          } else break;
        }
      }
      const vx0 = dist / Math.max(1, sGain);
      startEntityBallistic(a, vx0, vy0, { noSnap: true, reboundTargetX: tx, reboundNoBump: true });
      renderAllFrames(performance.now());
    } else if (tx > a.x + 1) {
      a.x = tx;
      syncTower(a);
      applyReboundGlide(a);
    } else {
      syncTower(a);
    }
  };
  const snappedMains = () =>
    [actors.cat, actors.clawd]
      .filter((a) => freeMain(a) && a.sideEdgeSnap && a.sidePushOriginX != null)
      .sort((u, v) => (v.sidePushOriginX ?? 0) - (u.sidePushOriginX ?? 0));
  const scheduleRebound = () => {
    clearReboundTimer();
    reboundTm = later(120, () => {
      reboundTm = null;
      if (isStageResizing()) return;
      let capX = maxXFor(Math.max(readStageWidth(), cachedHostWidth));
      const targets = snappedMains().map((a) => {
        const tx = Math.max(8, Math.min(a.sidePushOriginX ?? 0, capX));
        capX = Math.max(8, tx - 56);
        return { a, tx };
      });
      targets.forEach(({ a, tx }, idx) => {
        if (idx) later(55 * idx, () => launchRebound(a, tx));
        else launchRebound(a, tx);
      });
    });
  };
  const onStageResizeReleased = () => {
    if (disposed || isStageResizing()) return;
    const snapped = snappedMains();
    if (!snapped.length) return;
    let capX = maxXFor(Math.max(readStageWidth(), cachedHostWidth));
    let needReb = false;
    for (const a of snapped) {
      const tx = Math.max(8, Math.min(a.sidePushOriginX ?? 0, capX));
      capX = Math.max(8, tx - 56);
      if (tx > a.x + 2) needReb = true;
    }
    if (needReb) scheduleRebound();
    else {
      for (const a of snapped) {
        a.sideEdgeDirectUntil = 0;
        syncDirectMotionDomAttr(a, a.el);
      }
    }
  };
  const handleStageWidthResize = (prevW: number, nw: number) => {
    if (disposed || !Number.isFinite(nw) || nw <= 0 || nw === prevW) return;
    const now = performance.now();
    const nextMaxX = maxXFor(nw);
    const mains = [actors.cat, actors.clawd] as const;
    const resizingNow = isStageResizing();
    if (nw < prevW) {
      clearReboundTimer();
      // Fast path: nothing near the right edge, nothing to do.
      if (!mains.some((a) => freeMain(a) && a.x >= nextMaxX - 96)) return;
      const beforeX = mains.map((a) => a.x);
      const order = [0, 1].sort((i, j) => (beforeX[j] ?? 0) - (beforeX[i] ?? 0));
      let capX = nextMaxX;
      for (const i of order) {
        const a = mains[i];
        if (!a || !freeMain(a)) continue;
        if (a.x > capX) {
          a.x = capX;
          capX = Math.max(8, capX - 1);
        } else capX = Math.min(capX, Math.max(8, a.x - 1));
      }
      enforceGroundSeparation();
      mains.forEach((a, i) => {
        const before = beforeX[i] ?? a.x;
        if (!freeMain(a)) return;
        if (a.x < before - 0.5 || a.x >= nextMaxX - 4) {
          a.sidePushOriginX ??= before;
          a.sideEdgeSnap = true;
          a.sideEdgeOffset = Math.max(0, nextMaxX - a.x);
          a.sideEdgeDirectUntil = now + (resizingNow ? 220 : 180);
          syncTower(a, now);
        }
      });
      return;
    }
    if (!mains.some((a) => freeMain(a) && a.sideEdgeSnap && a.sidePushOriginX != null)) return;
    let needReb = false;
    const prevMaxX = maxXFor(prevW);
    for (const a of mains) {
      if (!freeMain(a) || !a.sideEdgeSnap || a.sidePushOriginX == null) continue;
      const off = a.sideEdgeOffset || 0;
      if (!reboundTm && a.x < prevMaxX - off - 64) {
        a.sideEdgeSnap = false;
        a.sidePushOriginX = null;
        continue;
      }
      const tx = Math.min(a.sidePushOriginX, Math.max(8, nextMaxX - off));
      if (resizingNow) {
        clearReboundTimer();
        a.sideEdgeDirectUntil = now + 220;
        a.x = tx;
        syncTower(a, now);
        if (tx >= a.sidePushOriginX - 1) {
          a.sideEdgeSnap = false;
          a.sidePushOriginX = null;
          a.sideEdgeOffset = 0;
        }
      } else {
        needReb = true;
      }
    }
    if (needReb) scheduleRebound();
  };
  const schedStageResize = (prevW: number, nw: number) => {
    if (!pendPrevW) pendPrevW = prevW;
    pendNextW = nw;
    if (resizeRaf) return;
    resizeRaf = win.requestAnimationFrame(() => {
      if (disposed) return;
      resizeRaf = 0;
      const p = pendPrevW;
      const n = pendNextW;
      pendPrevW = pendNextW = 0;
      handleStageWidthResize(p, n);
    });
  };
  cleanups.push(
    observeResize(hostEl, (entries) => {
      if (disposed) return;
      const cr = entries.at(-1)?.contentRect;
      // Only contentRect is read, so an empty frame never forces a synchronous reflow.
      const nw = cr ? Math.round(cr.width) : 0;
      const dprChanged = syncStageDpr();
      if (nw > 0) {
        const prevW = cachedHostWidth || 720;
        hasMeasuredHostWidth = true;
        cachedHostWidth = nw;
        if (nw !== prevW) schedStageResize(prevW, nw);
      }
      if (dprChanged) renderAllFrames(performance.now());
    }),
  );
  const readStageWidth = () => {
    if (!hasMeasuredHostWidth) {
      const w = hostEl.clientWidth;
      if (w > 0) {
        cachedHostWidth = w;
        hasMeasuredHostWidth = true;
      }
    }
    return cachedHostWidth || 720;
  };
  const rightReserveFor = (w: number) =>
    popoverRightWidth > 0 ? Math.min(w - 150, popoverRightWidth + 16) : 0;
  const stageBoundsX = () => {
    const w = readStageWidth();
    return { minX: 14, maxX: Math.max(96, w - 14 - rightReserveFor(w)) };
  };
  const clampActorX = (x: number) => {
    const w = readStageWidth();
    const maxX = Math.max(24, w - 88 - rightReserveFor(w));
    return Math.max(8, Math.min(maxX, x));
  };

  const getEntWorldCx = (ent: Ent) =>
    isMiniEnt(ent) ? 12 + (Number.isFinite(ent.px) ? ent.px : ent.x) + 20 : ent.x + 48;
  const setEntWorldCx = (ent: Ent, cx: number) => {
    const { minX, maxX } = stageBoundsX();
    const hw = entHalfW(ent);
    const clamped = Math.max(minX + hw, Math.min(maxX - hw, cx));
    if (isMiniEnt(ent)) {
      const px = Math.max(2, clamped - 32);
      ent.px = px;
      ent.lastX = Math.round(px);
    } else {
      ent.x = clampActorX(clamped - 48);
    }
  };

  const findDirectRider = (holderId: string): Ent | null => {
    for (const e of [actors.cat, actors.clawd, ...miniCrabs]) {
      if (e.stackedOn === holderId) return e;
    }
    return null;
  };
  const getStackDepth = (id: string) => {
    let d = 0;
    let cur = getEnt(id);
    const seen = new Set<string>();
    while (cur?.stackedOn && !seen.has(cur.id)) {
      seen.add(cur.id);
      const base = getEnt(cur.stackedOn);
      if (!base) break;
      d += 1;
      cur = base;
    }
    return d;
  };
  const getTowerRoot = (id: string) => {
    let cur = getEnt(id);
    const seen = new Set<string>();
    while (cur?.stackedOn && !seen.has(cur.id)) {
      seen.add(cur.id);
      const base = getEnt(cur.stackedOn);
      if (!base) break;
      cur = base;
    }
    return cur;
  };
  const getTowerMembers = (anyId: string): string[] => {
    const root = getTowerRoot(anyId);
    if (!root) return [];
    const chain = [root.id];
    const seen = new Set(chain);
    let curId = root.id;
    for (;;) {
      const next = findDirectRider(curId);
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      chain.push(next.id);
      curId = next.id;
    }
    return chain;
  };
  const getStackTop = (anyId: string) => {
    const chain = getTowerMembers(anyId);
    return chain.length ? getEnt(chain.at(-1)) : getEnt(anyId);
  };
  const computeWorldFootY = (ent: Ent) => {
    if (ent.stackedOn) {
      const seen = new Set([ent.id]);
      let cur: Ent = ent;
      let yAcc = 0;
      while (cur.stackedOn && !seen.has(cur.stackedOn)) {
        seen.add(cur.stackedOn);
        const base = getEnt(cur.stackedOn);
        if (!base) break;
        yAcc -= mountStepH(base.id);
        cur = base;
      }
      return (cur.y || 0) + yAcc;
    }
    return ent.y || 0;
  };
  const syncAllStackedFollowers = () => {
    for (const root of allActiveEnts()) {
      if (root.stackedOn) continue;
      const chain = getTowerMembers(root.id);
      if (chain.length < 2) continue;
      const rootCx = getEntWorldCx(root);
      let yCursor = root.y || 0;
      for (let i = 1; i < chain.length; i++) {
        const prev = getEnt(chain[i - 1]);
        const rider = getEnt(chain[i]);
        if (!prev || !rider || rider.dragging) break;
        yCursor -= mountStepH(prev.id);
        setEntWorldCx(rider, rootCx);
        rider.y = yCursor;
      }
    }
  };
  const enforceGroundSeparation = (lockedId: string | null = null) => {
    const { minX, maxX } = stageBoundsX();
    const groundList: { ent: Ent; cx: number; halfW: number; locked: boolean }[] = [];
    for (const e of allActiveEnts()) {
      if (e.stackedOn || e.dragging || e.ballisticActive) continue;
      if ((e.y || 0) < -3 || e.leap) continue;
      if (isMiniEnt(e) && e.act?.type === "ride") continue;
      groundList.push({
        ent: e,
        cx: getEntWorldCx(e),
        halfW: entHalfW(e),
        locked: e.id === lockedId,
      });
    }
    if (groundList.length >= 2) {
      resolveGroundSeparation(groundList, minX, maxX, 6);
      for (const item of groundList) if (!item.locked) setEntWorldCx(item.ent, item.cx);
    }
    syncAllStackedFollowers();
  };

  const spawnChromaBurst = (cx: number, cy: number, count = 12, gentle = false) => {
    for (let i = 0; i < count; i++) {
      if (chromaSparks.length >= 48) chromaSparks.shift();
      const ang = gentle
        ? -Math.PI * (0.25 + Math.random() * 0.5)
        : (i / Math.max(1, count)) * Math.PI * 2 + (Math.random() - 0.5) * 0.18;
      const spd = gentle ? 0.6 + Math.random() * 0.9 : 2.2 + (i % 2) * 1.15 + Math.random() * 0.6;
      chromaSparks.push({
        x: cx + (gentle ? (Math.random() - 0.5) * 14 : 0),
        y: cy + (gentle ? -4 - Math.random() * 8 : 0),
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - (gentle ? 0.8 : 1.1),
        life: 0,
        maxLife: gentle ? 6 : 11,
        color: CHROMA_HEX[i % CHROMA_HEX.length] ?? "#FFFFFF",
        size: gentle ? 3 : i % 3 === 0 ? 4 : 3,
      });
    }
  };

  const getRestPositions = (): Record<MascotKind, number> => {
    const w = readStageWidth();
    const safeRight = popoverRightWidth > 0 ? Math.max(185, w - popoverRightWidth - 18) : w - 12;
    const leaderX = clampActorX(safeRight - 82);
    const partnerX = clampActorX(leaderX - 66);
    return camp === "claude"
      ? { clawd: leaderX, cat: partnerX }
      : { cat: leaderX, clawd: partnerX };
  };
  const resetHomePositions = (animateWalk = false) => {
    const pos = getRestPositions();
    for (const id of ACTOR_IDS) {
      const a = actors[id];
      if (a.dragging || a.stackedOn) continue;
      a.sideEdgeSnap = false;
      a.sidePushOriginX = null;
      a.sideEdgeOffset = 0;
      a.sideEdgeDirectUntil = 0;
      const target = pos[id];
      if (animateWalk && !reducedMotion && Math.abs(a.x - target) > 6 && a.y === 0) {
        a.overridePose = "walk";
        a.overrideUntil = performance.now() + 380;
        a.overrideRot = 0;
      }
      a.x = target;
      if (a.y > 0) a.y = 0;
    }
    enforceGroundSeparation();
  };
  resetHomePositions(false);

  // Beat sequences: [pose, ticks, sqW, sqH, lift].
  const playSeq = (actor: Actor, steps: readonly SeqTuple[], then?: () => void) => {
    actor.seq = steps.map(([pose, ticks, sqW = 0, sqH = 0, lift = 0]) => ({
      pose,
      ticks,
      sqW,
      sqH,
      lift,
    }));
    actor.seqStartTick = tickIdx + 1;
    actor.seqThen = then ?? null;
  };
  const seqStep = (actor: Actor): SeqStep | null => {
    if (!actor.seq) return null;
    let k = Math.max(0, tickIdx - actor.seqStartTick);
    for (const st of actor.seq) {
      if (k < st.ticks) return st;
      k -= st.ticks;
    }
    actor.seq = null;
    const then = actor.seqThen;
    actor.seqThen = null;
    then?.();
    return null;
  };
  const seqTotalMs = (steps: readonly SeqTuple[]) =>
    steps.reduce((s, st) => s + st[1] * TICK, 0) + TICK;
  const landingSteps = (flatTicks: number): SeqTuple[] => [
    ["flat", flatTicks, 2, 0],
    ["idle", 1, -2, 1],
    ["idle", 1, 2, -1],
  ];
  const hopSteps = (airPose: string): SeqTuple[] => [
    ["squash", 1, 2, -1, 0],
    [airPose, 1, -1, 1, -2],
    [airPose, 1, 0, 0, -4],
    [airPose, 1, 0, 0, -4],
    [airPose, 1, 0, 0, -2],
    ["idle", 1, 2, -1, 0],
  ];

  const resolvePoseFor = (actor: Actor, now: number) => {
    if (actor.dragging) return "dangle";
    const st = seqStep(actor);
    if (st) return st.pose;
    if (actor.overridePose && now < actor.overrideUntil) return actor.overridePose;
    if (actor.overridePose && now >= actor.overrideUntil) {
      actor.overridePose = null;
      actor.overrideRot = 0;
      actor.mirror = false;
      actor.faceDir = null;
      actor.clipParam = null;
    }
    return resolveStagePose({
      actorId: actor.kind,
      camp,
      yieldMode,
      hasError,
      streaming,
      dozing,
      now,
      pose: actor.pose,
    });
  };

  const effectiveRot = (a: Actor, now: number) => {
    if (a.stackedOn && a.balRot && !a.dragging) return a.balRot;
    return now < a.overrideUntil && a.overrideRot ? a.overrideRot : a.rot;
  };

  const isDirectMover = (e: Ent, now: number, resizingNow: boolean) =>
    e.dragging ||
    e.ballisticActive ||
    Boolean(e.leap) ||
    (e.sideEdgeSnap && resizingNow) ||
    (e.sideEdgeDirectUntil > 0 && now < e.sideEdgeDirectUntil);
  const isEntDirectMotion = (ent: Ent) => {
    const now = performance.now();
    const resizingNow = isStageResizing();
    if (isDirectMover(ent, now, resizingNow) || (!ent.stackedOn && (ent.y || 0) < -0.4)) {
      return true;
    }
    if (ent.stackedOn) {
      const root = getTowerRoot(ent.id);
      if (root && root !== ent && (isDirectMover(root, now, resizingNow) || (root.y || 0) < -0.4)) {
        return true;
      }
    }
    return false;
  };

  const syncDirectMotionDomAttr = (ent: Ent, domEl: HTMLElement) => {
    const direct = isEntDirectMotion(ent);
    const dragNow = ent.dragging;
    if (ent.lastDomDirect !== direct) {
      ent.lastDomDirect = direct;
      if (direct) {
        domEl.setAttribute("data-direct", "1");
        domEl.style.transition = "none";
      } else {
        domEl.removeAttribute("data-direct");
        domEl.style.transition = "";
      }
    }
    if (ent.lastDomDrag !== dragNow) {
      ent.lastDomDrag = dragNow;
      if (dragNow) {
        domEl.setAttribute("data-dragging", "1");
        domEl.style.cursor = "grabbing";
      } else {
        domEl.removeAttribute("data-dragging");
        domEl.style.cursor = "grab";
      }
    }
    syncMascotDragRootAttr();
    return direct;
  };

  const snapCoord = (v: number, direct: boolean) =>
    direct ? Math.round(v * 100) / 100 : Math.round(v);

  const applyActorTransform = (actor: Actor, now = performance.now()) => {
    let yPx = actor.y;
    if (actor.stackedOn) {
      const root = getTowerRoot(actor.id);
      actor.x = clampActorX(getEntWorldCx(root ?? actor) - 48);
      yPx = computeWorldFootY(actor) + (yieldMode === "leap" ? -leapOffsetY : 0);
    } else if (yieldMode === "leap" && !actor.dragging && actor.y === 0) {
      yPx -= leapOffsetY;
    } else if (yieldMode === "peek" && !actor.dragging) {
      yPx += 6;
    }
    const direct = syncDirectMotionDomAttr(actor, actor.el);
    const depth = actor.stackedOn ? getStackDepth(actor.id) : 0;
    const tx = snapCoord(actor.x, direct);
    const ty = snapCoord(yPx, direct);
    const tz =
      yieldMode === "peek"
        ? "4"
        : actor.dragging
          ? "38"
          : depth > 0
            ? String(24 + depth * 2)
            : "24";
    if (actor.lastDomX !== tx || actor.lastDomY !== ty) {
      actor.lastDomX = tx;
      actor.lastDomY = ty;
      actor.el.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
    }
    // Tilt goes on the inner canvas so the outer element stays a pure translate.
    const nextRot = snapRot(effectiveRot(actor, now));
    if (actor.lastDomRot !== nextRot) {
      actor.lastDomRot = nextRot;
      actor.lastRender.lastRot = nextRot;
      actor.canvas.style.transform = nextRot ? `rotate(${nextRot}deg)` : "";
    }
    if (actor.lastDomZ !== tz) {
      actor.lastDomZ = tz;
      actor.el.style.zIndex = tz;
    }
  };

  // Idle micro-motion: blinks, breathing dips, ear twitches, claw snaps and glances.
  const updateIdleFx = (a: Actor, pose: string, now: number): IdleFx => {
    // Blink timing advances in every pose (and under reduced motion); only idle-ish poses show it.
    if (tickIdx >= a.nextBlinkTick) {
      a.blinkTick = tickIdx;
      a.blinkDouble = Math.random() < 0.15;
      a.nextBlinkTick = tickIdx + ticksIn(2400, 6000) + (a.blinkDouble ? 5 : 3);
    }
    const bk = tickIdx - a.blinkTick;
    const blinkSeq = a.blinkDouble ? BLINK_DOUBLE : BLINK_SINGLE;
    const fx: IdleFx = {
      blinkStage: bk >= 0 && bk < blinkSeq.length ? (blinkSeq[bk] ?? null) : null,
      breath: false,
      earTwitch: null,
      clawSnap: null,
      glance: 0,
    };
    const idleNow = pose === "idle" && !a.seq && !a.dragging;
    if (reducedMotion || !idleNow) {
      // Push due micro-motions back so they do not pile up the moment idle resumes.
      if (tickIdx >= a.nextBreathTick) a.nextBreathTick = tickIdx + ticksIn(800, 1800);
      if (tickIdx >= a.nextTwitchTick) a.nextTwitchTick = tickIdx + ticksIn(1500, 4000);
      if (tickIdx >= a.nextSnapTick) a.nextSnapTick = tickIdx + ticksIn(1500, 4000);
      a.glanceDir = 0;
      if (now >= a.nextGlanceAt) a.nextGlanceAt = now + rand(1500, 4000);
      return fx;
    }
    if (tickIdx >= a.nextBreathTick) {
      a.breathTick = tickIdx;
      a.nextBreathTick = tickIdx + ticksIn(2800, 4200);
    }
    const brk = tickIdx - a.breathTick;
    fx.breath = brk >= 0 && brk < 2;
    if (a.kind === "cat") {
      if (tickIdx >= a.nextTwitchTick) {
        a.twitchTick = tickIdx;
        a.twitchLen = Math.random() < 0.5 ? 1 : 2;
        a.twitchSide = Math.random() < 0.5 ? "L" : "R";
        a.nextTwitchTick = tickIdx + ticksIn(6000, 10000);
      }
      const tk = tickIdx - a.twitchTick;
      if (tk >= 0 && tk < a.twitchLen) fx.earTwitch = a.twitchSide;
    } else {
      if (tickIdx >= a.nextSnapTick) {
        a.snapTick = tickIdx;
        a.snapSide = Math.random() < 0.5 ? "L" : "R";
        a.nextSnapTick = tickIdx + ticksIn(8000, 12000);
      }
      const sk = tickIdx - a.snapTick;
      if (sk >= 0 && sk < 4 && sk % 2 === 0) fx.clawSnap = a.snapSide;
    }
    if (!a.glanceDir && now >= a.nextGlanceAt) {
      a.glanceDir = Math.random() < 0.5 ? -1 : 1;
      a.glanceUntil = now + rand(600, 1800);
      a.glanceSecond = Math.random() < 0.3;
    }
    if (a.glanceDir && now >= a.glanceUntil) {
      if (a.glanceSecond) {
        a.glanceDir = -a.glanceDir;
        a.glanceUntil = now + rand(500, 1400);
        a.glanceSecond = false;
      } else {
        a.glanceDir = 0;
        a.nextGlanceAt = now + rand(4000, 9000);
      }
    }
    fx.glance = a.glanceDir;
    return fx;
  };

  // Stacked riders counter-tilt (up to 8deg) against the base's movement each tick.
  const updateBalance = () => {
    for (const id of ACTOR_IDS) {
      const top = actors[id];
      const base = top.stackedOn ? getEnt(top.stackedOn) : null;
      let target = 0;
      if (base && !reducedMotion && base.prevCx != null) {
        target = Math.max(-8, Math.min(8, -(getEntWorldCx(base) - base.prevCx) * 4));
      }
      top.balRot =
        Math.abs(target) >= Math.abs(top.balRot) ? target : top.balRot * 0.55 + target * 0.45;
      if (Math.abs(top.balRot) < 0.4) top.balRot = 0;
    }
    for (const e of allActiveEnts()) e.prevCx = getEntWorldCx(e);
  };

  // Daytime dozing blows z's; late at night (23:00-05:00) a soft sleep bubble.
  const dozeSymFor = (a: Actor) => {
    if (isLateNight()) {
      if (reducedMotion) return "sleepBubble0";
      const ph = (tickIdx + (a.id === "cat" ? 4 : 0)) % 12;
      return ph < 6 ? "sleepBubble0" : "sleepBubble1";
    }
    if (reducedMotion) return "dozeZ1";
    const ph = (tickIdx + (a.id === "cat" ? 9 : 0)) % 18;
    return ph < 4 ? "dozeZ0" : ph < 8 ? "dozeZ1" : ph < 12 ? "dozeZ2" : null;
  };
  const crabRiding = () =>
    miniPileEnabled && miniCrabs.some((mc) => mc.act?.type === "ride" && tickIdx >= mc.act.start);

  const miniActPose = (mc: Mini, baseSprite: Frame | undefined, anim: FrameDict) => {
    const act = mc.act;
    if (!act) return null;
    const t = tickIdx - act.start;
    if (t < 0) return null;
    let k0 = t;
    let segIdx = -1;
    for (let i = 0; i < act.segs.length; i++) {
      const sg = act.segs[i];
      if (!sg) break;
      if (k0 < sg.ticks) {
        segIdx = i;
        break;
      }
      k0 -= sg.ticks;
    }
    const seg = act.segs[segIdx];
    if (!seg || act.abort?.(segIdx)) {
      mc.act = null;
      if (seg) act.onAbort?.();
      return null;
    }
    const k = (k0 + 1) / seg.ticks;
    const x = seg.x0 + (seg.x1 - seg.x0) * k;
    const y = seg.y0 + (seg.y1 - seg.y0) * k - (seg.arc || 0) * Math.sin(Math.PI * k);
    if (seg.x1 !== seg.x0) mc.mirror = seg.x1 < seg.x0;
    else if (seg.face) mc.mirror = seg.face < 0;
    const still = MINI_SPRITES[mc.id];
    const blinking = tickIdx - mc.blinkAt >= 0 && tickIdx - mc.blinkAt < 2;
    const blinkOr = (f: Frame | undefined) => (f && blinking ? miniBlinkFrame(f) : f);
    let sprite: Frame | undefined;
    if (seg.sprite === "walk") sprite = tickIdx % 2 ? anim.walkB : still;
    else if (seg.sprite === "trick") sprite = anim.trick;
    else if (seg.sprite === "wave") sprite = reducedMotion || k0 % 4 < 2 ? anim.trick : still;
    else if (seg.sprite === "sit") {
      sprite = k0 >= 8 && k0 < 14 && k0 % 4 < 2 ? anim.trick : blinkOr(still);
    } else sprite = blinkOr(still);
    return {
      x: Math.round(x),
      y: Math.round(y / 2) * 2,
      sprite: sprite ?? baseSprite,
      mirror: mc.mirror,
      hopPx: seg.hop && !reducedMotion && k0 % 4 < 2 ? -2 : 0,
    };
  };

  // Mini crab x is relative to the pile's left edge (host left 12px); the sprite center is at 20px.
  const crabHostCenter = (mc: Mini) => 12 + mc.lastX + 20;
  const crabSafeX = (x: number) => Math.min(clampActorX(9999) - 132, Math.max(2, Math.round(x)));
  const crabMaxX = () => Math.max(40, readStageWidth() - 52);
  const nearestFreeCrab = (hx: number) =>
    miniCrabs
      .filter((mc) => !mc.act || tickIdx - mc.act.start < 0)
      .sort((m1, m2) => Math.abs(crabHostCenter(m1) - hx) - Math.abs(crabHostCenter(m2) - hx))[0] ??
    null;
  const actorFree = (a: Actor, now: number) =>
    !a.dragging &&
    !a.ballisticActive &&
    !a.stackedOn &&
    !a.seq &&
    a.y === 0 &&
    !(a.overridePose === "dangle" && now < a.overrideUntil);

  const crabsWave = () => {
    if (!miniPileEnabled) return;
    miniCrabs.forEach((mc, idx) => {
      if (mc.act?.type === "ride") return;
      const x = crabSafeX(mc.lastX);
      mc.act = {
        type: "wave",
        start: tickIdx + 1 + idx * 2,
        segs: [{ ticks: 14, x0: x, x1: x, y0: 0, y1: 0, sprite: "wave", hop: true }],
      };
    });
  };

  // A throw landing near a crab: it jumps away, freezes, then walks slowly back.
  const scatterCrabsNear = (hx: number) => {
    if (!miniPileEnabled || reducedMotion) return;
    miniCrabs.forEach((mc, idx) => {
      if (mc.act?.type === "ride") return;
      const d = crabHostCenter(mc) - hx;
      if (Math.abs(d) >= 64) return;
      const dir = d >= 0 ? 1 : -1;
      const x0 = crabSafeX(mc.lastX);
      const far = Math.max(0, Math.min(crabMaxX(), x0 + dir * 26));
      mc.act = {
        type: "scatter",
        start: tickIdx + (idx % 2),
        segs: [
          { ticks: 5, x0, x1: far, y0: 0, y1: 0, arc: 6, sprite: "walk" },
          { ticks: 4, x0: far, x1: far, y0: 0, y1: 0, sprite: "still", face: -dir },
          { ticks: 9, x0: far, x1: x0, y0: 0, y1: 0, sprite: "walk" },
        ],
      };
    });
  };

  let crabSerial = 0;
  // A crab taunts the cat, the cat chases a few steps, the crab flees home, the cat tilts its head.
  const runCrabChase = (force: boolean) => {
    const now = performance.now();
    const cat = actors.cat;
    if (!miniPileEnabled || reducedMotion || dozing || !actorFree(cat, now)) return false;
    if (!force && stageBusy()) return false;
    const mc = nearestFreeCrab(cat.x + 48);
    if (!mc) return false;
    const x0 = crabSafeX(mc.lastX);
    const crabLeft = x0 + 20 + 12 < cat.x + 48;
    const tx = Math.max(0, Math.min(crabMaxX(), crabLeft ? cat.x - 26 : cat.x + 58));
    const catDir = crabLeft ? -1 : 1;
    const dist = Math.abs(tx - x0);
    const approach = Math.max(3, Math.min(36, Math.round(dist / 7)));
    const flee = Math.max(4, Math.min(28, Math.round(dist / 10)));
    mc.act = {
      type: "chase",
      start: tickIdx + 1,
      segs: [
        { ticks: approach, x0, x1: tx, y0: 0, y1: 0, sprite: "walk" },
        { ticks: 6, x0: tx, x1: tx, y0: 0, y1: 0, sprite: "wave", face: -catDir },
        { ticks: flee, x0: tx, x1: x0, y0: 0, y1: 0, sprite: "walk", hop: true },
      ],
    };
    const serial = (crabSerial += 1);
    const alive = () =>
      serial === crabSerial &&
      !disposed &&
      !reducedMotion &&
      !cat.dragging &&
      !cat.stackedOn &&
      !dozing;
    const t0 = (approach + 1) * TICK;
    later(t0, () => {
      if (!alive()) return;
      startClip(cat, "wow", 500, { sym: "bang" });
      renderAllFrames(performance.now());
    });
    later(t0 + 500, () => {
      if (!alive()) return;
      startClip(cat, "walk", 1200, {
        patrolDir: catDir,
        mirror: catDir > 0,
        sym: "spark",
        symDurationMs: 600,
      });
    });
    later(t0 + 1750, () => {
      if (!alive()) return;
      startClip(cat, "tilt", 900, { rot: -9, sym: "q" });
      renderAllFrames(performance.now());
    });
    later(t0 + 2750, () => {
      if (alive() && !stageBusy()) resetHomePositions(true);
    });
    return true;
  };

  // A crab walks to Clawd, arcs onto its head, sits (waving midway), then hops down and walks home.
  const runCrabRide = (force: boolean) => {
    const now = performance.now();
    const clawd = actors.clawd;
    if (!miniPileEnabled || reducedMotion || dozing || yieldMode !== "none") return false;
    if (!actorFree(clawd, now) || actors.cat.stackedOn === "clawd") return false;
    if (!force && stageBusy()) return false;
    const mc = nearestFreeCrab(clawd.x + 48);
    if (!mc) return false;
    const x0 = crabSafeX(mc.lastX);
    const clawdX0 = clawd.x;
    // Clawd's head is 33px above the host floor and a crab's feet 11px, so the crab rises 22px.
    const headX = Math.round(clawd.x + 16);
    const headY = -22;
    const side = x0 + 32 < clawd.x + 48 ? -1 : 1;
    const sideX = Math.max(0, Math.min(crabMaxX(), headX + side * 36));
    const approach = Math.max(1, Math.min(36, Math.round(Math.abs(sideX - x0) / 7)));
    const SIT = 22;
    const act: MiniAct = {
      type: "ride",
      start: tickIdx + 1,
      segs: [
        { ticks: approach, x0, x1: sideX, y0: 0, y1: 0, sprite: "walk" },
        { ticks: 4, x0: sideX, x1: headX, y0: 0, y1: headY, arc: 10, sprite: "trick" },
        { ticks: SIT, x0: headX, x1: headX, y0: headY, y1: headY, sprite: "sit", face: -side },
        { ticks: 4, x0: headX, x1: sideX, y0: headY, y1: 0, arc: 8, sprite: "trick" },
        { ticks: Math.max(2, approach), x0: sideX, x1: x0, y0: 0, y1: 0, sprite: "walk" },
      ],
      // Dragging, lifting, moving or stacking Clawd makes the crab give up and walk home.
      abort: (segIdx) =>
        segIdx >= 1 &&
        segIdx <= 3 &&
        (clawd.dragging ||
          Boolean(clawd.stackedOn) ||
          actors.cat.stackedOn === "clawd" ||
          clawd.y !== 0 ||
          Math.abs(clawd.x - clawdX0) > 2 ||
          yieldMode !== "none" ||
          dozing),
      onAbort: () => {
        if (clawd.overridePose === "carry") clawd.overrideUntil = 0;
      },
    };
    mc.act = act;
    const tLand = (1 + approach + 4) * TICK;
    later(tLand, () => {
      if (mc.act !== act) return;
      startClip(clawd, "carry", SIT * TICK + 60);
      renderAllFrames(performance.now());
    });
    later(tLand + (SIT + 4) * TICK, () => {
      if (mc.act !== act) return;
      startClip(clawd, "happy", 700, { sym: "spark" });
      renderAllFrames(performance.now());
    });
    return true;
  };

  // Prism sparks; the canvas shrinks back to 0x0 the moment no spark is alive.
  const stepAndPaintChromaFx = () => {
    if (!chromaSparks.length) {
      if (!fxCanvasCleared || fxCanvas.width || fxCanvas.height) releaseFxCanvas();
      return;
    }
    fxCanvasCleared = false;
    const wCss = Math.max(240, readStageWidth());
    const hCss = 160;
    const tw = Math.round(wCss * dpr);
    const th = Math.round(hCss * dpr);
    if (fxCanvas.style.display === "none") fxCanvas.style.display = "";
    if (fxCanvas.width !== tw || fxCanvas.height !== th) {
      fxCanvas.width = tw;
      fxCanvas.height = th;
      fxCanvas.style.width = `${wCss}px`;
      fxCanvas.style.height = `${hCss}px`;
    }
    const ctx = contextOf(fxCanvas);
    if (!ctx) {
      chromaSparks.length = 0;
      releaseFxCanvas();
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, wCss, hCss);
    ctx.imageSmoothingEnabled = false;
    for (let i = chromaSparks.length - 1; i >= 0; i--) {
      const sp = chromaSparks[i];
      if (!sp) continue;
      sp.life += 1;
      if (sp.life > sp.maxLife) {
        chromaSparks.splice(i, 1);
        continue;
      }
      sp.x += sp.vx;
      sp.y += sp.vy;
      sp.vy += 0.28;
      ctx.fillStyle = sp.life % 3 === 1 ? "#FFFFFF" : sp.color;
      ctx.fillRect(
        Math.round(sp.x / PX) * PX,
        Math.round((hCss - 8 + sp.y) / PX) * PX,
        sp.size,
        sp.size,
      );
    }
    if (!chromaSparks.length) releaseFxCanvas();
  };

  const landPerched = (ent: Ent, lp: Leap, now: number, perchMs: number, onPerch?: () => void) => {
    const holder = lp.landOnto ? getEnt(lp.landOnto) : null;
    if (holder && !holder.dragging && getTowerMembers(holder.id).length < maxTowerDepthAllowed()) {
      ent.stackedOn = holder.id;
      ent.perchUntil = now + perchMs;
      onPerch?.();
      syncAllStackedFollowers();
      return true;
    }
    return false;
  };

  let lastChromaStepTick = -1;
  const renderActor = (id: MascotKind, now: number) => {
    const a = actors[id];
    let pose = resolvePoseFor(a, now);
    const st = seqStep(a);

    // Patrol steps once per tick; a walking base carries its whole tower along.
    if (
      pose === "walk" &&
      !a.dragging &&
      !a.stackedOn &&
      !a.leap &&
      now < a.overrideUntil &&
      !reducedMotion &&
      a.walkStepTick !== tickIdx
    ) {
      a.walkStepTick = tickIdx;
      const stepPx = now < a.passBoostUntil ? 1.4 * 1.55 : 1.4;
      a.x = clampActorX(a.x + a.patrolDir * stepPx);
      if (a.x <= 12 || a.x >= clampActorX(9999) - 2) a.patrolDir *= -1;
      syncAllStackedFollowers();
    }

    // An auto-perch rider hops down sideways once its time is up.
    if (a.stackedOn && a.perchUntil > 0 && now >= a.perchUntil && !a.dragging) {
      a.perchUntil = 0;
      const prevY = computeWorldFootY(a);
      const jumpDir = a.id === "cat" ? 1 : -1;
      a.stackedOn = null;
      resetActorTransient(a, { keepFly: true });
      a.y = prevY;
      startEntityBallistic(a, jumpDir * 2.8, -3.6, { noSnap: true });
    }

    // Leapfrog over, or auto-perch onto, an obstacle (peak ~26px).
    if (a.leap && !a.dragging) {
      const lp = a.leap;
      const k = Math.min(1, (tickIdx - lp.startTick + 1) / Math.max(1, lp.ticks));
      setEntWorldCx(a, lp.cx0 + (lp.cx1 - lp.cx0) * k);
      a.y = -Math.round(lp.peak * Math.sin(Math.PI * k));
      pose = k < 1 ? "spinHop" : "idle";
      if (k >= 1) {
        a.leap = null;
        a.y = 0;
        const perched = landPerched(a, lp, now, 7600, () => {
          a.sym = "heart";
          a.symUntil = now + 1000;
          playSeq(a, [["happy", 1, 2, -1, 0]]);
        });
        if (!perched) {
          playSeq(a, [["idle", 1, 2, -1, 0]]);
          enforceGroundSeparation();
        }
      }
      syncAllStackedFollowers();
    }

    // A wobbling rider throws its claws or paws out.
    if (a.stackedOn && pose === "idle" && Math.abs(a.balRot) > 1.5) pose = "balance";

    const symKey =
      a.sym && now < a.symUntil
        ? a.sym
        : dozing && pose === "sleep"
          ? dozeSymFor(a)
          : pose === "sleep" || pose === "loaf"
            ? tickIdx % 8 < 4
              ? "z1"
              : "z2"
            : pose === "angry"
              ? "vein"
              : null;
    const localTick =
      pose === "write" ? (streamTier >= 3 ? tickIdx : Math.floor(tickIdx / 2)) : tickIdx;
    const fx = updateIdleFx(a, pose, now);
    const hasRider = Boolean(findDirectRider(id));
    const effectivePose = hasRider && pose === "idle" ? "squash" : pose;
    const sulkJitter = effectivePose === "sulk" && !reducedMotion ? (tickIdx % 4 < 2 ? 0 : -PX) : 0;
    const liftPx = st && st.lift && !reducedMotion ? st.lift * PX : 0;
    const nodOffset = (now < a.nodUntil ? a.nodY : 0) + sulkJitter + liftPx;
    const sqW = st ? st.sqW : 0;
    let sqH = st ? st.sqH : 0;
    if (!st && hasRider && pose !== "idle") sqH = -1;
    const clipBottomY = yieldMode === "peek" && !a.dragging ? (OY + 8) * PX : undefined;
    const ftk = tickIdx - a.forceTwitchStart;
    const forcedTwitch = ftk >= 0 && ftk < 4 && ftk !== 2 ? a.forceTwitchSide : null;

    const crystalActive = id === "clawd" && orchestrator && !hasRider && !crabRiding();
    const layers = buildClipLayers(a.kind, effectivePose, localTick, {
      clipTick: Math.max(0, tickIdx - a.clipStartTick),
      sym: symKey,
      blinkStage: fx.blinkStage,
      breath: fx.breath,
      earTwitch: forcedTwitch || fx.earTwitch,
      clawSnap: fx.clawSnap,
      clipParam: a.clipParam,
      reduced: reducedMotion,
      crystal: crystalActive,
      crystalBob: !reducedMotion && Math.floor(tickIdx / 6) % 2 === 1,
      eyeScan: a.eyeScan || fx.glance,
      noShadow: a.dragging || a.y < -2 || Boolean(a.stackedOn) || yieldMode === "peek",
      dir: a.faceDir || (a.vx < 0 || a.patrolDir < 0 ? "left" : "right"),
    });

    const isChromaCat = id === "cat" && prismaticCoat;
    const phaseBucket = isChromaCat ? Math.round(chromaPhase * 12) : 0;
    const earSparkPhase = isChromaCat ? Math.floor(tickIdx / 2) % 10 : -1;
    if (
      isChromaCat &&
      !reducedMotion &&
      (a.dragging ||
        a.leap ||
        a.y < -3 ||
        (st && st.lift) ||
        (effectivePose === "walk" && now < a.overrideUntil))
    ) {
      spawnChromaBurst(getEntWorldCx(a), computeWorldFootY(a) - 6, 1, true);
    }

    const flip = a.mirror;
    const tintState = `${a.kind}:${crystalActive ? 1 : 0}:${isChromaCat ? `p${phaseBucket}_${earSparkPhase}` : "0"}`;
    const snappedTy = Math.round(Number(nodOffset || 0) / PX) * PX;
    const frameIdx = computeLayersFrameIdx(layers);
    const rc = a.lastRender;
    // Pixels repaint only when the frame itself changes; position and tilt ride GPU transforms.
    if (
      rc.poseKey === effectivePose &&
      rc.frameIdx === frameIdx &&
      rc.flip === flip &&
      rc.tintState === tintState &&
      rc.tyPx === snappedTy &&
      rc.sqW === sqW &&
      rc.sqH === sqH &&
      rc.clipBottomY === clipBottomY &&
      rc.cw === a.canvas.width &&
      rc.ch === a.canvas.height
    ) {
      return;
    }
    rc.poseKey = effectivePose;
    rc.frameIdx = frameIdx;
    rc.flip = flip;
    rc.tintState = tintState;
    rc.tyPx = snappedTy;
    rc.sqW = sqW;
    rc.sqH = sqH;
    rc.clipBottomY = clipBottomY;
    rc.cw = a.canvas.width;
    rc.ch = a.canvas.height;
    const colorResolver: ColorResolver | null = isChromaCat
      ? (ch, gx, gy, pal) =>
          ch === "#"
            ? evalChromaColorAt(gx, gy, chromaPhase, false)
            : ch === "s"
              ? evalChromaColorAt(gx, gy, chromaPhase, true)
              : pal[ch]
      : null;
    const earSpark =
      isChromaCat && (earSparkPhase < 3 || (earSparkPhase >= 5 && earSparkPhase < 8));
    const overlayPainter: OverlayPainter | null = earSpark
      ? (c2, oxG, oyG, pxS) => {
          const sx = (oxG + (earSparkPhase < 3 ? 2 : 13)) * pxS;
          const sy = (oyG - 3) * pxS;
          c2.fillStyle = "#FFFFFF";
          c2.fillRect(sx, sy, pxS, pxS);
          if (earSparkPhase === 1 || earSparkPhase === 6) {
            c2.fillRect(sx - pxS, sy, pxS, pxS);
            c2.fillRect(sx + pxS, sy, pxS, pxS);
            c2.fillRect(sx, sy - pxS, pxS, pxS);
            c2.fillRect(sx, sy + pxS, pxS, pxS);
          }
        }
      : null;
    renderPixelLayers(a.canvas, dpr, OX, OY, PX, paletteFor(a.kind), layers, {
      mirror: flip,
      tyPx: snappedTy,
      sqW,
      sqH,
      clipBottomY,
      colorResolver,
      overlayPainter,
    });
  };

  const renderMini = (mc: Mini, idx: number, now: number, safeRight: number) => {
    const anim = MINI_ANIM_FRAMES[mc.id] ?? {};
    const still = MINI_SPRITES[mc.id];
    const moving = !reducedMotion && !dozing;

    if (mc.stackedOn && mc.perchUntil > 0 && now >= mc.perchUntil && !mc.dragging) {
      mc.perchUntil = 0;
      const prevY = computeWorldFootY(mc);
      const jumpDir = idx % 2 === 0 ? -1 : 1;
      mc.stackedOn = null;
      mc.y = prevY;
      startEntityBallistic(mc, jumpDir * 2.8, -3.6, { noSnap: true });
    }

    if (mc.leap && !mc.dragging) {
      const lp = mc.leap;
      const k = Math.min(1, (tickIdx - lp.startTick + 1) / Math.max(1, lp.ticks));
      setEntWorldCx(mc, lp.cx0 + (lp.cx1 - lp.cx0) * k);
      mc.y = -Math.round(lp.peak * Math.sin(Math.PI * k));
      if (k >= 1) {
        mc.leap = null;
        mc.y = 0;
        if (!landPerched(mc, lp, now, 7200)) enforceGroundSeparation();
      }
    }

    const cycle = (tickIdx + idx * 7) % 24;
    const isTrick = moving && !mc.stackedOn && cycle >= 18;
    const inBump = moving && tickIdx < mc.bumpUntilTick;
    const inPassHop = moving && tickIdx < mc.passHopUntilTick;
    let sprite = mc.dragging
      ? tickIdx % 2 === 0
        ? anim.walkB
        : still
      : mc.leap
        ? anim.trick
        : mc.stackedOn
          ? cycle >= 20
            ? anim.trick
            : still
          : inBump
            ? anim.trick
            : isTrick && !inPassHop
              ? anim.trick
              : moving && tickIdx % 4 >= 2
                ? anim.walkB
                : still;
    if (tickIdx >= mc.nextBlink) {
      mc.blinkAt = tickIdx;
      mc.nextBlink = tickIdx + ticksIn(2600, 6500);
    }
    if (
      sprite &&
      !mc.dragging &&
      tickIdx - mc.blinkAt >= 0 &&
      tickIdx - mc.blinkAt < 2 &&
      !isTrick &&
      !inBump
    ) {
      sprite = miniBlinkFrame(sprite);
    }
    const tc = cycle - 18;
    let hopPx = 0;
    if (!mc.dragging && !mc.stackedOn && !mc.leap) {
      if (inPassHop) {
        const rem = mc.passHopUntilTick - tickIdx;
        hopPx = rem === 2 || rem === 3 ? -4 : -2;
      } else if (inBump) {
        hopPx = -2;
      } else if (moving) {
        const hopCells = isTrick
          ? tc === 1 || tc === 2
            ? -1
            : 0
          : (tickIdx + idx * 3) % 14 === 0
            ? -1
            : 0;
        hopPx = hopCells * 2;
      }
    }

    const actPos = !mc.dragging && !mc.stackedOn && !mc.leap ? miniActPose(mc, sprite, anim) : null;
    const targetSprite = actPos ? actPos.sprite : sprite;
    const targetMirror = actPos ? actPos.mirror : moving && mc.dir < 0;
    const targetTy = actPos ? actPos.hopPx : hopPx;
    const mcDirect = syncDirectMotionDomAttr(mc, mc.canvas);
    let targetX: number;
    let targetY: number;
    if (mc.stackedOn && !mc.dragging) {
      const root = getTowerRoot(mc.id);
      targetX = snapCoord(getEntWorldCx(root ?? mc) - 32, mcDirect);
      targetY = snapCoord(computeWorldFootY(mc), mcDirect);
      mc.px = targetX;
      mc.lastX = Math.round(targetX);
    } else if (actPos) {
      targetX = actPos.x;
      targetY = actPos.y;
      if (actPos.y === 0) {
        mc.lastX = Math.min(safeRight, Math.max(2, actPos.x));
        mc.px = mc.lastX;
      }
    } else {
      const rawX = mc.dragging ? mc.px : Math.min(safeRight, Math.max(2, mc.px));
      targetX = snapCoord(rawX, mcDirect);
      targetY = snapCoord(mc.y || 0, mcDirect);
      mc.lastX = Math.round(targetX);
    }

    const layers = targetSprite ? [targetSprite] : [];
    const mKey = `${computeLayersFrameIdx(layers)}|${targetMirror ? 1 : 0}|${targetTy}|${mc.canvas.width}`;
    if (mc.lastFrameKey !== mKey) {
      mc.lastFrameKey = mKey;
      renderPixelLayers(mc.canvas, dpr, 2, 5, 2, paletteFor(mc.id), layers, {
        mirror: targetMirror,
        tyPx: targetTy,
      });
    }
    applyMiniTransform(
      mc,
      targetX,
      targetY,
      miniZ(mc),
      mc.dragging || mc.ballisticActive ? mc.rot : 0,
    );
  };

  const renderAllFrames = (now: number) => {
    if (isVramSleepState()) {
      reclaimStageVram();
      return;
    }
    restoreStageVram();
    syncStageDpr();
    renderHabitatProp(false);
    if (prismaticCoat && !reducedMotion && !dozing && lastChromaStepTick !== tickIdx) {
      lastChromaStepTick = tickIdx;
      if (tickIdx % 3 === 0) chromaPhase = (chromaPhase + 1 / 12) % 1;
    }
    syncAllStackedFollowers();

    for (const id of ACTOR_IDS) renderActor(id, now);

    const nextMiniDisplay = miniPileEnabled ? "flex" : "none";
    if (lastMiniDisplay !== nextMiniDisplay) {
      lastMiniDisplay = nextMiniDisplay;
      miniGroupEl.style.display = nextMiniDisplay;
    }
    if (miniPileEnabled) {
      const safeRight = Math.max(48, (stageBoundsX().maxX || 680) - 48);
      if (!reducedMotion && !dozing && lastCrabStepTick !== tickIdx) {
        lastCrabStepTick = tickIdx;
        stepMiniCrabCorridor(
          miniCrabs.filter(
            (mc) => !mc.dragging && !mc.ballisticActive && !mc.stackedOn && !mc.leap && mc.y === 0,
          ),
          { minX: 2, maxX: safeRight, contactDist: 26, nowTick: tickIdx },
        );
      }
      syncAllStackedFollowers();
      miniCrabs.forEach((mc, idx) => renderMini(mc, idx, now, safeRight));
    } else {
      for (const mc of miniCrabs) {
        mc.act = null;
        mc.stackedOn = null;
        mc.dragging = false;
        mc.ballisticActive = false;
        mc.rot = 0;
        mc.y = 0;
      }
      syncMascotDragRootAttr();
    }

    enforceGroundSeparation(
      actors.cat.dragging
        ? "cat"
        : actors.clawd.dragging
          ? "clawd"
          : (miniCrabs.find((m) => m.dragging)?.id ?? null),
    );
    // Re-apply transforms the separation pass nudged (cached, so unchanged ones write nothing).
    applyActorTransform(actors.cat, now);
    applyActorTransform(actors.clawd, now);
    if (miniPileEnabled) {
      for (const mc of miniCrabs) {
        if (
          !mc.dragging &&
          !mc.ballisticActive &&
          !mc.stackedOn &&
          !mc.act &&
          !mc.leap &&
          mc.y === 0
        ) {
          syncDirectMotionDomAttr(mc, mc.canvas);
          applyMiniTransform(mc, Math.round(mc.px), 0, null, 0);
        }
      }
    }
    stepAndPaintChromaFx();
  };

  const startClip = (
    actor: Actor,
    pose: string,
    durationMs: number,
    opts: StartClipOptions = {},
  ) => {
    const now = performance.now();
    actor.overridePose = pose;
    actor.overrideUntil = now + durationMs;
    actor.overrideRot = opts.rot || 0;
    actor.mirror = Boolean(opts.mirror);
    actor.faceDir = opts.face || null;
    actor.clipParam = opts.param ?? null;
    actor.clipStartTick = tickIdx;
    if (opts.sym) {
      actor.sym = opts.sym;
      actor.symUntil = now + (opts.symDurationMs || durationMs);
    }
    if (opts.patrolDir) actor.patrolDir = opts.patrolDir;
  };

  // One reset for transient pose and physics state, so crossed interruptions never leave residue.
  const resetActorTransient = (ent: Ent, opts: ResetOptions = {}) => {
    if (!opts.keepFly) ent.flying += 1;
    if (!opts.keepBallistic) ent.ballisticActive = false;
    ent.leap = null;
    if (!opts.keepVel) {
      ent.vx = 0;
      ent.vy = 0;
    }
    ent.rot = 0;
    if (isMiniEnt(ent)) {
      if (!opts.keepAct) ent.act = null;
      return;
    }
    if (!opts.keepPose) {
      ent.overridePose = null;
      ent.overrideUntil = 0;
    }
    ent.overrideRot = 0;
    ent.balRot = 0;
    if (!opts.keepMirror) ent.mirror = false;
    ent.faceDir = null;
    ent.clipParam = null;
    if (!opts.keepSeq) {
      ent.seq = null;
      ent.seqThen = null;
    }
  };

  // Reduced motion stops throws, patrols, sequences and sparks and returns to a static idle.
  function freezeMotion() {
    chromaSparks.length = 0;
    releaseFxCanvas();
    for (const id of ACTOR_IDS) {
      const a = actors[id];
      const keepPose = Boolean(
        a.overridePose && a.overridePose !== "walk" && a.overridePose !== "dangle",
      );
      resetActorTransient(a, { keepPose });
      a.passBoostUntil = 0;
      if (!a.stackedOn) a.y = 0;
    }
    for (const mc of miniCrabs) {
      resetActorTransient(mc, { keepAct: mc.act?.type === "wave" });
      mc.bumpUntilTick = -1;
      mc.passHopUntilTick = -1;
      mc.cooldownTick = -1;
      if (!mc.stackedOn) {
        mc.y = 0;
        mc.px = mc.x;
        mc.lastX = mc.x;
      }
    }
    if (actors.clawd.overridePose === "carry") actors.clawd.overrideUntil = 0;
    resetHomePositions(false);
  }

  const toggleChromaResonance = (now: number) => {
    prismaticCoat = !prismaticCoat;
    writeChromaSaved(prismaticCoat);
    resetActorTransient(actors.cat);
    const catCx = getEntWorldCx(actors.cat);
    const catFootY = computeWorldFootY(actors.cat);
    if (prismaticCoat) {
      spawnChromaBurst(catCx, catFootY - 18, 12, false);
      playSeq(actors.cat, hopSteps("spinHop"));
      actors.cat.sym = "spark";
      actors.cat.symUntil = now + 1500;
    } else {
      spawnChromaBurst(catCx, catFootY - 16, 6, true);
      startClip(actors.cat, "groom", 800, { sym: "note" });
    }
  };

  // Five escalating poke reactions; four quick taps on a stacked cat toggle the prismatic coat.
  const triggerPoke = (actor: Actor, fromPointer: boolean) => {
    const now = performance.now();
    markActivity();

    if (actor.id === "cat") {
      if (isChromaTapEligible(getTowerMembers("cat").length, prismaticCoat, chromaGates)) {
        if (registerChromaTap(chromaTapTimes, now)) {
          actor.pokeCount = 0;
          toggleChromaResonance(now);
          renderAllFrames(now);
          return;
        }
        startClip(actor, "happy", 550, { sym: "spark" });
        renderAllFrames(now);
        return;
      }
    }

    if (now - actor.lastPokeAt > 4500) actor.pokeCount = 0;
    actor.pokeCount += 1;
    actor.lastPokeAt = now;
    const inTower = getTowerMembers(actor.id).length >= 2;

    if (actor.pokeCount === 1) {
      startClip(actor, actor.id === "cat" && Math.random() < 0.45 ? "groom" : "happy", 750, {
        sym: "spark",
      });
      if (fromPointer && !inTower) startEntityBallistic(actor, 0, -4.4, { anticipate: true });
    } else if (actor.pokeCount === 2) {
      // Cancel the first poke's pending launch so the jiggle is not knocked away late.
      actor.flying += 1;
      actor.seq = null;
      startClip(actor, "jiggle", 950, { sym: "note" });
    } else if (actor.pokeCount === 3) {
      actor.flying += 1;
      startClip(actor, "tilt", 1100, { rot: -9, sym: "q" });
    } else if (actor.pokeCount === 4) {
      startClip(actor, "wow", 950, { sym: "bang" });
      if (fromPointer && !inTower) startEntityBallistic(actor, 0, -3.2, { anticipate: true });
    } else {
      actor.flying += 1;
      actor.pokeCount = 0;
      startClip(actor, "sulk", 3200, { mirror: true, sym: "vein" });
    }
    renderAllFrames(now);
  };

  // Theater: daily solo clips, rare easter eggs and duets.
  const DAILY_CLAWD = [
    "polish",
    "eat",
    "letter",
    "plant",
    "butterfly",
    "walk",
    "stretch",
    "spinHop",
    "wave",
    "yawn",
  ];
  const DAILY_CAT = [
    "groom",
    "eatFish",
    "chaseDot",
    "catStretch",
    "butterfly",
    "letter",
    "walk",
    "plant",
    "yawnStretch",
  ];
  const DAILY_WEIGHTS: Readonly<Record<string, number>> = {
    wave: 1.3,
    yawn: 0.6,
    yawnStretch: 1.1,
  };
  const NIGHT_BOOST = new Set(["yawn", "yawnStretch", "stretch", "catStretch"]);
  const CLIP_MS: Readonly<Record<string, number>> = { wave: 1500, yawn: 1300, yawnStretch: 2200 };
  const pickDaily = (pool: readonly string[]) => {
    const night = isLateNight();
    const ws = pool.map((k) => (DAILY_WEIGHTS[k] ?? 1) * (night && NIGHT_BOOST.has(k) ? 3 : 1));
    let r = Math.random() * ws.reduce((s, w) => s + w, 0);
    for (let i = 0; i < pool.length; i++) {
      r -= ws[i] ?? 0;
      if (r < 0) return pool[i] ?? "idle";
    }
    return pool.at(-1) ?? "idle";
  };
  const EGGS = ["onFire", "cheerSticks", "rickroll", "siren"];
  const DUETS = [
    ["chatGreet", 0.4],
    ["lookNod", 0.25],
    ["catRub", 0.2],
    ["readAlong", 0.15],
  ] as const;
  type DuetName = (typeof DUETS)[number][0];
  const pickDuet = (): DuetName => {
    let r = Math.random();
    for (const [k, w] of DUETS) if ((r -= w) < 0) return k;
    return "chatGreet";
  };

  const stageBusy = () =>
    streaming ||
    hasError ||
    yieldMode !== "none" ||
    actors.clawd.dragging ||
    actors.cat.dragging ||
    miniCrabs.some((m) => m.dragging) ||
    Boolean(actors.clawd.stackedOn) ||
    Boolean(actors.cat.stackedOn) ||
    miniCrabs.some((m) => m.stackedOn);

  let duetSerial = 0;
  const THEATER_SCRIPTS: Record<DuetName, () => { dur: number; steps: TheaterStep[] }> = {
    lookNod: () => {
      const cf: FaceDir = actors.cat.x >= actors.clawd.x ? "right" : "left";
      const kf: FaceDir = cf === "right" ? "left" : "right";
      return {
        dur: 2500,
        steps: [
          { at: 0, who: "clawd", pose: "lookNod", dur: 2000, opts: { face: cf, param: 5 } },
          { at: 0, who: "cat", pose: "lookNod", dur: 2000, opts: { face: kf, param: 9 } },
        ],
      };
    },
    readAlong: () => ({
      dur: 2500,
      steps: [
        { at: 0, who: "clawd", pose: "readAlong", dur: 1600, opts: { sym: "note" } },
        { at: 0, who: "cat", pose: "readAlong", dur: 1600 },
      ],
    }),
    chatGreet: () => ({
      dur: 2500,
      steps: [
        { at: 0, who: "clawd", pose: "chatGreet", dur: 2400, opts: { sym: "heart" } },
        { at: 0, who: "cat", pose: "chatGreet", dur: 2400, opts: { mirror: true, sym: "note" } },
        { at: 0, run: "crabsWave" },
      ],
    }),
    catRub: () => {
      const { clawd, cat } = actors;
      const dir = clawd.x < cat.x ? -1 : 1;
      const wt = Math.min(16, Math.round(Math.max(0, Math.abs(clawd.x - cat.x) - 46) / 1.4));
      const wm = wt * TICK;
      const steps: TheaterStep[] = [];
      if (wt >= 2)
        steps.push({ at: 0, who: "cat", pose: "walk", dur: wm, opts: { patrolDir: dir } });
      steps.push({ at: wm, who: "cat", pose: "groom", dur: 1600, opts: { mirror: dir < 0 } });
      steps.push({ at: wm + 400, who: "clawd", pose: "pet", dur: 1300, opts: { sym: "heart" } });
      if (wt >= 2) {
        steps.push({ at: wm + 1700, who: "cat", pose: "walk", dur: wm, opts: { patrolDir: -dir } });
      }
      steps.push({ at: wm * 2 + 1800, run: "resetHome" });
      return { dur: wm * 2 + 2000, steps };
    },
  };

  const runDuet = (name: DuetName) => {
    const now = performance.now();
    const spec = THEATER_SCRIPTS[name]();
    const serial = (duetSerial += 1);
    duetUntil = now + (spec.dur || 2500);
    const alive = () =>
      serial === duetSerial &&
      !disposed &&
      !stageBusy() &&
      !reducedMotion &&
      !isHostSleeping() &&
      !isWindowBlurred();
    const exec = (step: TheaterStep) => {
      if ("run" in step) {
        if (step.run === "crabsWave") crabsWave();
        else resetHomePositions(false);
      } else startClip(actors[step.who], step.pose, step.dur, step.opts ?? {});
    };
    for (const st of spec.steps) {
      if (!st.at) exec(st);
      else {
        later(st.at, () => {
          if (alive()) {
            exec(st);
            renderAllFrames(performance.now());
          }
        });
      }
    }
    renderAllFrames(now);
  };

  const pickNextTheater = () => {
    if (disposed || isHostDetached() || parked) {
      theaterTimer = 0;
      return;
    }
    if (!stageBusy() && !reducedMotion && !dozing && !isHostSleeping() && !isWindowBlurred()) {
      const now = performance.now();
      const cIdle = !actors.clawd.overridePose || now >= actors.clawd.overrideUntil;
      const kIdle = !actors.cat.overridePose || now >= actors.cat.overrideUntil;
      const crabBusy = miniCrabs.some((mc) => mc.act);

      if (miniPileEnabled && cIdle && kIdle && !crabBusy && Math.random() < 0.18) {
        const r = Math.random();
        let started: boolean;
        if (r < 0.4) started = runCrabChase(false);
        else if (r < 0.8) started = runCrabRide(false);
        else {
          crabsWave();
          started = true;
        }
        if (started) renderAllFrames(now);
      } else if (cIdle && kIdle && Math.random() < 0.3) {
        runDuet(pickDuet());
      } else {
        const target = theaterCursor % 2 === 0 ? actors.cat : actors.clawd;
        theaterCursor += 1;
        if (!target.overridePose || now >= target.overrideUntil) {
          if (Math.random() < 0.06) {
            startClip(target, EGGS[Math.floor(Math.random() * EGGS.length)] ?? "onFire", 3800);
          } else {
            const clip = pickDaily(target.id === "cat" ? DAILY_CAT : DAILY_CLAWD);
            startClip(target, clip, CLIP_MS[clip] || 3600, {
              patrolDir: Math.random() < 0.5 ? -1 : 1,
            });
            if (clip === "walk") {
              const walker = target;
              const backOk = () =>
                !stageBusy() &&
                !reducedMotion &&
                !walker.seq &&
                walker.y === 0 &&
                !isHostSleeping();
              later(3700, () => {
                if (backOk()) startClip(walker, "walk", 3600, { patrolDir: -walker.patrolDir });
              });
              later(7400, () => {
                if (backOk()) resetHomePositions(true);
              });
            }
          }
          renderAllFrames(now);
        }
      }
    }
    if (
      !disposed &&
      !dozing &&
      !parked &&
      !isHostDetached() &&
      !isDocHidden() &&
      !isHostSleeping() &&
      !isWindowBlurred()
    ) {
      theaterTimer = win.setTimeout(pickNextTheater, 4600 + Math.round(Math.random() * 2600));
    } else {
      theaterTimer = 0;
    }
  };
  const scheduleTheater = (delayMs?: number) => {
    win.clearTimeout(theaterTimer);
    theaterTimer = 0;
    if (
      disposed ||
      dozing ||
      parked ||
      isHostDetached() ||
      isDocHidden() ||
      isHostSleeping() ||
      isWindowBlurred()
    ) {
      return;
    }
    theaterTimer = win.setTimeout(
      pickNextTheater,
      delayMs ?? 4600 + Math.round(Math.random() * 2600),
    );
  };
  scheduleTheater(3800);

  const trySnapOntoTower = (mover: Ent, now = performance.now()) => {
    if (mover.dragging) return false;
    const moverChain = getTowerMembers(mover.id);
    const moverCx = getEntWorldCx(mover);
    const moverFootY = mover.y || 0;
    const seenRoots = new Set(moverChain);

    for (const cand of allActiveEnts()) {
      const root = getTowerRoot(cand.id);
      if (!root || seenRoots.has(root.id)) continue;
      seenRoots.add(root.id);
      if (root.dragging || root.ballisticActive || root.leap || (root.y || 0) < -4) continue;
      if (
        !isMiniEnt(root) &&
        now < root.overrideUntil &&
        ["onFire", "siren", "spinHop"].includes(root.overridePose ?? "")
      ) {
        continue;
      }
      const baseChain = getTowerMembers(root.id);
      if (!canJoinTower(baseChain.length, moverChain.length, miniPileEnabled)) continue;
      const top = getEnt(baseChain.at(-1));
      if (
        !top ||
        top.dragging ||
        top.ballisticActive ||
        top.leap ||
        ((top.y || 0) < -2 && !top.stackedOn)
      ) {
        continue;
      }

      const perchY = computeWorldFootY(top) - mountStepH(top.id);
      if (
        Math.abs(moverCx - getEntWorldCx(top)) <= 28 &&
        moverFootY >= perchY - 24 &&
        moverFootY <= perchY + 20
      ) {
        resetActorTransient(mover, { keepFly: true });
        mover.stackedOn = top.id;
        mover.y = 0;
        mover.perchUntil = 0;
        if (!isMiniEnt(mover)) {
          mover.overridePose = "happy";
          mover.overrideUntil = now + 950;
          mover.sym = "heart";
          mover.symUntil = now + 1100;
          playSeq(mover, [["happy", 1, 2, -1]]);
        }
        syncAllStackedFollowers();
        renderAllFrames(now);
        return true;
      }
    }
    return false;
  };

  const settleOnto = (subRoot: Ent, holder: Ent | null) => {
    if (holder) {
      subRoot.stackedOn = holder.id;
      subRoot.y = 0;
      syncAllStackedFollowers();
    } else {
      subRoot.stackedOn = null;
      subRoot.y = 0;
      enforceGroundSeparation();
    }
  };

  const startGravitySettle = (subRoot: Ent, targetHolderId: string | null) => {
    const subLen = getTowerMembers(subRoot.id).length;
    if (reducedMotion) {
      subRoot.flying += 1;
      subRoot.ballisticActive = false;
      const holder = targetHolderId ? getEnt(targetHolderId) : null;
      settleOnto(
        subRoot,
        holder &&
          !holder.dragging &&
          canJoinTower(getTowerMembers(holder.id).length, subLen, miniPileEnabled)
          ? holder
          : null,
      );
      subRoot.vx = 0;
      subRoot.vy = 0;
      subRoot.rot = 0;
      renderAllFrames(performance.now());
      return;
    }

    const settleId = (subRoot.flying += 1);
    subRoot.ballisticActive = true;
    syncDirectMotionDomAttr(subRoot, subRoot.el);
    let vy = 0.65;
    let prev = performance.now();
    const step = (now: number) => {
      if (disposed || settleId !== subRoot.flying || subRoot.dragging) {
        if (disposed || subRoot.dragging) subRoot.ballisticActive = false;
        return;
      }
      const k = Math.max(0.5, Math.min(2.5, (now - prev) / 16.6667));
      prev = now;
      let holder = targetHolderId ? getEnt(targetHolderId) : null;
      if (
        holder &&
        (holder.dragging ||
          getTowerMembers(holder.id).includes(subRoot.id) ||
          !canJoinTower(getTowerMembers(holder.id).length, subLen, miniPileEnabled))
      ) {
        holder = null;
      }
      const goalY = holder ? computeWorldFootY(holder) - mountStepH(holder.id) : 0;
      if (isDocHidden() || isHostSleeping() || parked) {
        subRoot.ballisticActive = false;
        subRoot.vx = 0;
        subRoot.vy = 0;
        subRoot.rot = 0;
        settleOnto(subRoot, holder);
        syncTower(subRoot, now);
        reclaimStageVram();
        return;
      }
      if (holder) {
        const curCx = getEntWorldCx(subRoot);
        setEntWorldCx(subRoot, curCx + (getEntWorldCx(holder) - curCx) * Math.min(1, 0.35 * k));
      }
      vy = Math.min(14, vy + 0.54 * k);
      subRoot.y += vy * k;
      subRoot.vy = vy;
      if (subRoot.y >= goalY) {
        subRoot.ballisticActive = false;
        subRoot.vx = 0;
        subRoot.vy = 0;
        subRoot.rot = 0;
        if (holder) {
          subRoot.stackedOn = holder.id;
          subRoot.y = 0;
          if (!isMiniEnt(subRoot)) playSeq(subRoot, [["idle", 1, 2, -1]]);
          syncAllStackedFollowers();
        } else {
          subRoot.stackedOn = null;
          subRoot.y = 0;
          if (!isMiniEnt(subRoot)) playSeq(subRoot, landingSteps(1));
          enforceGroundSeparation();
        }
        syncTower(subRoot, now);
        renderAllFrames(now);
        return;
      }
      syncAllStackedFollowers();
      syncTower(subRoot, now);
      rAF(step);
    };
    rAF(step);
  };

  const detachWithGravitySettle = (pulledId: string) => {
    const pulled = getEnt(pulledId);
    if (!pulled) return;
    const lowerHolderId = pulled.stackedOn || null;
    const upperRider = findDirectRider(pulledId);
    if (upperRider) {
      const riderStartFootY = computeWorldFootY(upperRider);
      const riderStartCx = getEntWorldCx(upperRider);
      upperRider.stackedOn = null;
      upperRider.perchUntil = 0;
      resetActorTransient(upperRider, { keepFly: true });
      setEntWorldCx(upperRider, riderStartCx);
      upperRider.y = riderStartFootY;
    }
    pulled.stackedOn = null;
    pulled.perchUntil = 0;
    if (upperRider) startGravitySettle(upperRider, lowerHolderId);
  };

  const dismountRidersSideHop = (baseId: string) => {
    const chain = getTowerMembers(baseId);
    const idx = chain.indexOf(baseId);
    if (idx < 0 || idx >= chain.length - 1) return false;
    const snapshots = chain
      .slice(idx + 1)
      .map((id) => getEnt(id))
      .filter((r): r is Ent => r !== null)
      .map((r) => ({ r, footY: computeWorldFootY(r), cx: getEntWorldCx(r) }));
    for (const s of snapshots) {
      s.r.stackedOn = null;
      s.r.perchUntil = 0;
      resetActorTransient(s.r, { keepFly: true });
      s.r.y = s.footY;
      setEntWorldCx(s.r, s.cx);
    }
    snapshots.forEach((s, i) => {
      const dir = i % 2 === 0 ? -1 : 1;
      if (reducedMotion) {
        setEntWorldCx(s.r, s.cx + dir * (28 + i * 18));
        s.r.y = 0;
      } else {
        const isM = isMiniEnt(s.r);
        startEntityBallistic(
          s.r,
          dir * ((isM ? 2.6 : 2.8) + i * 0.6),
          (isM ? -3.5 : -3.8) - i * 0.4,
          { noSnap: true },
        );
      }
    });
    if (reducedMotion) {
      enforceGroundSeparation();
      renderAllFrames(performance.now());
    }
    return true;
  };

  const triggerObstacleEncounter = (moverId: string, obstacleId: string) => {
    const mover = getEnt(moverId);
    const obs = getEnt(obstacleId);
    if (!mover || !obs || mover.id === obs.id) return null;
    const now = performance.now();
    const obsRoot = getTowerRoot(obs.id) ?? obs;
    if (obsRoot.id === mover.id) return null;

    const moverCx = getEntWorldCx(mover);
    const obsCx = getEntWorldCx(obsRoot);
    const dir = moverCx <= obsCx ? 1 : -1;
    const landCx = obsCx + dir * (entHalfW(obsRoot) + entHalfW(mover) + 12);
    const { minX, maxX } = stageBoundsX();
    const mHw = entHalfW(mover);
    const canLeap = landCx >= minX + mHw + 2 && landCx <= maxX - mHw - 2;
    const obsTowerLen = getTowerMembers(obsRoot.id).length;
    const canPerch = getTowerMembers(mover.id).length === 1 && obsTowerLen < maxTowerDepthAllowed();

    let action = chooseObstacleAction({ canLeap, canPerch });
    if (action === "autoPerch" && !canPerch) action = canLeap ? "leapfrog" : "greetTurn";
    if (action === "leapfrog" && !canLeap) action = canPerch ? "autoPerch" : "greetTurn";
    const top = action === "autoPerch" ? getStackTop(obsRoot.id) : null;
    if (action === "leapfrog") {
      const peak = Math.min(62, 26 + Math.max(0, obsTowerLen - 1) * 14);
      resetActorTransient(mover, { keepFly: true });
      if (reducedMotion) {
        setEntWorldCx(mover, landCx);
        mover.y = 0;
        enforceGroundSeparation();
      } else {
        mover.leap = {
          cx0: moverCx,
          cx1: landCx,
          peak,
          startTick: tickIdx,
          ticks: 6,
          landOnto: null,
        };
        if (!isMiniEnt(mover)) {
          mover.faceDir = dir > 0 ? "right" : "left";
          mover.sym = "spark";
          mover.symUntil = now + 750;
        }
      }
    } else if (action === "autoPerch" && top) {
      resetActorTransient(mover, { keepFly: true });
      if (reducedMotion) {
        mover.stackedOn = top.id;
        mover.y = 0;
        mover.perchUntil = now + 7200;
        syncAllStackedFollowers();
      } else {
        const peak = Math.max(26, Math.abs(computeWorldFootY(top) - mountStepH(top.id)) + 10);
        mover.leap = {
          cx0: moverCx,
          cx1: getEntWorldCx(top),
          peak,
          startTick: tickIdx,
          ticks: 5,
          landOnto: top.id,
        };
        if (!isMiniEnt(obsRoot) && !obsRoot.dragging && !obsRoot.stackedOn) {
          startClip(obsRoot, "walk", 2800, { patrolDir: dir });
        }
      }
    } else {
      action = "greetTurn";
      if (isMiniEnt(mover)) {
        mover.act = null;
        mover.bumpUntilTick = tickIdx + 6;
        mover.blinkAt = tickIdx;
        mover.dir = -dir;
        setEntWorldCx(mover, moverCx - dir * 4);
      } else {
        mover.nextBlinkTick = tickIdx;
        mover.patrolDir = -dir;
        startClip(mover, mover.id === "clawd" ? "wave" : "tilt", 560, {
          face: dir > 0 ? "right" : "left",
          sym: "note",
          rot: mover.id === "cat" ? -8 : 0,
        });
        later(520, () => {
          if (
            !disposed &&
            !stageBusy() &&
            !reducedMotion &&
            !dozing &&
            !mover.dragging &&
            !mover.stackedOn
          ) {
            startClip(mover, "walk", 2000, { patrolDir: -dir });
          }
        });
      }
      if (isMiniEnt(obsRoot)) {
        obsRoot.bumpUntilTick = tickIdx + 5;
        obsRoot.blinkAt = tickIdx;
      } else {
        obsRoot.nextBlinkTick = tickIdx;
        obsRoot.nodY = PX;
        obsRoot.nodUntil = now + 180;
      }
    }

    renderAllFrames(now);
    return action;
  };

  // One ballistic loop for the companions and the mini crabs.
  const launchEntity = (ent: Ent, vx0: number, vy0: number, bopts: BallisticOptions = {}) => {
    const flightId = (ent.flying += 1);
    const reboundTargetX =
      !isMiniEnt(ent) && bopts.reboundTargetX !== undefined && Number.isFinite(bopts.reboundTargetX)
        ? bopts.reboundTargetX
        : null;
    const vLim = isMiniEnt(ent) ? 14 : 18;
    const maxVx = reboundTargetX !== null ? 64 : vLim;
    let vx = Math.max(-maxVx, Math.min(maxVx, vx0));
    let vy = Math.max(-vLim, Math.min(vLim, vy0));
    let bounces = 0;
    let scattered = false;
    resetActorTransient(ent, { keepFly: true, keepVel: true, keepBallistic: true });
    ent.ballisticActive = true;
    if (!isMiniEnt(ent)) {
      ent.reboundNoBump = Boolean(bopts.reboundNoBump);
      ent.overridePose = "dangle";
      ent.overrideUntil = performance.now() + 3000;
    }
    // Lock data-direct at take-off so the first frame never rides the CSS transition.
    syncDirectMotionDomAttr(ent, ent.el);

    const settle = (now: number) => {
      enforceGroundSeparation();
      if (isMiniEnt(ent)) syncTower(ent, now);
      else applyActorTransform(ent, now);
    };

    let prev = performance.now();
    const step = (now: number) => {
      if (disposed || flightId !== ent.flying || ent.dragging) {
        if (disposed || ent.dragging) ent.ballisticActive = false;
        return;
      }
      if (isDocHidden() || isHostSleeping() || parked) {
        if (reboundTargetX !== null) {
          ent.x = Math.max(8, Math.min(maxXFor(readStageWidth()), reboundTargetX));
        }
        if (!isMiniEnt(ent)) ent.reboundNoBump = false;
        resetActorTransient(ent, { keepFly: true });
        ent.y = 0;
        settle(now);
        reclaimStageVram();
        return;
      }
      const k = Math.max(0.5, Math.min(2.5, (now - prev) / 16.6667));
      prev = now;
      const mini = isMiniEnt(ent);
      vy += (mini ? 0.46 : 0.44) * k;
      const drag = Math.pow(mini ? 0.985 : 0.988, k);
      vx *= drag;
      vy *= drag;

      let mainMinX = 8;
      let mainMaxX = 40;
      if (mini) {
        const { minX, maxX } = stageBoundsX();
        const hw = entHalfW(ent);
        let cx = getEntWorldCx(ent) + vx * k;
        if (cx < minX + hw) {
          cx = minX + hw;
          vx = -0.45 * vx;
        } else if (cx > maxX - hw) {
          cx = maxX - hw;
          vx = -0.45 * vx;
        }
        setEntWorldCx(ent, cx);
        ent.y = Math.max(-180, (ent.y || 0) + vy * k);
      } else {
        ent.x += vx * k;
        ent.y += vy * k;
        mainMinX = 8;
        mainMaxX = maxXFor(readStageWidth());
        if (reboundTargetX !== null) {
          const targetX = Math.max(mainMinX, Math.min(mainMaxX, reboundTargetX));
          if ((vx >= 0 && ent.x > targetX) || (vx < 0 && ent.x < targetX)) {
            ent.x = targetX;
            vx = 0;
          }
        }
        if (ent.x < mainMinX) {
          ent.x = mainMinX;
          vx = -0.45 * vx;
        } else if (ent.x > mainMaxX) {
          ent.x = mainMaxX;
          vx = -0.45 * vx;
        }
        if (ent.y < -180) {
          ent.y = -180;
          vy = -0.45 * vy;
        }
      }
      ent.vx = vx;
      ent.vy = vy;

      if (!bopts.noSnap && vy >= 0 && trySnapOntoTower(ent, now)) return;

      if (!isMiniEnt(ent)) {
        const other = ent.id === "cat" ? actors.clawd : actors.cat;
        if (
          !bopts.reboundNoBump &&
          !other.reboundNoBump &&
          !other.dragging &&
          !other.stackedOn &&
          !ent.stackedOn &&
          Math.abs(ent.x - other.x) < 42 &&
          Math.abs(ent.y - other.y) < 22 &&
          ((ent.x < other.x && vx > 0.35) || (ent.x >= other.x && vx < -0.35)) &&
          canTriggerPair("ballistic", now, 650)
        ) {
          const sign = ent.x < other.x ? -1 : 1;
          ent.x = clampActorX(other.x + sign * 42);
          const incomingVx = vx;
          vx = -incomingVx * 0.46;
          if (Math.abs(vx) < 1.6) vx = sign * 1.8;
          ent.sym = "sweat";
          ent.symUntil = now + 750;
          startClip(other, "wow", 800, { sym: "bang", face: sign < 0 ? "left" : "right" });
          startEntityBallistic(
            other,
            Math.max(-7.2, Math.min(7.2, incomingVx * 0.62 || -sign * 2.6)),
            -2.7,
          );
          renderAllFrames(now);
        }
      }

      if (ent.y >= 0) {
        ent.y = 0;
        if (!isMiniEnt(ent) && !scattered) {
          scattered = true;
          scatterCrabsNear(ent.x + 48);
        }
        const maxB = mini ? 1 : 2;
        const minVy = mini ? 2.6 : 2.4;
        if (Math.abs(vy) > minVy && bounces < maxB) {
          vy = -vy * (mini ? 0.32 : 0.36);
          vx *= mini ? 0.78 : 0.82;
          bounces += 1;
          // Mid-flight bounces keep ballisticActive, so data-direct stays locked.
          if (!isMiniEnt(ent)) playSeq(ent, [["flat", 1, 2, 0]]);
        } else {
          const impact = Math.abs(vy);
          if (reboundTargetX !== null) {
            ent.x = Math.max(mainMinX, Math.min(mainMaxX, reboundTargetX));
          }
          if (!isMiniEnt(ent)) ent.reboundNoBump = false;
          resetActorTransient(ent, { keepFly: true });
          if (!isMiniEnt(ent)) {
            const steps = landingSteps(impact > 1.2 || bounces > 0 ? 2 : 1);
            playSeq(ent, steps);
            if (ent.throws >= 3) {
              ent.throws = 0;
              startClip(ent, "angry", 1400 + seqTotalMs(steps), { sym: "vein" });
            }
          }
          settle(now);
          renderAllFrames(now);
          return;
        }
      }
      ent.rot = Math.max(-14, Math.min(14, -vx * 0.65));
      ent.vx = vx;
      ent.vy = vy;
      syncAllStackedFollowers();
      if (isMiniEnt(ent)) {
        syncTower(ent, now);
      } else {
        applyActorTransform(ent, now);
        // Repaint only when the pose actually changes (take-off to dangle, touch-down to flat).
        if (resolvePoseFor(ent, now) !== ent.lastRender.poseKey) renderAllFrames(now);
      }
      rAF(step);
    };
    rAF(step);
  };

  const startEntityBallistic = (
    ent: Ent,
    vx0: number,
    vy0: number,
    bopts: BallisticOptions = {},
  ) => {
    if (!isMiniEnt(ent) && Math.hypot(vx0, vy0) > 2.2) dismountRidersSideHop(ent.id);
    if (reducedMotion) {
      resetActorTransient(ent, { keepPose: !isMiniEnt(ent) && ent.overridePose !== "dangle" });
      if (
        !isMiniEnt(ent) &&
        bopts.reboundTargetX !== undefined &&
        Number.isFinite(bopts.reboundTargetX)
      ) {
        ent.x = clampActorX(bopts.reboundTargetX);
      }
      if (bopts.noSnap || !trySnapOntoTower(ent, performance.now())) {
        ent.y = 0;
        enforceGroundSeparation();
        if (isMiniEnt(ent)) syncTower(ent);
        else applyActorTransform(ent);
        renderAllFrames(performance.now());
      }
      return;
    }
    if (!isMiniEnt(ent) && bopts.anticipate && ent.y === 0 && !ent.stackedOn) {
      const prepId = (ent.flying += 1);
      ent.ballisticActive = false;
      playSeq(ent, [["squash", 2, 2, -1]]);
      later(TICK * 2, () => {
        if (ent.flying === prepId && !ent.dragging) launchEntity(ent, vx0, vy0, bopts);
      });
      return;
    }
    launchEntity(ent, vx0, vy0, bopts);
  };

  const dragReleaseHooks: (() => void)[] = [];
  let dragRafPending = false;
  let dragRafId = 0;
  const scheduleDragRender = () => {
    if (dragRafPending || disposed) return;
    dragRafPending = true;
    dragRafId = rAF((frameNow) => {
      dragRafId = 0;
      dragRafPending = false;
      if (!disposed) renderAllFrames(frameNow);
    });
  };

  // Right-click feeds a donut, Alt+click a coffee: it clears the poke count and ends a sulk.
  const feedActor = (actor: Actor, item: "donut" | "coffee") => {
    if (disposed) return false;
    const now = performance.now();
    markActivity();
    actor.pokeCount = 0;
    actor.lastPokeAt = 0;
    if (actor.overridePose === "sulk" || actor.overridePose === "angry") {
      resetActorTransient(actor);
    }
    startClip(actor, item === "coffee" ? "feedCoffee" : "feedDonut", 2200, { sym: "heart" });
    renderAllFrames(now);
    return true;
  };

  const bindEntityPointer = (ent: Ent) => {
    const domNode = ent.el;
    const dragThreshold = isMiniEnt(ent) ? 2.5 : 7;
    let downX = 0;
    let downY = 0;
    let startX = 0;
    let startY = 0;
    let cachedA = 720;
    let cachedB = 680;
    let lastMoveX = 0;
    let lastMoveY = 0;
    let lastMoveT = 0;
    let moved = false;
    let petTimer = 0;
    let petTriggered = false;

    const onDown = (evt: PointerEvent) => {
      if (yieldMode === "peek" || evt.button !== 0 || (isMiniEnt(ent) && !miniPileEnabled)) return;
      evt.preventDefault();
      evt.stopPropagation();
      if (!isMiniEnt(ent) && evt.altKey) {
        feedActor(ent, "coffee");
        return;
      }
      try {
        ent.el.setPointerCapture(evt.pointerId);
      } catch {
        // The pointer may already be gone.
      }
      const downNow = performance.now();
      if (ent.glideUntil && downNow < ent.glideUntil) {
        ent.glideSeq += 1;
        ent.glideUntil = 0;
        const er = ent.el.getBoundingClientRect();
        const hr = hostEl.getBoundingClientRect();
        if (er.width > 0 || er.right > er.left) {
          if (isMiniEnt(ent)) setEntWorldCx(ent, er.left - hr.left + 20);
          else ent.x = clampActorX(er.left - hr.left);
        }
        if (isMiniEnt(ent)) ent.el.style.transition = "";
        else {
          for (const cid of getTowerMembers(ent.id)) {
            const member = getEnt(cid);
            if (!member) continue;
            member.glideSeq += 1;
            member.glideUntil = 0;
            member.el.style.transition = "";
          }
          syncTower(ent);
        }
      }
      if (isMiniEnt(ent)) {
        const { minX, maxX } = stageBoundsX();
        const hw = entHalfW(ent);
        cachedA = minX + hw;
        cachedB = maxX - hw;
        startX = getEntWorldCx(ent);
      } else {
        ent.reboundNoBump = false;
        cachedA = readStageWidth();
        startX = ent.x;
      }
      downX = evt.clientX;
      downY = evt.clientY;
      startY = ent.stackedOn ? computeWorldFootY(ent) : ent.y || 0;
      lastMoveX = evt.clientX;
      lastMoveY = evt.clientY;
      lastMoveT = downNow;
      moved = false;
      petTriggered = false;
      markActivity();
      resetActorTransient(ent);

      if (!isMiniEnt(ent)) {
        win.clearTimeout(petTimer);
        petTimer = win.setTimeout(() => {
          if (!moved && !disposed) {
            petTriggered = true;
            startClip(ent, "pet", 1100, { sym: "heart" });
            renderAllFrames(performance.now());
          }
        }, 360);
      }
    };

    const onMove = (evt: PointerEvent) => {
      if (lastMoveT === 0) return;
      const dxTotal = evt.clientX - downX;
      const dyTotal = evt.clientY - downY;
      let justStarted = false;
      if (!moved && Math.hypot(dxTotal, dyTotal) > dragThreshold) {
        moved = true;
        justStarted = true;
        win.clearTimeout(petTimer);
        detachWithGravitySettle(ent.id);
        if (!isMiniEnt(ent)) {
          ent.sideEdgeSnap = false;
          ent.sidePushOriginX = null;
          ent.sideEdgeDirectUntil = 0;
        }
        ent.ballisticActive = false;
        ent.dragging = true;
        syncDirectMotionDomAttr(ent, domNode);
        syncMascotDragRootAttr();
      }
      if (!moved) return;
      evt.stopPropagation();
      const now = performance.now();
      const dt = Math.max(4, now - lastMoveT);
      ent.vx = ent.vx * 0.4 + ((evt.clientX - lastMoveX) / dt) * 16 * 0.6;
      ent.vy = ent.vy * 0.4 + ((evt.clientY - lastMoveY) / dt) * 16 * 0.6;
      ent.rot = Math.max(-14, Math.min(14, -ent.vx * 0.7));
      lastMoveX = evt.clientX;
      lastMoveY = evt.clientY;
      lastMoveT = now;

      const nextY = Math.max(-180, Math.min(0, startY + dyTotal));
      if (isMiniEnt(ent)) {
        const clampedCx = Math.max(cachedA, Math.min(cachedB, startX + dxTotal));
        const nextPx = Math.max(2, clampedCx - 32);
        ent.px = nextPx;
        ent.lastX = Math.round(nextPx);
        ent.y = nextY;
        applyMiniTransform(ent, snapCoord(nextPx, true), snapCoord(nextY, true), "39", ent.rot);
      } else {
        const rightReserve =
          popoverRightWidth > 0 ? Math.min(cachedA - 150, popoverRightWidth + 16) : 0;
        ent.x = Math.max(4, Math.min(Math.max(24, cachedA - 88 - rightReserve), startX + dxTotal));
        ent.y = nextY;
        applyActorTransform(ent, now);
      }

      if (justStarted) renderAllFrames(now);
      else scheduleDragRender();

      if (!isMiniEnt(ent) && !reducedMotion && ent.dragging && ent.y > -22) {
        const other = ent.id === "cat" ? actors.clawd : actors.cat;
        if (
          !other.dragging &&
          !other.stackedOn &&
          other.y === 0 &&
          Math.abs(ent.x - other.x) < 38
        ) {
          if (Math.abs(ent.vx) >= 2.0 && canTriggerPair("dragBump", now, 750)) {
            const pushDir = ent.vx >= 0 ? 1 : -1;
            startClip(other, "wow", 750, { sym: "bang", face: pushDir > 0 ? "left" : "right" });
            startEntityBallistic(other, pushDir * Math.min(5.2, Math.abs(ent.vx) * 0.58), -2.5);
            scheduleDragRender();
          } else if (Math.abs(ent.vx) < 2.0 && canTriggerPair("dragPass", now, 1400)) {
            gaze(other, ent.x < other.x ? "left" : "right", 750, false, "note");
            hop(other, "wave");
            scheduleDragRender();
          }
        }
        if (
          miniPileEnabled &&
          ent.y > -16 &&
          Math.abs(ent.vx) > 1.4 &&
          canTriggerPair("dragCrab", now, 800)
        ) {
          if (
            miniCrabs.some(
              (mc) => !mc.act && !mc.stackedOn && Math.abs(crabHostCenter(mc) - (ent.x + 48)) < 32,
            )
          ) {
            scatterCrabsNear(ent.x + 48);
            scheduleDragRender();
          }
        }
      }
    };

    const onUp = (evt: PointerEvent) => {
      if (lastMoveT === 0) return;
      win.clearTimeout(petTimer);
      if (ent.el.hasPointerCapture(evt.pointerId)) ent.el.releasePointerCapture(evt.pointerId);
      const prevMoveT = lastMoveT;
      lastMoveT = 0;

      if (moved) {
        ent.dragging = false;
        syncMascotDragRootAttr();
        const pNow = performance.now();
        if (pNow - prevMoveT > 35) {
          ent.vx = 0;
          ent.vy = 0;
        }
        if (Math.hypot(ent.vx, ent.vy) < 4.5 && trySnapOntoTower(ent, pNow)) {
          syncDirectMotionDomAttr(ent, domNode);
          moved = false;
          return;
        }
        if (!isMiniEnt(ent)) {
          const wallNow = Date.now();
          if (wallNow - ent.lastThrowAt > 8000) ent.throws = 0;
          ent.throws += 1;
          ent.lastThrowAt = wallNow;
        }
        const mul = isMiniEnt(ent) ? 0.78 : 0.85;
        startEntityBallistic(ent, ent.vx * mul, ent.vy * mul);
        moved = false;
        return;
      }

      if (isMiniEnt(ent)) {
        ent.bumpUntilTick = tickIdx + 6;
        ent.passHopUntilTick = tickIdx + 4;
        renderAllFrames(performance.now());
      } else if (!petTriggered) {
        triggerPoke(ent, true);
      }
    };

    const cancelDragOnBlur = () => {
      if (lastMoveT === 0 && !ent.dragging) return;
      win.clearTimeout(petTimer);
      lastMoveT = 0;
      if (moved || ent.dragging) {
        moved = false;
        ent.dragging = false;
        ent.ballisticActive = false;
        ent.vx = 0;
        ent.vy = 0;
        ent.rot = 0;
        syncMascotDragRootAttr();
        syncDirectMotionDomAttr(ent, domNode);
        if (!disposed) startEntityBallistic(ent, 0, 0, { noSnap: true });
      }
    };
    dragReleaseHooks.push(cancelDragOnBlur);

    const onContextMenu = (evt: MouseEvent) => {
      if (isMiniEnt(ent) || yieldMode === "peek") return;
      evt.preventDefault();
      evt.stopPropagation();
      feedActor(ent, "donut");
    };

    ent.el.addEventListener("pointerdown", onDown);
    ent.el.addEventListener("pointermove", onMove);
    ent.el.addEventListener("pointerup", onUp);
    ent.el.addEventListener("pointercancel", onUp);
    ent.el.addEventListener("contextmenu", onContextMenu);
    cleanups.push(() => {
      win.clearTimeout(petTimer);
      ent.el.removeEventListener("pointerdown", onDown);
      ent.el.removeEventListener("pointermove", onMove);
      ent.el.removeEventListener("pointerup", onUp);
      ent.el.removeEventListener("pointercancel", onUp);
      ent.el.removeEventListener("contextmenu", onContextMenu);
    });
  };

  bindEntityPointer(actors.cat);
  bindEntityPointer(actors.clawd);
  for (const mc of miniCrabs) bindEntityPointer(mc);

  const hasDozeTransition = (now: number) =>
    (Boolean(actors.cat.overridePose) && now < actors.cat.overrideUntil) ||
    (Boolean(actors.clawd.overridePose) && now < actors.clawd.overrideUntil);
  const inTrans = () =>
    [actors.cat, actors.clawd, ...miniCrabs].some(
      (e) => e.dragging || e.ballisticActive || e.leap || e.y < -0.4 || Math.abs(e.vy) > 0.01,
    ) || Boolean(reboundTm);
  const syncPwr = () => {
    if (disposed) return;
    if (isHostDetached() || parked || isDocHidden() || isHostSleeping()) {
      syncHeartbeat();
      reclaimStageVram();
      return;
    }
    if (!isAttrB()) {
      wb = false;
      if (dozing) {
        wakeUp();
        return;
      }
    }
    syncHeartbeat();
    if (!theaterTimer && currentTickMs > 0 && !dozing && !reducedMotion) scheduleTheater();
    if (!isWindowBlurred()) renderAllFrames(performance.now());
  };
  const onWBlur = () => {
    if (disposed) return;
    wb = true;
    for (const release of dragReleaseHooks) release();
    syncHeartbeat();
  };
  const onWFocus = () => {
    wb = false;
    syncPwr();
  };
  win.addEventListener("blur", onWBlur);
  win.addEventListener("focus", onWFocus);
  cleanups.push(() => {
    win.removeEventListener("blur", onWBlur);
    win.removeEventListener("focus", onWFocus);
  });
  {
    const mo = new MutationObserver(() => {
      if (!disposed) syncPwr();
    });
    mo.observe(doc.documentElement, { attributes: true, attributeFilter: [WIN_BLUR_ATTR] });
    cleanups.push(() => mo.disconnect());
  }
  const leaderActor = () => (camp === "claude" ? actors.clawd : actors.cat);
  const partnerActor = () => (camp === "claude" ? actors.cat : actors.clawd);
  const faceToward = (from: Actor, to: Actor): FaceDir => (to.x >= from.x ? "right" : "left");

  const heartbeatPaused = () =>
    isHostDetached() ||
    parked ||
    isDocHidden() ||
    isHostSleeping() ||
    (isWindowBlurred() && (dozing || !inTrans())) ||
    (reducedMotion && !inTrans());

  const onHeartbeat = () => {
    if (disposed) return;
    const now = performance.now();
    if (heartbeatPaused()) {
      syncHeartbeat(now);
      if (isVramSleepState()) reclaimStageVram();
      return;
    }
    tickIdx += 1;
    updateBalance();
    ecoTick(now);
    renderAllFrames(now);
    syncHeartbeat(now);
  };

  function syncHeartbeat(now = performance.now()) {
    let targetMs = TICK;
    if (disposed || heartbeatPaused()) targetMs = 0;
    else if (dozing && !stageBusy() && !hasDozeTransition(now)) targetMs = DOZE_TICK;
    if (targetMs === 0 || dozing || reducedMotion) {
      win.clearTimeout(theaterTimer);
      theaterTimer = 0;
    } else if (!theaterTimer) {
      scheduleTheater();
    }
    if (isVramSleepState()) reclaimStageVram();
    if (targetMs === currentTickMs) return;
    if (tickTimer !== null) {
      win.clearInterval(tickTimer);
      tickTimer = null;
    }
    currentTickMs = targetMs;
    if (targetMs > 0) tickTimer = win.setInterval(onHeartbeat, targetMs);
  }

  function wakeUp() {
    if (!dozing) return;
    dozing = false;
    lastActivityAt = performance.now();
    syncHeartbeat();
    // Wake with a stretch, the cat two beats behind.
    startClip(actors.clawd, "stretch", 1100);
    later(TICK * 2, () => {
      if (!dozing) startClip(actors.cat, "stretch", 1100);
    });
    renderAllFrames(performance.now());
  }

  function markActivity() {
    if (!isAttrB()) wb = false;
    lastActivityAt = performance.now();
    if (dozing && !isHostSleeping() && !isWindowBlurred()) wakeUp();
    else syncHeartbeat();
  }

  // Dozing starts with a yawn (cat first, Clawd 0.4s later); resolvePoseFor then holds sleep.
  function startDoze() {
    if (dozing) return;
    dozing = true;
    for (const id of ACTOR_IDS) {
      const a = actors[id];
      if (a.overridePose && a.overridePose !== "dangle") a.overrideUntil = 0;
      a.eyeScan = 0;
    }
    const prePose = isLateNight() ? "nightSip" : "yawn";
    const preMs = isLateNight() ? 1800 : 1200;
    startClip(actors.cat, prePose, preMs);
    later(400, () => {
      if (dozing) startClip(actors.clawd, prePose, preMs);
    });
    const now = performance.now();
    renderAllFrames(now);
    syncHeartbeat(now);
  }

  // Per tick: busy counts as activity, idle times out into a doze, and walkers meet obstacles.
  const ecoTick = (now: number) => {
    if (stageBusy()) {
      lastActivityAt = now;
      if (dozing) wakeUp();
      return;
    }
    const limit = isLateNight() ? DOZE_AFTER_NIGHT_MS : DOZE_AFTER_MS;
    if (!dozing && now - lastActivityAt > limit) {
      startDoze();
      return;
    }
    if (reducedMotion || dozing || now < duetUntil) return;

    const { clawd, cat } = actors;
    if (
      !clawd.dragging &&
      !cat.dragging &&
      !clawd.ballisticActive &&
      !cat.ballisticActive &&
      !clawd.stackedOn &&
      !cat.stackedOn &&
      !clawd.leap &&
      !cat.leap &&
      clawd.y === 0 &&
      cat.y === 0
    ) {
      const cWalking = resolvePoseFor(clawd, now) === "walk" && now < clawd.overrideUntil;
      const kWalking = resolvePoseFor(cat, now) === "walk" && now < cat.overrideUntil;
      const enc = classifyPairEncounter({
        xA: clawd.x,
        yA: clawd.y,
        walkingA: cWalking,
        dirA: clawd.patrolDir,
        xB: cat.x,
        yB: cat.y,
        walkingB: kWalking,
        dirB: cat.patrolDir,
        contactDist: 46,
        verticalTol: 22,
      });
      if (enc?.kind === "bump" && canTriggerPair("mainWalk", now, 1200)) {
        clawd.x = clampActorX(clawd.x - enc.sign * 5);
        cat.x = clampActorX(cat.x + enc.sign * 5);
        clawd.faceDir = enc.sign > 0 ? "right" : "left";
        cat.faceDir = enc.sign > 0 ? "left" : "right";
        clawd.sym = "bang";
        clawd.symUntil = now + 850;
        cat.sym = "spark";
        cat.symUntil = now + 850;
        clawd.overridePose = "idle";
        clawd.overrideUntil = now + 440;
        cat.overridePose = "idle";
        cat.overrideUntil = now + 440;
        playSeq(clawd, [
          ["squash", 1, 2, -1, 0],
          ["wow", 2, -1, 1, -2],
          ["idle", 1, 1, -1, 0],
        ]);
        playSeq(cat, [
          ["squash", 1, 2, -1, 0],
          ["tilt", 2, -1, 1, -2],
          ["idle", 1, 1, -1, 0],
        ]);
        later(420, () => {
          if (disposed || stageBusy() || reducedMotion || dozing) return;
          startClip(clawd, "walk", 2200, { patrolDir: -enc.sign });
          startClip(cat, "walk", 2200, { patrolDir: enc.sign });
        });
        return;
      }
      if (enc?.kind === "passBy" && canTriggerPair("mainPass", now, 1500)) {
        const walker = enc.mover === "A" ? clawd : cat;
        const stationary = enc.mover === "A" ? cat : clawd;
        triggerObstacleEncounter(walker.id, stationary.id);
        return;
      }
    }

    if (miniPileEnabled) {
      for (const a of [clawd, cat]) {
        if (a.dragging || a.ballisticActive || a.stackedOn || a.leap || a.y !== 0) continue;
        const aWalk = resolvePoseFor(a, now) === "walk" && now < a.overrideUntil;
        for (const mc of miniCrabs) {
          if (
            mc.dragging ||
            mc.ballisticActive ||
            mc.stackedOn ||
            mc.leap ||
            mc.act ||
            mc.y !== 0
          ) {
            continue;
          }
          const d = getEntWorldCx(mc) - getEntWorldCx(a);
          if (Math.abs(d) < 40 && canTriggerPair(`obs:${a.id}:${mc.id}`, now, 1600)) {
            if (aWalk && d * a.patrolDir > 0) {
              triggerObstacleEncounter(a.id, mc.id);
              return;
            }
            if (d * mc.dir < 0) {
              triggerObstacleEncounter(mc.id, a.id);
              return;
            }
          }
        }
      }
    }
  };

  // In-place hop; skipped (straight to `then`) when reduced, held, stacked or airborne.
  const hop = (a: Actor, airPose: string, then?: () => void) => {
    const now = performance.now();
    if (reducedMotion || !actorFree(a, now) || findDirectRider(a.id)) {
      then?.();
      return;
    }
    playSeq(a, hopSteps(airPose), then);
  };

  const gaze = (a: Actor, dir: FaceDir, ms: number, up = false, symKey: string | null = null) => {
    const now = performance.now();
    if (a.dragging || (a.overridePose === "dangle" && now < a.overrideUntil)) return;
    startClip(a, "gaze", ms, { face: dir, param: up ? 1 : 0, sym: symKey || undefined });
  };

  // Leader handoff: both hop and swap places mid-air; the new leader sparks, the old one nods.
  const campHandoff = () => {
    const now = performance.now();
    if (now - lastHandoffAt < 700) return;
    lastHandoffAt = now;
    duetUntil = now + 1200;
    const leader = leaderActor();
    const old = partnerActor();
    const finish = () => {
      if (disposed) return;
      startClip(leader, "happy", 900, { sym: "spark" });
      startClip(old, "lookNod", 1300, { face: faceToward(old, leader), param: 2 });
      crabsWave();
      renderAllFrames(performance.now());
    };
    if (reducedMotion) {
      resetHomePositions(false);
      finish();
      return;
    }
    let pending = 2;
    const done = () => {
      pending -= 1;
      if (pending === 0) finish();
    };
    hop(leader, "jiggle", done);
    hop(old, "jiggle", done);
    later(TICK * 2, () => resetHomePositions(false));
  };

  const celebrateDone = () => {
    const leader = leaderActor();
    const partner = partnerActor();
    leader.sym = "heart";
    leader.symUntil = performance.now() + 1500;
    if (reducedMotion) {
      startClip(leader, "happy", 900, { sym: "heart" });
      startClip(partner, "happy", 900);
      return;
    }
    hop(leader, "jiggle");
    hop(partner, "jiggle");
  };

  // Slash-command skits, 2.4-2.8s each, back to 0fps afterwards.
  let lastVialWarnAt = 0;
  const runSlashTheater = (rawCmd: string | undefined) => {
    const cmd = String(rawCmd || "")
      .replace(/^\/+/, "")
      .trim()
      .toLowerCase();
    if (!cmd || disposed) return false;
    const now = performance.now();
    const leader = leaderActor();
    const partner = partnerActor();
    const norm = cmd === "swarm" ? "teamwork" : cmd;
    duetUntil = now + 2900;

    if (norm === "plan") {
      startClip(leader, "slashPlan", 2600);
      startClip(partner, "tilt", 1300, { rot: -8, sym: "q", face: faceToward(partner, leader) });
      later(1350, () => {
        if (!disposed) {
          startClip(partner, "lookNod", 1200, { face: faceToward(partner, leader), param: 2 });
        }
      });
    } else if (norm === "goal") {
      startClip(leader, "slashGoal", 2600);
      startClip(partner, "salute", 2400, { sym: "spark" });
    } else if (norm === "boost") {
      startClip(leader, "slashBoost", 2600);
      if (!reducedMotion) {
        spawnChromaBurst(getEntWorldCx(leader), computeWorldFootY(leader) - 18, 12, false);
        hop(leader, "slashBoost");
      }
      startClip(partner, "wow", 2200, { sym: "spark" });
    } else if (norm === "teamwork") {
      startClip(leader, "slashTeam", 2800);
      startClip(partner, "salute", 2600, { sym: "spark" });
      if (miniPileEnabled) {
        const mid = Math.round(readStageWidth() * 0.45);
        miniCrabs.forEach((mc, idx) => {
          if (mc.act?.type === "ride") return;
          const x0 = crabSafeX(mc.lastX);
          const tx = crabSafeX(mid + (idx - 1) * 28);
          mc.act = {
            type: "wave",
            start: tickIdx + 1,
            segs: [
              { ticks: 6, x0, x1: tx, y0: 0, y1: 0, sprite: "walk" },
              { ticks: 14, x0: tx, x1: tx, y0: 0, y1: 0, sprite: "wave", hop: true },
              { ticks: 6, x0: tx, x1: x0, y0: 0, y1: 0, sprite: "walk" },
            ],
          };
        });
      }
    } else if (norm === "browser") {
      const startX = leader.x;
      const dir = startX > readStageWidth() * 0.5 ? -1 : 1;
      startClip(leader, "slashBrowser", 2600, { mirror: dir < 0 });
      startClip(partner, "wow", 2200, { sym: "spark" });
      if (!reducedMotion && !leader.stackedOn && !leader.dragging) {
        leader.x = clampActorX(startX + dir * 28);
        later(2200, () => {
          if (!disposed && !leader.dragging && !leader.stackedOn) resetHomePositions(true);
        });
      }
    } else if (norm === "compact") {
      startClip(actors.clawd, "slashCompact", 2800);
      startClip(actors.cat, "slashCompact", 2800, { mirror: true });
    } else if (norm === "schedule") {
      scheduleWatchUntil = Date.now() + 30 * 60 * 1000;
      renderHabitatProp(true);
      startClip(leader, "slashSchedule", 2600);
      startClip(partner, "lookNod", 2200, { face: faceToward(partner, leader), param: 3 });
    } else if (norm === "grill-me") {
      startClip(leader, "slashGrill", 2600);
      startClip(partner, "lookNod", 2400, { face: faceToward(partner, leader), param: 4 });
    } else if (norm === "learn") {
      startClip(actors.cat, "slashLearnBook", 2600);
      startClip(actors.clawd, "slashLearnBulb", 2600);
    } else {
      return false;
    }
    return true;
  };

  const NOTIFY: Record<MascotEvent, (p: MascotNotifyPayload) => void> = {
    activity() {},
    "slash-cmd"(p) {
      if (!runSlashTheater(p.cmd)) NOTIFY.send(p);
    },
    "effort-tier"(p) {
      const tier = String(p.tier || "").toLowerCase();
      if (tier === "high" || tier === "xhigh") {
        const leader = leaderActor();
        startClip(leader, "slashBoost", 2200, { sym: "spark" });
        if (!reducedMotion) {
          spawnChromaBurst(getEntWorldCx(leader), computeWorldFootY(leader) - 16, 6, true);
        }
      }
    },
    "vial-high"() {
      const wallNow = Date.now();
      if (wallNow - lastVialWarnAt < 600000) return;
      lastVialWarnAt = wallNow;
      const leftPet = actors.clawd.x <= actors.cat.x ? actors.clawd : actors.cat;
      if (leftPet.dragging || leftPet.stackedOn) return;
      const origX = leftPet.x;
      if (!reducedMotion) leftPet.x = clampActorX(16);
      startClip(leftPet, "worry", 2200, { face: "left", mirror: true, sym: "sweat" });
      later(2300, () => {
        if (!disposed && !leftPet.dragging && !leftPet.stackedOn) {
          leftPet.x = clampActorX(origX);
          resetHomePositions(true);
          renderAllFrames(performance.now());
        }
      });
    },
    "aura-complete"() {
      const now = performance.now();
      const { clawd, cat } = actors;
      duetUntil = now + 2200;
      startClip(clawd, "happy", 2000, { face: faceToward(clawd, cat), sym: "heart" });
      startClip(cat, "happy", 2000, { face: faceToward(cat, clawd), sym: "spark" });
      if (!reducedMotion) {
        hop(clawd, "happy");
        hop(cat, "happy");
      }
    },
    campSwitch() {
      // setState already hands off on a camp change; the 700ms guard dedupes double calls.
      campHandoff();
    },
    "model-shift"() {
      chromaGates.tuned = true;
      gaze(leaderActor(), "left", 800, true, "spark");
    },
    "vial-opened"() {
      chromaGates.tuned = true;
      gaze(actors.clawd, "left", 820, false, "spark");
      gaze(actors.cat, "left", 820, false, "spark");
    },
    "code-copied"() {
      chromaGates.forged = true;
      const leader = leaderActor();
      leader.nodY = PX;
      leader.nodUntil = performance.now() + 180;
      leader.sym = "note";
      leader.symUntil = performance.now() + 850;
    },
    "files-changed"() {
      chromaGates.forged = true;
      startClip(leaderActor(), "salute", 780, { sym: "spark" });
    },
    complete() {
      chromaGates.forged = true;
      celebrateDone();
    },
    orchestrator(p) {
      orchestrator = Boolean(p.on);
      if (orchestrator) {
        gaze(actors.clawd, "left", 900, true, "spark");
        gaze(actors.cat, "left", 900, true, "spark");
      }
    },
    streamDone(p) {
      if (p.error) {
        startClip(leaderActor(), "worry", 1500, { sym: "sweat" });
        startClip(partnerActor(), "worry", 1500, { sym: "sweat" });
        return;
      }
      chromaGates.forged = true;
      celebrateDone();
    },
    ripple(p) {
      const x = Number(p.x);
      if (!Number.isFinite(x)) return;
      for (const a of [actors.clawd, actors.cat]) {
        const dir: FaceDir = x < a.x + 48 ? "left" : "right";
        gaze(a, dir, 700);
        if (a.kind === "cat") {
          a.forceTwitchStart = tickIdx;
          a.forceTwitchSide = dir === "left" ? "L" : "R";
        }
      }
    },
    send() {
      const leader = leaderActor();
      const partner = partnerActor();
      startClip(leader, "salute", 900, { sym: "spark" });
      startClip(partner, "lookNod", 1200, { face: faceToward(partner, leader), param: 2 });
    },
    "host-sleep"(p) {
      hostSleep = Boolean(p.sleep);
      syncHeartbeat();
      if (hostSleep || isVramSleepState()) reclaimStageVram();
      else if (!isWindowBlurred()) renderAllFrames(performance.now());
    },
  };
  const handleNotify = (event: MascotEvent, payload: MascotNotifyPayload) => {
    if (disposed) return;
    const fn = Object.hasOwn(NOTIFY, event) ? NOTIFY[event] : null;
    if (!fn) return;
    if (event === "host-sleep") {
      fn(payload);
      return;
    }
    const wasDozing = dozing;
    markActivity();
    if (event === "activity") {
      if (wasDozing) renderAllFrames(performance.now());
      return;
    }
    fn(payload);
    renderAllFrames(performance.now());
  };

  // A pointer near the stage, or a tab coming back, restores the 100ms heartbeat at once.
  const onApproach = () => markActivity();
  hostEl.addEventListener("pointerenter", onApproach, { passive: true });
  hostEl.addEventListener("pointermove", onApproach, { passive: true });
  cleanups.push(() => {
    hostEl.removeEventListener("pointerenter", onApproach);
    hostEl.removeEventListener("pointermove", onApproach);
  });
  const onVisibilityChange = () => {
    if (disposed) return;
    syncHeartbeat();
    if (isVramSleepState()) reclaimStageVram();
    else if (!isWindowBlurred()) renderAllFrames(performance.now());
  };
  doc.addEventListener("visibilitychange", onVisibilityChange);
  cleanups.push(() => doc.removeEventListener("visibilitychange", onVisibilityChange));

  const syncPeekInteractivity = () => {
    const isPeek = yieldMode === "peek";
    if (isPeek) hostEl.setAttribute(PEEK_ATTR, "1");
    else hostEl.removeAttribute(PEEK_ATTR);
    if (isPeek) {
      for (const release of dragReleaseHooks) release();
    }
    for (const a of [actors.cat, actors.clawd]) {
      if (isPeek) a.el.setAttribute("aria-hidden", "true");
      else a.el.removeAttribute("aria-hidden");
      a.el.style.pointerEvents = isPeek ? "none" : "";
      applyActorTransform(a, performance.now());
    }
    miniGroupEl.style.pointerEvents = isPeek ? "none" : "";
    for (const mc of miniCrabs) mc.el.style.pointerEvents = isPeek ? "none" : "auto";
  };

  syncPeekInteractivity();
  renderAllFrames(performance.now());
  syncHeartbeat();

  return {
    setState(next) {
      const prevRight = popoverRightWidth;
      const prevCamp = camp;
      const prevStreaming = streaming;
      const prevStreamTier = streamTier;
      const prevHasError = hasError;
      const prevYield = yieldMode;
      const prevLeapOffset = leapOffsetY;
      const prevMiniPile = miniPileEnabled;
      const prevOrch = orchestrator;
      const prevReduced = reducedMotion;

      if (next.camp !== undefined) camp = next.camp === "claude" ? "claude" : "gemini";
      if (next.streaming !== undefined) streaming = next.streaming;
      if (next.streamTier !== undefined) streamTier = Number(next.streamTier || 2);
      if (next.hasError !== undefined) hasError = next.hasError;
      if (next.yieldMode !== undefined) yieldMode = next.yieldMode || "none";
      if (next.leapOffsetY !== undefined) leapOffsetY = Number(next.leapOffsetY || 0);
      if (next.popoverRightWidth !== undefined) {
        popoverRightWidth = Number(next.popoverRightWidth || 0);
      }
      if (next.miniPileEnabled !== undefined) miniPileEnabled = next.miniPileEnabled;
      if (next.orchestrator !== undefined) orchestrator = next.orchestrator;
      if (next.reducedMotion !== undefined) {
        reducedMotion = next.reducedMotion;
        if (reducedMotion && !prevReduced) freezeMotion();
        else if (!reducedMotion && prevReduced) lastActivityAt = performance.now();
      }

      const changed =
        camp !== prevCamp ||
        streaming !== prevStreaming ||
        streamTier !== prevStreamTier ||
        hasError !== prevHasError ||
        yieldMode !== prevYield ||
        leapOffsetY !== prevLeapOffset ||
        popoverRightWidth !== prevRight ||
        miniPileEnabled !== prevMiniPile ||
        orchestrator !== prevOrch ||
        reducedMotion !== prevReduced;
      if (!changed) return;

      if (camp !== prevCamp) {
        markActivity();
        campHandoff();
        if (performance.now() - lastHandoffAt > 50) {
          resetHomePositions(popoverRightWidth !== prevRight);
        }
      } else if (popoverRightWidth !== prevRight || miniPileEnabled !== prevMiniPile) {
        resetHomePositions(popoverRightWidth !== prevRight);
      }
      if (yieldMode !== prevYield || leapOffsetY !== prevLeapOffset) syncPeekInteractivity();
      if (reducedMotion !== prevReduced || streaming !== prevStreaming) syncHeartbeat();
      renderAllFrames(performance.now());
    },
    notify(event, payload = {}) {
      handleNotify(event, payload);
    },
    park(on = true) {
      if (disposed) return;
      parked = on;
      syncHeartbeat();
      if (parked) reclaimStageVram();
      else if (!isVramSleepState() && !isWindowBlurred()) renderAllFrames(performance.now());
    },
    resume() {
      if (disposed) return;
      parked = false;
      syncHeartbeat();
      if (!isVramSleepState() && !isWindowBlurred()) renderAllFrames(performance.now());
    },
    syncPowerState: syncPwr,
    dispose() {
      disposed = true;
      for (const e of [actors.cat, actors.clawd, ...miniCrabs]) {
        e.dragging = false;
        e.ballisticActive = false;
        e.rot = 0;
      }
      syncMascotDragRootAttr();
      doc.documentElement.removeAttribute(MASCOT_DRAG_ATTR);
      if (tickTimer !== null) {
        win.clearInterval(tickTimer);
        tickTimer = null;
      }
      currentTickMs = 0;
      if (dragRafId) {
        win.cancelAnimationFrame(dragRafId);
        dragRafId = 0;
      }
      dragRafPending = false;
      if (resizeRaf) {
        win.cancelAnimationFrame(resizeRaf);
        resizeRaf = 0;
      }
      win.clearTimeout(theaterTimer);
      for (const t of pendingTimers) win.clearTimeout(t);
      pendingTimers.clear();
      reducedMq?.removeEventListener("change", onReducedChange);
      pairCooldowns.clear();
      reclaimStageVram();
      for (const cv of [fxCanvas, habitatCanvas, actors.cat.canvas, actors.clawd.canvas]) {
        cv.width = 0;
        cv.height = 0;
        CTX_CACHE.delete(cv);
      }
      for (const mc of miniCrabs) CTX_CACHE.delete(mc.canvas);
      for (const fn of cleanups) fn();
      for (const node of [miniGroupEl, actors.cat.el, actors.clawd.el, fxCanvas, habitatCanvas]) {
        node.remove();
      }
    },
  };
}
