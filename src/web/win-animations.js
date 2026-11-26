/* Win animations, for the game page (index.html) and the demo page (animations.html). Each
   animation draws into overlay layers, `under` (above the squares, below the pieces) and `over`
   (above the pieces), and returns handles with cancel(), pause() and a currentTime in ms (Web
   Animations, or a CanvasAnimation), so a run still going can be stopped and ?t= on the demo page
   can hold one frame. playWin() sets up the layers and the context for a finished game. */
import { Chess } from "cm-chess/src/Chess.js";

/* The centre of a square, as fractions of the board's width and height. */
export function squareCentre(square, orientation) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const x = orientation === "white" ? file : 7 - file;
  const y = orientation === "white" ? 7 - rank : rank;
  return { x: (x + 0.5) / 8, y: (y + 0.5) / 8 };
}

export function element(className, parent) {
  const el = document.createElement("div");
  el.className = className;
  parent.append(el);
  return el;
}

/* A seeded random generator (mulberry32), so every run shows the same show. */
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* A canvas redrawn every frame by draw(ctx, size, seconds) until `duration` ms have passed (or
   for ever, with Infinity), with the same cancel / pause / currentTime as a Web Animation. draw
   must depend only on the time. `margin` (a share of the board) lets the canvas overhang the board
   on every side; draw still gets the board's size, with (0, 0) at the board's corner. */
class CanvasAnimation {
  constructor(parent, duration, draw, margin = 0) {
    this.canvas = document.createElement("canvas");
    if (margin) {
      this.canvas.style.position = "absolute";
      this.canvas.style.inset = `${-margin * 100}%`;
      this.canvas.style.width = this.canvas.style.height = `${(1 + 2 * margin) * 100}%`;
    }
    parent.append(this.canvas);
    this.duration = duration;
    this.draw = draw;
    this.margin = margin;
    this.start = performance.now();
    this.paused = false;
    this.time = 0;
    this.frame = requestAnimationFrame(() => this.tick());
  }
  tick() {
    if (this.paused) return;
    this.time = performance.now() - this.start;
    this.render();
    if (this.time < this.duration) this.frame = requestAnimationFrame(() => this.tick());
    else this.canvas.remove();
  }
  render() {
    const size = Math.round(this.canvas.clientWidth * devicePixelRatio);
    if (this.canvas.width !== size) { this.canvas.width = size; this.canvas.height = size; }
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const board = size / (1 + 2 * this.margin);
    ctx.translate(this.margin * board, this.margin * board);
    this.draw(ctx, board, Math.min(this.time, this.duration) / 1000);
  }
  pause() { this.paused = true; cancelAnimationFrame(this.frame); }
  get endTime() { return this.duration; }
  get currentTime() { return this.time; }
  set currentTime(ms) { this.time = ms; this.start = performance.now() - ms; this.render(); }
  cancel() { cancelAnimationFrame(this.frame); this.canvas.remove(); }
}

/* Fireworks. Positions are in board widths, y downwards. Each spark slows by air drag and falls,
   which has a closed form, so any moment of the show can be drawn without stepping through it:
   pos(t) = p0 + (v + g/k down)(1 - e^-kt)/k - (g/k) t down. */
const GRAVITY = 0.3;
const SHELL_KINDS = ["peony", "peony", "ring", "twoTone", "willow"];

function sparkAt(spark, origin, t) {
  const fade = (1 - Math.exp(-spark.drag * t)) / spark.drag;
  const fall = GRAVITY / spark.drag;
  return {
    x: origin.x + spark.vx * fade,
    y: origin.y + (spark.vy + fall) * fade - fall * t,
  };
}

function makeShell(random, launch) {
  const kind = SHELL_KINDS[Math.floor(random() * SHELL_KINDS.length)];
  const hue = Math.floor(random() * 360);
  const hue2 = (hue + 120 + Math.floor(random() * 120)) % 360;
  const speed = 0.5 + random() * 0.25;
  const count = kind === "ring" ? 56 : 100;
  const sparks = Array.from({ length: count }, (_, i) => {
    const angle = kind === "ring" ? (i / count) * 2 * Math.PI : random() * 2 * Math.PI;
    const v = kind === "ring" ? speed : speed * (0.55 + 0.45 * Math.sqrt(random()));
    const willow = kind === "willow";
    return {
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      drag: willow ? 1.1 : 1.7,
      life: (willow ? 2.8 : 1.5) + random() * 0.6,
      trail: willow ? 0.35 : 0.12,
      hue: willow ? 42 : kind === "twoTone" && i % 2 ? hue2 : hue,
      saturation: willow ? 70 : 100,
      twinkle: random(),
    };
  });
  const x0 = 0.15 + random() * 0.7;
  return {
    launch,
    rise: 0.9 + random() * 0.4,
    from: { x: x0, y: 1.02 },
    burst: { x: x0 + (random() - 0.5) * 0.15, y: 0.15 + random() * 0.3 },
    hue,
    sparks,
  };
}

/* About 10 s of launches, a few at a time, then a finale of eight. */
function makeShow(seed) {
  const random = seededRandom(seed);
  const launches = [];
  for (let t = 0.1; t < 9.2; t += 0.2 + random() * 0.4) launches.push(t);
  for (let i = 0; i < 8; i++) launches.push(9.4 + i * 0.1 + random() * 0.08);
  return launches.map((t) => makeShell(random, t));
}

function line(ctx, size, a, b, width, colour) {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width * size;
  ctx.beginPath();
  ctx.moveTo(a.x * size, a.y * size);
  ctx.lineTo(b.x * size, b.y * size);
  ctx.stroke();
}

function drawShell(ctx, size, shell, now) {
  const t = now - shell.launch;
  if (t < 0) return;
  if (t < shell.rise) {
    const rocketAt = (u) => {
      const up = 1 - (1 - Math.max(0, u)) ** 2;
      return {
        x: shell.from.x + (shell.burst.x - shell.from.x) * up,
        y: shell.from.y + (shell.burst.y - shell.from.y) * up,
      };
    };
    const u = t / shell.rise;
    line(ctx, size, rocketAt(u - 0.15), rocketAt(u), 0.005, "hsl(40 100% 75% / .9)");
    return;
  }
  const dt = t - shell.rise;
  if (dt < 0.18) {
    const glow = ctx.createRadialGradient(shell.burst.x * size, shell.burst.y * size, 0,
      shell.burst.x * size, shell.burst.y * size, 0.18 * size);
    glow.addColorStop(0, `hsl(${shell.hue} 100% 85% / ${0.7 * (1 - dt / 0.18)})`);
    glow.addColorStop(1, `hsl(${shell.hue} 100% 60% / 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);
  }
  shell.sparks.forEach((spark, i) => {
    if (dt > spark.life) return;
    const left = 1 - dt / spark.life;
    const flicker = left < 0.35 && Math.abs(Math.sin((now * 37 + i) * 12.9898) * 43758.5) % 1 > 0.3 ? 0.25 : 1;
    const alpha = left * left * flicker;
    const colour = `hsl(${spark.hue} ${spark.saturation}% ${55 + 35 * left}% / ${alpha})`;
    const head = sparkAt(spark, shell.burst, dt);
    line(ctx, size, sparkAt(spark, shell.burst, Math.max(0, dt - spark.trail)), head, 0.006, colour);
    line(ctx, size, head, head, 0.011, `hsl(${spark.hue} 100% 92% / ${alpha})`);
  });
}

/* Flames, in squares, round a king: each tongue rises from the king's foot, narrows, cools from
   white-yellow to red and dies, then starts again with its own period and phase, so the fire
   never ends and any moment can be drawn from the time alone. A few embers float higher. */
function makeFire(seed) {
  const random = seededRandom(seed);
  const tongues = Array.from({ length: 110 }, () => ({
    x: (random() - 0.5) * 0.9,
    life: 0.6 + random() * 0.55,
    phase: random(),
    sway: random() * 2 * Math.PI,
    swayBy: 0.05 + random() * 0.1,
    rise: 1.1 + random() * 1,
    size: 0.3 + random() * 0.22,
  }));
  const embers = Array.from({ length: 14 }, () => ({
    x: (random() - 0.5) * 0.7,
    life: 1.4 + random() * 1.2,
    phase: random(),
    sway: random() * 2 * Math.PI,
    swayBy: 0.15 + random() * 0.2,
    rise: 2 + random() * 1.2,
    size: 0.035 + random() * 0.03,
  }));
  return { tongues, embers };
}

/* A soft round blob of one colour, drawn once and stamped many times. */
function blob(colour) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, colour);
  g.addColorStop(1, "rgb(0 0 0 / 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return canvas;
}

const FLAME_BLOBS = [
  blob("rgb(255 245 190 / 1)"), blob("rgb(255 170 40 / 1)"), blob("rgb(230 60 10 / 1)"),
];
const EMBER_BLOB = blob("rgb(255 200 90 / 1)");

function drawFire(ctx, size, now, fire, king, front) {
  const square = size / 8;
  const foot = { x: king.x * size, y: king.y * size + 0.4 * square };
  const flicker = 0.85 + 0.1 * Math.sin(now * 13) + 0.05 * Math.sin(now * 31);
  ctx.globalCompositeOperation = "lighter";
  if (!front) {
    const glow = ctx.createRadialGradient(foot.x, foot.y - 0.3 * square, 0, foot.x, foot.y - 0.3 * square, 1.3 * square);
    glow.addColorStop(0, `rgb(255 90 0 / ${0.55 * flicker})`);
    glow.addColorStop(1, "rgb(120 0 0 / 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(foot.x - 1.5 * square, foot.y - 2 * square, 3 * square, 3 * square);
  }
  const stamp = (p, i, sprite, strength) => {
    const cycles = now / p.life + p.phase;
    const age = cycles % 1;
    const nudge = (seededRandom(i * 7919 + Math.floor(cycles) * 104729)() - 0.5) * 0.2;
    const x = foot.x + ((p.x + nudge) * (1 - 0.6 * age) + Math.sin(now * 5 + p.sway) * p.swayBy * age) * square;
    const y = foot.y - age * p.rise * square;
    const r = p.size * square * (1 - 0.6 * age);
    ctx.globalAlpha = Math.max(0, strength * (1 - age) ** 1.2);
    ctx.drawImage(sprite(age), x - r, y - r, 2 * r, 2 * r);
  };
  fire.tongues.forEach((p, i) => {
    if (front && i % 3) return;
    // In front, only the cooler orange and red, faint, so the king still shows through.
    const sprite = front
      ? (age) => FLAME_BLOBS[age < 0.4 ? 1 : 2]
      : (age) => FLAME_BLOBS[age < 0.2 ? 0 : age < 0.5 ? 1 : 2];
    stamp(p, i, sprite, front ? 0.3 : 0.85);
  });
  if (!front) fire.embers.forEach((p, i) => stamp(p, 1000 + i, () => EMBER_BLOB, 1));
  ctx.globalAlpha = 1;
}

/* Coronation: the winning king rises to a throne at the board's centre and grows, its pieces
   hop in to form a court in an arc below it, a crown drops onto its head with a flash, gold
   sparks and rays, the court bows in a wave, the king spins, glitter falls, then the board
   returns. The pieces are clones, so the board's own are only hidden (and the loser's greyed),
   by animations that cancel() undoes. Positions are in squares from the board's top-left. */
const CORONATION_MS = 8000;
const CROWN_DROP = { delay: 1900, duration: 1100, land: 0.75 };
const CROWN_LANDS = CROWN_DROP.delay + CROWN_DROP.duration * CROWN_DROP.land;
const THRONE = { x: 3.5, y: 3.1 };   // the king's centre, grown to MONARCH_SCALE
const MONARCH_SCALE = 2;
const CROWN_IN_KING = { top: -0.08, height: 0.44 };   // in the king's square (see animations.css)
const COURT_ORDER = { queen: 0, rook: 1, bishop: 2, knight: 3, pawn: 4 };
const CROWN_SVG = `
<svg viewBox="-8 -8 116 82" aria-hidden="true">
  <defs><linearGradient id="crown-gold" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff6b0"/><stop offset=".45" stop-color="#f5c400"/>
    <stop offset="1" stop-color="#a86a00"/></linearGradient></defs>
  <path d="M6 56 L0 14 L26 36 L50 2 L74 36 L100 14 L94 56 Z" fill="url(#crown-gold)"
    stroke="#6b4300" stroke-width="3" stroke-linejoin="round"/>
  <rect x="4" y="54" width="92" height="14" rx="3" fill="url(#crown-gold)" stroke="#6b4300" stroke-width="3"/>
  <circle cx="0" cy="12" r="6" fill="#e0203a" stroke="#6b4300" stroke-width="2"/>
  <circle cx="50" cy="0" r="7" fill="#2a6cf0" stroke="#6b4300" stroke-width="2"/>
  <circle cx="100" cy="12" r="6" fill="#e0203a" stroke="#6b4300" stroke-width="2"/>
  <circle cx="28" cy="61" r="4" fill="#18b060"/><circle cx="50" cy="61" r="4.5" fill="#e0203a"/>
  <circle cx="72" cy="61" r="4" fill="#18b060"/>
</svg>`;

/* A square's top-left corner, in squares from the board's top-left. */
function squareCorner(square, orientation) {
  const c = squareCentre(square, orientation);
  return { x: c.x * 8 - 0.5, y: c.y * 8 - 0.5 };
}

/* The translate for an offset in squares, for an element one square wide. */
function translateBy(dx, dy) {
  return `${dx * 100}% ${dy * 100}%`;
}

/* Keyframes for a hop by (dx, dy) squares, `lift` squares high at its peak. */
function hopFrames(dx, dy, lift, steps = 12) {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const u = i / steps;
    const e = u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) ** 2;
    return { translate: translateBy(dx * e, dy * e - lift * 4 * e * (1 - e)) };
  });
}

/* Keyframes arriving from an offset of (dx, dy) squares, `lift` squares high at the peak. */
function arriveFrames(dx, dy, lift, steps = 12) {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const u = i / steps;
    const e = u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) ** 2;
    return { translate: translateBy(dx * (1 - e), dy * (1 - e) - lift * 4 * e * (1 - e)) };
  });
}

/* Each courtier's place, as centres in squares: up to seven on an arc below the throne, the
   rest on a wider arc beyond, kept on the board. */
function courtPlaces(count) {
  const inner = Math.min(count, 7);
  return Array.from({ length: count }, (_, i) => {
    const outer = i >= inner;
    const k = outer ? i - inner : i;
    const n = outer ? count - inner : inner;
    const [from, to] = outer ? [170, 10] : [160, 20];
    const degrees = n === 1 ? 90 : from + ((to - from) * k) / (n - 1);
    const radius = outer ? 3.3 : 2.3;
    const angle = (degrees * Math.PI) / 180;
    const clamp = (v) => Math.min(7.5, Math.max(0.5, v));
    return {
      x: clamp(THRONE.x + radius * Math.cos(angle)),
      y: clamp(THRONE.y + radius * Math.sin(angle)),
    };
  });
}

/* The court: the winner's pieces but the king, the strongest on the inner arc, and each arc
   filled left to right in the order the pieces stand, so their hops seldom cross. */
function seatCourt(courtiers, orientation) {
  const byRank = courtiers
    .map((el) => ({ el, from: squareCorner(el.cgKey, orientation), role: roleOf(el) }))
    .sort((a, b) => COURT_ORDER[a.role] - COURT_ORDER[b.role]);
  const inner = byRank.slice(0, 7).sort((a, b) => a.from.x - b.from.x);
  const outer = byRank.slice(7).sort((a, b) => a.from.x - b.from.x);
  const places = courtPlaces(courtiers.length);
  return [...inner, ...outer].map((c, i) => ({ ...c, place: places[i] }));
}

function roleOf(pieceEl) {
  return Object.keys(COURT_ORDER).find((role) => pieceEl.classList.contains(role)) ?? "king";
}

/* A four-pointed sparkle of radius r. */
function sparkle(ctx, x, y, r, angle, colour) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = colour;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const reach = i % 2 ? r * 0.28 : r;
    ctx.lineTo(Math.cos((i * Math.PI) / 4) * reach, Math.sin((i * Math.PI) / 4) * reach);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/* Gold sparks bursting from the crown as it lands, then glitter drifting down until the end. */
function makeRegalia(seed, crown) {
  const random = seededRandom(seed);
  const sparks = Array.from({ length: 90 }, () => {
    const angle = random() * 2 * Math.PI;
    const v = 0.2 + random() * 0.45;
    return {
      vx: Math.cos(angle) * v, vy: Math.sin(angle) * v - 0.12, drag: 1.6,
      life: 0.9 + random() * 0.9, hue: 38 + random() * 18, spin: random() * 6,
    };
  });
  const glitter = Array.from({ length: 160 }, () => ({
    start: CROWN_LANDS / 1000 + 0.2 + random() * 3.8,
    x: random(), fall: 0.1 + random() * 0.14, sway: random() * 2 * Math.PI,
    swayBy: 0.01 + random() * 0.025, size: 0.006 + random() * 0.009,
    hue: 36 + random() * 22, spin: random() * 6,
  }));
  return { crown, sparks, glitter };
}

function drawRegalia(ctx, size, now, { crown, sparks, glitter }) {
  const fadeOut = Math.min(1, Math.max(0, (CORONATION_MS / 1000 - now) / 0.8));
  ctx.globalCompositeOperation = "lighter";
  const dt = now - CROWN_LANDS / 1000;
  if (dt >= 0) sparks.forEach((spark) => {
    if (dt > spark.life) return;
    const left = 1 - dt / spark.life;
    const p = sparkAt(spark, crown, dt);
    sparkle(ctx, p.x * size, p.y * size, (0.008 + 0.012 * left) * size, spark.spin + dt * 4,
      `hsl(${spark.hue} 100% ${60 + 30 * left}% / ${left})`);
  });
  glitter.forEach((g) => {
    const t = now - g.start;
    const y = -0.03 + g.fall * t;
    if (t < 0 || y > 1.04) return;
    const x = g.x + Math.sin(now * 2 + g.sway) * g.swayBy;
    const shine = 0.55 + 0.45 * Math.sin(now * 9 + g.spin * 5);
    sparkle(ctx, x * size, y * size, g.size * size * (0.6 + 0.4 * shine), g.spin + now * 2,
      `hsl(${g.hue} 100% ${55 + 35 * shine}% / ${shine * fadeOut})`);
  });
}

/* Exploding board: the mated king blows up. The board breaks into its 64 squares, each carrying
   its piece, which fly off in a shock wave, tumbling and falling; the winning king floats alone
   over a starry void; then time runs backwards and the board reassembles. Positions are in
   squares from the board's top-left, times in ms. */
const EXPLODE_MS = 8000;
const BLAST_AT = 700;        // the mated king bursts
const FLIGHT = 1600;         // each square's flight, and its return
const REWIND_AT = 5200;      // the farthest square starts back
const SHOCK_DELAY = 45;      // per square of distance from the blast
const TILE_GRAVITY = 16;     // squares per s^2

/* A square's flight: away from the blast, faster the nearer it was, kicked upwards, tumbling
   about a random axis; it leaves as the shock wave reaches it and comes back in reverse order. */
function tileFlight(col, row, epicentre, maxDist, random) {
  const dx = col + 0.5 - epicentre.x, dy = row + 0.5 - epicentre.y;
  const dist = Math.hypot(dx, dy);
  const dir = dist === 0 ? { x: 0, y: -1 } : { x: dx / dist, y: dy / dist };
  const speed = 8 / (1 + 0.6 * dist) + 1.5 + random() * 1.5;
  return {
    vx: dir.x * speed,
    vy: dir.y * speed - 3 - random() * 2,
    axis: [random() * 2 - 1, random() * 2 - 1, (random() * 2 - 1) * 0.3].map((a) => a.toFixed(3)).join(" "),
    spin: (300 + random() * 600) * (random() < 0.5 ? -1 : 1),
    leave: BLAST_AT + dist * SHOCK_DELAY,
    back: REWIND_AT + (maxDist - dist) * SHOCK_DELAY,
  };
}

/* The whole run's keyframes for one square: home, the flight sampled in time (so the curve is
   the physics, not an easing), out of sight, the flight backwards, home. */
function flightFrames(f, off, steps = 16) {
  const at = (u) => {
    const t = (u * FLIGHT) / 1000;
    return {
      translate: translateBy(f.vx * t, f.vy * t + 0.5 * TILE_GRAVITY * t * t),
      rotate: `${f.axis} ${f.spin * u}deg`,
      scale: 1 + 0.4 * Math.sin(Math.PI * u),
      opacity: u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4,
    };
  };
  const out = Array.from({ length: steps + 1 }, (_, i) =>
    ({ ...at(i / steps), offset: off(f.leave + (FLIGHT * i) / steps) }));
  const back = Array.from({ length: steps + 1 }, (_, i) =>
    ({ ...at(1 - i / steps), offset: off(f.back + (FLIGHT * i) / steps) }));
  return [{ ...at(0), offset: 0 }, ...out, ...back, { ...at(0), offset: 1 }];
}

/* Stars for the void behind the board, each twinkling at its own rate. */
function makeStars(random) {
  return Array.from({ length: 110 }, () => ({
    x: random(), y: random(), r: 0.0015 + random() * 0.003,
    rate: 1 + random() * 3, phase: random() * 2 * Math.PI, hue: 200 + random() * 60,
  }));
}

function drawVoid(ctx, size, now, stars) {
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, 0.75 * size);
  g.addColorStop(0, "rgb(30 18 60)");
  g.addColorStop(1, "rgb(4 4 14)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  stars.forEach((s) => {
    const shine = 0.5 + 0.5 * Math.sin(now * s.rate + s.phase);
    ctx.fillStyle = `hsl(${s.hue} 80% 85% / ${0.3 + 0.7 * shine})`;
    ctx.beginPath();
    ctx.arc(s.x * size, s.y * size, s.r * size * (0.7 + 0.5 * shine), 0, 2 * Math.PI);
    ctx.fill();
  });
}

/* The blast's sparks: hot, fast and short-lived, flung from the mated king's square. */
function makeBlast(random, origin) {
  const sparks = Array.from({ length: 140 }, () => {
    const angle = random() * 2 * Math.PI;
    const v = 0.35 + random() * 0.75;
    return {
      vx: Math.cos(angle) * v, vy: Math.sin(angle) * v - 0.1, drag: 1.4,
      life: 0.5 + random() * 0.9, hue: 10 + random() * 40, trail: 0.08,
    };
  });
  return { origin, sparks };
}

function drawBlast(ctx, size, now, { origin, sparks }) {
  const dt = now - BLAST_AT / 1000;
  if (dt < 0) return;
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  sparks.forEach((spark) => {
    if (dt > spark.life) return;
    const left = 1 - dt / spark.life;
    const head = sparkAt(spark, origin, dt);
    const tail = sparkAt(spark, origin, Math.max(0, dt - spark.trail));
    line(ctx, size, tail, head, 0.006, `hsl(${spark.hue} 100% ${50 + 40 * left}% / ${left})`);
  });
}

/* Replay: the whole game flips past on the board, unhurried at first, a blur through the middle,
   slowing again towards the end; every capture flashes. Then a breath, the mating move glides in
   slowly, the mated king's square bursts and the board shakes. A bar along the bottom fills as
   the game goes and a label names each move. The board itself shows the game (the board is
   driven from the time, so ?t= works), and restoreBoard() puts the board back at the end. The
   game page passes its own game as `replay`; the demo page uses REPLAY_GAME. */
// VBKN's longest 5+0 win by mate in Building Habits: a Sicilian, a long king walk, two queens.
const REPLAY_GAME = {
  white: "VBKN", whiteElo: 1389, black: "MisterChance", blackElo: 1441, date: "2021",
  result: "1-0",
  moves: `e4 c5 Nf3 Nc6 c3 g6 d4 cxd4 cxd4 Bg7 Nc3 e6 d5 exd5 exd5 Ne5 Nxe5 Bxe5 Bc4 d6 O-O Ne7
    Re1 O-O h3 a6 Be3 b5 Bb3 Bb7 Qd2 Nf5 Bg5 Qc7 Rac1 Qb6 Ne4 Qd4 Qxd4 Nxd4 Rc7 Rab8 Be7 Rfe8
    Kf1 Nxb3 axb3 Bxd5 Nxd6 Bxd6 Bxd6 Rxe1+ Kxe1 Rd8 Be7 Re8 Kd2 Bxb3 h4 Be6 g3 Rc8 Rxc8+ Bxc8
    Kc3 f5 Kb4 Kf7 Bg5 Ke6 Kc5 Kd7 Kb6 b4 Kc5 b3 Kb4 Ke6 Kxb3 Kd5 Kb4 Kc6 Be3 Bb7 Kc4 h5 Kd4
    Kb5 Bg5 Ka4 f4 Kb3 Ke5 Kxb2 Kf6 a5 Kxg6 a4 Kxh5 a3 Kg6 a2 Bf6+ Kb1 h5 a1=Q Bxa1 Kxa1 h6
    Bc8 h7 Be6 h8=Q+ Kb1 Qe5 Kc2 Kf6 Kd3 Qxe6 Kd2 Qxf5 Kc3 Qe5+ Kc4 f5 Kd3 Kg6 Kd2 f6 Kd3 Qe7
    Kc4 f7 Kb5 f8=Q Kc4 Qfd8 Kc3 Qec7+ Kb3 Qdb8+ Ka3 Qca7#`,
};
const REPLAY = {
  intro: 900,       // the start position and the title, before the first move
  slow: 260,        // ms per move at the start and the end
  fast: 22,         // ms per move through the middle
  breath: 800,      // the pause before the mating move
  mateGlide: 800,   // the mating move's own animation
  hold: 2800,       // the final position, before the demo comes back
};
const REPLAY_LABEL_GAP = 0.06; // the move label's centre, below the board, in board widths

/* When each move is played, in ms: an ease from slow to fast and back, then the mate. */
function replayTimes(count) {
  const times = [];
  let t = REPLAY.intro;
  for (let i = 0; i < count - 1; i++) {
    times.push(t);
    const u = i / Math.max(1, count - 2);
    t += REPLAY.fast + (REPLAY.slow - REPLAY.fast) * (1 - Math.sin(Math.PI * u)) ** 4;
  }
  times.push(t + REPLAY.breath);
  return times;
}

/* The square of `colour`'s king ("w" or "b") in a FEN. */
function kingSquareIn(fen, colour) {
  const rows = fen.split(" ")[0].split("/");
  const king = colour === "w" ? "K" : "k";
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of rows[r]) {
      if (ch === king) return `${String.fromCharCode(97 + file)}${8 - r}`;
      file += /\d/.test(ch) ? Number(ch) : 1;
    }
  }
  return null;
}

/* A rounded label centred at (x, y), in canvas pixels. */
function pill(ctx, size, text, x, y, alpha) {
  if (alpha <= 0) return;
  ctx.font = `600 ${0.042 * size}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 0.05 * size, h = 0.07 * size;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "rgb(0 0 0 / .62)";
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + 0.002 * size);
  ctx.globalAlpha = 1;
}

function moveLabel(move, index) {
  const number = Math.floor(index / 2) + 1;
  return index % 2 === 0 ? `${number}. ${move.san}` : `${number}… ${move.san}`;
}

/* Tipped king: the mated king wobbles, harder and harder, and topples over with a thud and a puff
   of dust that makes its own side flinch; then it rolls off the edge of the board and falls, and
   the winning king hops for joy. Positions are in squares from the board's top-left, times in ms. */
const TIP_MS = 4900;
const TIP = { wobbles: 150, leans: 1300, lands: 1700, rolls: 2250, edge: 2850, gone: 3400, cheer: 3400 };
const TIP_WOBBLE_MS = 130;
const TWINKLE_MS = 700;

/* The mated king's rotation while it wobbles and falls, `dir` 1 to fall right, -1 left. */
function tipFrames(dir) {
  const end = TIP.lands + 450;
  const at = (ms) => ms / end;
  const wobble = Array.from({ length: 8 }, (_, i) => ({
    rotate: `${(i % 2 ? 1 : -1) * dir * (3 + 1.8 * i)}deg`, offset: at(TIP.wobbles + TIP_WOBBLE_MS * (i + 1)), easing: "ease-in-out",
  }));
  return [
    { rotate: "0deg", easing: "ease-in-out" },
    { rotate: "0deg", offset: at(TIP.wobbles), easing: "ease-in-out" },
    ...wobble.filter((f) => f.offset < at(TIP.leans)),
    { rotate: `${-8 * dir}deg`, offset: at(TIP.leans), easing: "cubic-bezier(.55, 0, 1, .6)" },
    { rotate: `${90 * dir}deg`, offset: at(TIP.lands), easing: "ease-out" },
    { rotate: `${78 * dir}deg`, offset: at(TIP.lands + 150), easing: "ease-in" },
    { rotate: `${90 * dir}deg`, offset: at(TIP.lands + 300) },
    { rotate: `${90 * dir}deg` },
  ];
}

/* Dust from where the king hits the board, and gold sparkles round the winner when it cheers. */
function makeDust(seed, impact, dir, winner) {
  const random = seededRandom(seed);
  const dust = Array.from({ length: 46 }, () => {
    const along = random();
    return {
      x: impact.x + dir * along * 0.9, y: impact.y - 0.05 + random() * 0.1,
      vx: (random() - 0.5) * 1.6 + dir * 0.3, vy: -0.2 - random() * 0.7,
      life: 0.6 + random() * 0.7, size: 0.08 + random() * 0.12, shade: 150 + random() * 60,
    };
  });
  const twinkles = Array.from({ length: 18 }, () => ({
    x: winner.x + 0.5 + (random() - 0.5) * 1.8, y: winner.y + 0.5 + (random() - 0.5) * 1.8,
    start: TIP.cheer + random() * (TIP_MS - TIP.cheer - TWINKLE_MS), spin: random() * 6,
  }));
  return { dust, twinkles };
}

function drawDust(ctx, size, now, { dust, twinkles }) {
  const sq = size / 8;
  const dt = now - TIP.lands / 1000;
  if (dt >= 0) dust.forEach((d) => {
    if (dt > d.life) return;
    const k = dt / d.life;
    const drag = (1 - Math.exp(-3 * dt)) / 3;
    const x = (d.x + d.vx * drag) * sq, y = (d.y + d.vy * drag) * sq;
    ctx.fillStyle = `rgb(${d.shade} ${d.shade - 12} ${d.shade - 30} / ${0.55 * (1 - k)})`;
    ctx.beginPath();
    ctx.arc(x, y, (d.size + 0.35 * k * d.size * 4) * sq, 0, 2 * Math.PI);
    ctx.fill();
  });
  ctx.globalCompositeOperation = "lighter";
  twinkles.forEach((tw) => {
    const age = now * 1000 - tw.start;
    if (age < 0 || age > TWINKLE_MS) return;
    const k = Math.sin((Math.PI * age) / TWINKLE_MS);
    sparkle(ctx, tw.x * sq, tw.y * sq, 0.22 * sq * k, tw.spin + age / 300, `hsl(48 100% 75% / ${k})`);
  });
  ctx.globalCompositeOperation = "source-over";
}

/* Conga line: the winning king leads and the rest of its side hop in behind, then the line snakes
   round the board to "one, two, three, kick!", swaying on the beat and kicking out on the fourth,
   alternate sides each bar, lighting the squares it dances over like a disco floor. Then everyone
   hops home. Positions are in squares from the board's top-left (centres unless "corner"), times
   in ms. */
const CONGA_MS = 10500;
const CONGA_BEAT = 400;
const CONGA_GAP = 0.95;          // between dancers, along the path
const CONGA_SPEED = 2.2;         // squares per second
const CONGA_JOIN = 600;          // each dancer's hop into the line
const CONGA_HOME_AT = CONGA_MS - 1700;
const CONGA_SAMPLE = 40;         // ms between keyframes along the path
const DISCO_GLOW = 1300;         // how long a square stays lit

/* The dance floor's path: a rounded square with a wobble, measured so points can be found by
   distance along it. */
function congaPath() {
  const n = 720;
  const curve = (x) => Math.sign(x) * Math.abs(x) ** 0.55;
  const points = Array.from({ length: n + 1 }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    const r = 2.75 + 0.3 * Math.sin(6 * a);
    return { x: 3.5 + r * curve(Math.cos(a)), y: 3.5 + r * curve(Math.sin(a)) };
  });
  const lengths = [0];
  for (let i = 1; i <= n; i++)
    lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  const total = lengths[n];
  const at = (s) => {
    const d = ((s % total) + total) % total;
    let lo = 0, hi = n;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (lengths[mid] <= d) lo = mid; else hi = mid; }
    const k = (d - lengths[lo]) / (lengths[hi] - lengths[lo] || 1);
    return { x: points[lo].x + (points[hi].x - points[lo].x) * k, y: points[lo].y + (points[hi].y - points[lo].y) * k };
  };
  const nearest = (p) => lengths[points.reduce((best, q, i) =>
    (Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(points[best].x - p.x, points[best].y - p.y) ? i : best), 0)];
  return { at, nearest, total };
}

/* How high a dancer is lifted `since` ms into the dance: a bob on each beat, a hop on the kick. */
function congaLift(since) {
  const beat = Math.floor(since / CONGA_BEAT) % 4;
  const phase = (since % CONGA_BEAT) / CONGA_BEAT;
  return (beat === 3 ? 0.3 : 0.1) * Math.sin(Math.PI * phase);
}

/* The sway for two bars, from the dancer's point of view: hips side to side on beats one to
   three, a kick out on four, right in the first bar, left in the second. */
function congaSway() {
  const bar = (side) => [
    { rotate: `${6 * side}deg` }, { rotate: "0deg" }, { rotate: `${-6 * side}deg` }, { rotate: "0deg" },
    { rotate: `${6 * side}deg` }, { rotate: "0deg" }, { rotate: `${26 * side}deg` }, { rotate: "0deg" },
  ];
  return [{ rotate: "0deg" }, ...bar(1), ...bar(-1)].map((f, i) => ({ ...f, offset: i / 16 }));
}

/* The squares lit by each dancer: when it reached each, and a hue. */
function discoVisits(tracks) {
  const visits = [];
  tracks.forEach((track, d) => {
    let last = null;
    track.forEach(({ at, x, y }) => {
      const key = `${Math.floor(x)},${Math.floor(y)}`;
      if (key === last) return;
      last = key;
      visits.push({ at, col: Math.floor(x), row: Math.floor(y), hue: (at / 7 + d * 50) % 360, leader: d === 0 });
    });
  });
  return visits;
}

function drawDisco(ctx, size, now, visits) {
  const t = now * 1000;
  const sq = size / 8;
  const fade = Math.min(1, Math.max(0, (CONGA_MS - t) / 600));
  visits.forEach((v) => {
    const age = t - v.at;
    if (age < 0 || age > DISCO_GLOW || v.col < 0 || v.col > 7 || v.row < 0 || v.row > 7) return;
    const k = age / DISCO_GLOW;
    const alpha = (v.leader ? 0.75 : 0.45) * (1 - k) * Math.min(1, age / 80) * fade;
    const g = ctx.createRadialGradient((v.col + 0.5) * sq, (v.row + 0.5) * sq, 0, (v.col + 0.5) * sq, (v.row + 0.5) * sq, 0.75 * sq);
    g.addColorStop(0, `hsl(${v.hue} 100% 70% / ${alpha})`);
    g.addColorStop(1, `hsl(${v.hue} 100% 50% / ${alpha * 0.55})`);
    ctx.fillStyle = g;
    ctx.fillRect(v.col * sq + 1, v.row * sq + 1, sq - 2, sq - 2);
  });
}

export const ANIMATIONS = {
  replay: {
    name: "Replay",
    play({ over }, { cg, orientation, restoreBoard, boardEl, replay = REPLAY_GAME }) {
      const start = replay.startFen ? { fen: replay.startFen, gameVariant: replay.variant } : undefined;
      const game = new Chess(start);
      const startFen = game.fen();
      const moves = replay.moves.trim().split(/\s+/).map((san) => {
        const move = game.move(san);
        if (!move) throw new Error(`replay: illegal move ${san}`);
        return move;
      });
      const times = replayTimes(moves.length);
      const mateAt = times[times.length - 1];
      const mateLands = mateAt + REPLAY.mateGlide;
      const ms = mateLands + REPLAY.hold;
      const last = moves[moves.length - 1];
      const mated = squareCentre(kingSquareIn(last.fen, last.color === "w" ? "b" : "w"), orientation);
      const winnerName = last.color === "w" ? replay.white : replay.black;
      const rated = (name, elo) => (elo ? `${name} (${elo})` : name);
      const title = `${rated(replay.white, replay.whiteElo)} – ${rated(replay.black, replay.blackElo)}, ${replay.date}`;
      let shown = -1;

      const showPly = (ply) => {
        if (ply === shown) return;
        const step = ply === shown + 1;
        const move = moves[ply - 1];
        const gap = ply === moves.length ? REPLAY.mateGlide
          : ply === 0 ? 0 : Math.min(160, 0.9 * (times[ply] - times[ply - 1]));
        cg.set({
          animation: { enabled: step && gap > 15, duration: gap },
          fen: move ? move.fen : startFen,
          lastMove: move ? [move.from, move.to] : undefined,
          turnColor: ply % 2 === 0 ? "white" : "black",
          check: Boolean(move && move.inCheck),
        });
        shown = ply;
      };

      const draw = (ctx, size, now) => {
        const t = now * 1000;
        if (t >= ms) { restoreBoard(); return; }
        showPly(times.filter((at) => at <= t).length);
        const square = size / 8;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, size, size);
        ctx.clip();

        ctx.globalCompositeOperation = "lighter";
        moves.forEach((move, i) => {
          const age = t - times[i];
          if (!move.captured || age < 0 || age > 380 || i === moves.length - 1) return;
          const c = squareCentre(move.to, orientation);
          const k = age / 380;
          const g = ctx.createRadialGradient(c.x * size, c.y * size, 0, c.x * size, c.y * size, (0.35 + 0.6 * k) * square);
          g.addColorStop(0, `rgb(255 255 240 / ${0.95 * (1 - k)})`);
          g.addColorStop(0.5, `rgb(255 170 40 / ${0.6 * (1 - k)})`);
          g.addColorStop(1, "rgb(255 80 0 / 0)");
          ctx.fillStyle = g;
          ctx.fillRect(c.x * size - square, c.y * size - square, 2 * square, 2 * square);
        });
        const sinceMate = t - mateLands;
        if (sinceMate >= 0) {
          const k = Math.min(1, sinceMate / 900);
          const x = mated.x * size, y = mated.y * size;
          const g = ctx.createRadialGradient(x, y, 0, x, y, (0.5 + 3 * k) * square);
          g.addColorStop(0, `rgb(255 250 220 / ${0.9 * (1 - k)})`);
          g.addColorStop(0.6, `rgb(255 120 30 / ${0.5 * (1 - k)})`);
          g.addColorStop(1, "rgb(200 0 0 / 0)");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, size, size);
          ctx.strokeStyle = `rgb(255 220 150 / ${1 - k})`;
          ctx.lineWidth = 0.012 * size;
          ctx.beginPath();
          ctx.arc(x, y, (0.3 + 3.2 * k) * square, 0, 2 * Math.PI);
          ctx.stroke();
        }

        ctx.globalCompositeOperation = "source-over";
        const done = Math.min(1, shown / moves.length);
        const bar = 0.014 * size;
        ctx.fillStyle = "rgb(0 0 0 / .45)";
        ctx.fillRect(0, size - bar, size, bar);
        ctx.fillStyle = "hsl(45 100% 58%)";
        ctx.fillRect(0, size - bar, done * size, bar);
        ctx.fillStyle = "rgb(255 90 40 / .9)";
        moves.forEach((move, i) => {
          if (move.captured && i < shown) ctx.fillRect(((i + 0.5) / moves.length) * size - 1, size - bar, 2, bar);
        });
        ctx.restore();

        const labelY = size * (1 + REPLAY_LABEL_GAP);
        const fadeIn = Math.min(1, t / 250);
        if (t < REPLAY.intro + 600) pill(ctx, size, title, size / 2, labelY, fadeIn);
        else if (sinceMate < 0) pill(ctx, size, moveLabel(moves[Math.max(0, shown - 1)], Math.max(0, shown - 1)), size / 2, labelY, 1);
        else pill(ctx, size, `${last.san}  Checkmate · ${winnerName} wins ${replay.result}`,
          size / 2, labelY, Math.min(1, sinceMate / 300));
      };

      over.classList.add("unclipped");
      const canvas = new CanvasAnimation(over, ms, draw, 2 * REPLAY_LABEL_GAP);
      canvas.canvas.classList.add("on-top");
      return [
        {
          cancel() { canvas.cancel(); restoreBoard(); },
          pause() { canvas.pause(); },
          get endTime() { return ms; },
          get currentTime() { return canvas.currentTime; },
          set currentTime(value) { canvas.currentTime = value; },
        },
        boardEl.animate([
          { translate: "0 0" }, { translate: "-1.5% 1%" }, { translate: "1.2% -1.2%" },
          { translate: "-0.8% -0.5%" }, { translate: "0.5% 0.8%" }, { translate: "0 0" },
        ], { duration: 380, delay: mateLands, easing: "linear" }),
      ];
    },
  },
  tipped: {
    name: "Tipped king",
    play({ over }, { pieces, winnerKing, loserKing, orientation, boardEl }) {
      const ms = TIP_MS;
      over.classList.add("unclipped");
      const loserEl = pieces.find((el) => el.cgKey === loserKing);
      const winnerEl = pieces.find((el) => el.cgKey === winnerKing);
      const loser = loserEl.classList.contains("white") ? "white" : "black";
      const flinchers = pieces.filter((el) => el !== loserEl && el.classList.contains(loser));
      const corner = squareCorner(loserKing, orientation);
      const dir = corner.x >= 3.5 ? 1 : -1;
      const toEdge = dir > 0 ? 8 - corner.x : corner.x + 1;

      const king = document.createElement("piece");
      king.className = `king ${loser} tipped-king`;
      king.style.left = `${(corner.x / 8) * 100}%`;
      king.style.top = `${(corner.y / 8) * 100}%`;
      king.style.transformOrigin = dir > 0 ? "80% 90%" : "20% 90%";
      over.append(king);

      const pivot = { x: corner.x + (dir > 0 ? 0.8 : 0.2), y: corner.y + 0.9 };
      const sparks = makeDust(1066, pivot, dir, squareCorner(winnerKing, orientation));
      const canvas = new CanvasAnimation(over, ms, (ctx, size, now) => drawDust(ctx, size, now, sparks));
      canvas.canvas.classList.add("on-top");

      const roll = TIP.gone - TIP.rolls;
      const edgeAt = (TIP.edge - TIP.rolls) / roll;
      // The roll turns about the king's centre rather than the corner it fell about; lying at
      // 90° about that corner is the same as lying at 90° about the centre, moved by `lying`.
      const lying = { x: 0.7 * dir, y: 0.1 };
      const rollAt = (x, y) => translateBy(lying.x + x, lying.y + y);
      return [
        loserEl.animate([{ opacity: 0 }, { opacity: 0, offset: 0.95 }, { opacity: 1 }], { duration: ms }),
        king.animate(tipFrames(dir), { duration: TIP.lands + 450, fill: "forwards" }),
        king.animate([
          { transformOrigin: "50% 50%", rotate: `${90 * dir}deg`, translate: rollAt(0, 0), opacity: 1, easing: "ease-in" },
          { transformOrigin: "50% 50%", rotate: `${(90 + 360) * dir}deg`, translate: rollAt(dir * toEdge, 0), offset: edgeAt, easing: "ease-in" },
          { transformOrigin: "50% 50%", rotate: `${(90 + 540) * dir}deg`, translate: rollAt(dir * (toEdge + 0.8), 4), opacity: 0 },
        ], { duration: roll, delay: TIP.rolls, fill: "forwards" }),
        ...flinchers.map((el, i) => el.animate([
          { translate: "0 0" }, { translate: "0 -14%", offset: 0.35 }, { translate: "0 0" },
        ], { duration: 280, delay: TIP.lands + 40 + i * 25, easing: "ease-out" })),
        boardEl.animate([
          { translate: "0 0" }, { translate: "0 1%" }, { translate: "0 -.6%" }, { translate: "0 .3%" }, { translate: "0 0" },
        ], { duration: 260, delay: TIP.lands, easing: "linear" }),
        winnerEl.animate([
          { translate: "0 0", easing: "ease-out" }, { translate: "0 -35%", offset: 0.22, easing: "ease-in" },
          { translate: "0 0", offset: 0.45, easing: "ease-out" }, { translate: "0 -35%", offset: 0.67, easing: "ease-in" },
          { translate: "0 0" },
        ], { duration: 1100, delay: TIP.cheer }),
        winnerEl.animate([
          { filter: "drop-shadow(0 0 0 hsl(48 100% 60% / 0))" },
          { filter: "drop-shadow(0 0 .6vmin hsl(48 100% 60% / .95))", offset: 0.2 },
          { filter: "drop-shadow(0 0 .6vmin hsl(48 100% 60% / .95))", offset: 0.8 },
          { filter: "drop-shadow(0 0 0 hsl(48 100% 60% / 0))" },
        ], { duration: ms - TIP.cheer, delay: TIP.cheer }),
        canvas,
      ];
    },
  },
  conga: {
    name: "Conga line",
    play({ under, over }, { pieces, winnerKing, orientation }) {
      const ms = CONGA_MS;
      const kingEl = pieces.find((el) => el.cgKey === winnerKing);
      const winner = kingEl.classList.contains("white") ? "white" : "black";
      const theirs = pieces.filter((el) => !el.classList.contains(winner));
      const home = (el) => squareCorner(el.cgKey, orientation);
      const kingHome = home(kingEl);
      // The king first, then the others by how near they stand to it, so the line forms up in order.
      const dancers = [kingEl, ...pieces
        .filter((el) => el.classList.contains(winner) && el !== kingEl)
        .sort((a, b) => Math.hypot(home(a).x - kingHome.x, home(a).y - kingHome.y)
          - Math.hypot(home(b).x - kingHome.x, home(b).y - kingHome.y))];
      const path = congaPath();
      const start = path.nearest({ x: kingHome.x + 0.5, y: kingHome.y + 0.5 });
      const stagger = Math.min(150, 1200 / dancers.length);
      const marchAt = 400 + (dancers.length - 1) * stagger + CONGA_JOIN + 150;
      const marchMs = CONGA_HOME_AT - marchAt;

      const veil = element("coronation-veil", under);
      const tracks = [];
      const animations = dancers.flatMap((source, i) => {
        const from = home(source);
        const el = document.createElement("piece");
        el.className = `${roleOf(source)} ${winner} conga-dancer${i === 0 ? " conga-leader" : ""}`;
        el.style.left = `${(from.x / 8) * 100}%`;
        el.style.top = `${(from.y / 8) * 100}%`;
        el.style.zIndex = String(20 - i);
        over.append(el);

        const along = (since) => path.at(start - CONGA_GAP * i + (CONGA_SPEED * since) / 1000);
        const steps = Math.ceil(marchMs / CONGA_SAMPLE);
        const track = Array.from({ length: steps + 1 }, (_, k) => {
          const since = Math.min(marchMs, k * CONGA_SAMPLE);
          return { at: marchAt + since, ...along(since), lift: congaLift(since) };
        });
        tracks.push(track);
        const first = track[0], last = track[track.length - 1];
        const offset = (p) => ({ x: p.x - 0.5 - from.x, y: p.y - 0.5 - from.y });
        const join = offset(first), leave = offset(last);
        const joinAt = 400 + i * stagger;
        const lift = (d) => 0.6 + 0.12 * Math.hypot(d.x, d.y);
        return [
          el.animate(hopFrames(join.x, join.y, lift(join)),
            { duration: CONGA_JOIN, delay: joinAt, easing: "linear", fill: "forwards" }),
          el.animate(track.map((p) => {
            const d = offset(p);
            return { translate: translateBy(d.x, d.y - p.lift) };
          }), { duration: marchMs, delay: marchAt, easing: "linear", fill: "forwards" }),
          el.animate(congaSway(), {
            duration: 8 * CONGA_BEAT, delay: marchAt, iterations: marchMs / (8 * CONGA_BEAT), easing: "ease-in-out",
          }),
          el.animate(arriveFrames(leave.x, leave.y, lift(leave)),
            { duration: CONGA_JOIN, delay: CONGA_HOME_AT + 100 + i * 90, easing: "linear", fill: "forwards" }),
        ];
      });

      const visits = discoVisits(tracks);
      const disco = new CanvasAnimation(under, ms, (ctx, size, now) => drawDisco(ctx, size, now, visits));
      disco.canvas.classList.add("on-top");
      const hold = { duration: ms };
      return [
        ...dancers.map((el) => el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.97 }, { opacity: 1 }], hold)),
        ...theirs.map((el) => el.animate([
          { filter: "none", opacity: 1 },
          { filter: "grayscale(1) brightness(.6)", opacity: 0.5, offset: 0.05 },
          { filter: "grayscale(1) brightness(.6)", opacity: 0.5, offset: 0.93 },
          { filter: "none", opacity: 1 },
        ], hold)),
        veil.animate([{ opacity: 0 }, { opacity: 0.8, offset: 0.05 }, { opacity: 0.8, offset: 0.9 }, { opacity: 0 }],
          { duration: ms, fill: "forwards" }),
        over.animate([{ opacity: 1 }, { opacity: 1, offset: 0.97 }, { opacity: 0 }], { duration: ms, fill: "forwards" }),
        disco, ...animations,
      ];
    },
  },
  coronation: {
    name: "Coronation",
    play({ under, over }, { pieces, winnerKing, orientation }) {
      const ms = CORONATION_MS;
      const at = (t) => t / ms;
      const kingEl = pieces.find((el) => el.cgKey === winnerKing);
      const winner = kingEl.classList.contains("white") ? "white" : "black";
      const ours = pieces.filter((el) => el.classList.contains(winner));
      const theirs = pieces.filter((el) => !el.classList.contains(winner));
      const hold = { duration: ms };

      const veil = element("coronation-veil", under);
      const burst = element("sunburst", under);
      burst.style.left = `${(THRONE.x / 8) * 100}%`;
      burst.style.top = `${(THRONE.y / 8) * 100}%`;
      const rays = element("rays", burst);
      element("glow", burst);

      const placeAt = (el, corner) => {
        el.style.left = `${(corner.x / 8) * 100}%`;
        el.style.top = `${(corner.y / 8) * 100}%`;
      };
      const clone = (source, parent, extra) => {
        const el = document.createElement("piece");
        el.className = `${roleOf(source)} ${winner} ${extra}`;
        parent.append(el);
        return el;
      };

      const court = seatCourt(ours.filter((el) => el !== kingEl), orientation);
      const stagger = Math.min(180, 1200 / Math.max(1, court.length));
      const courtAnimations = court.flatMap((c, i) => {
        const el = clone(c.el, over, "coronation-court");
        placeAt(el, c.from);
        const toward = Math.sign(THRONE.x - c.place.x);
        return [
          el.animate(hopFrames(c.place.x - 0.5 - c.from.x, c.place.y - 0.5 - c.from.y, 1.4),
            { duration: 1000, delay: 700 + i * stagger, easing: "linear", fill: "both" }),
          el.animate([
            { scale: "1 1", rotate: "0deg" },
            { scale: "1.04 .72", rotate: `${toward * 14}deg`, offset: 0.45 },
            { scale: "1.04 .72", rotate: `${toward * 14}deg`, offset: 0.6 },
            { scale: "1 1", rotate: "0deg" },
          ], { duration: 800, delay: CROWN_LANDS + 500 + i * 110, easing: "ease-in-out" }),
        ];
      });

      const monarch = element("coronation-monarch", over);
      const home = squareCorner(winnerKing, orientation);
      placeAt(monarch, home);
      clone(kingEl, monarch, "");
      const crown = element("coronation-crown", monarch);
      crown.innerHTML = CROWN_SVG;
      const flash = element("coronation-flash", over);
      const crownY = THRONE.y + MONARCH_SCALE * (CROWN_IN_KING.top + CROWN_IN_KING.height / 2 - 0.5);
      flash.style.left = `${(THRONE.x / 8) * 100}%`;
      flash.style.top = `${(crownY / 8) * 100}%`;
      const throne = translateBy(THRONE.x - 0.5 - home.x, THRONE.y - 0.5 - home.y);

      const regalia = makeRegalia(1066, { x: THRONE.x / 8, y: crownY / 8 });
      const canvas = new CanvasAnimation(over, ms, (ctx, size, now) => drawRegalia(ctx, size, now, regalia));
      canvas.canvas.classList.add("on-top");

      const fadeAway = [{ opacity: 1 }, { opacity: 1, offset: 0.9 }, { opacity: 0 }];
      return [
        // The board's own pieces: the winner's hidden while their clones act, the loser's greyed.
        ...ours.map((el) => el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.9 }, { opacity: 1 }], hold)),
        ...theirs.map((el) => el.animate([
          { filter: "none", opacity: 1 },
          { filter: "grayscale(1) brightness(.6)", opacity: 0.45, offset: at(600) },
          { filter: "grayscale(1) brightness(.6)", opacity: 0.45, offset: 0.9 },
          { filter: "none", opacity: 1 },
        ], hold)),
        veil.animate([{ opacity: 0 }, { opacity: 1, offset: at(600) }, { opacity: 1 }],
          { duration: ms, fill: "forwards" }),
        under.animate(fadeAway, { duration: ms, fill: "forwards" }),
        over.animate(fadeAway, { duration: ms, fill: "forwards" }),
        monarch.animate([
          { translate: "0 0", scale: 1 },
          { translate: "0 -25%", scale: 1.2, offset: 0.3, easing: "ease-in-out" },
          { translate: throne, scale: MONARCH_SCALE },
        ], { duration: 1700, fill: "forwards" }),
        monarch.animate([
          { filter: "drop-shadow(0 0 0 hsl(48 100% 60% / 0))" },
          { filter: "drop-shadow(0 0 1.5cqw hsl(48 100% 60% / .9))" },
        ], { duration: 600, fill: "forwards" }),
        monarch.animate([{ rotate: "y 0deg" }, { rotate: "y 360deg" }],
          { duration: 1000, delay: CROWN_LANDS + 1600, easing: "ease-in-out" }),
        crown.animate([
          { translate: "0 -700%", rotate: "-25deg", opacity: 0 },
          { opacity: 1, offset: 0.15 },
          { translate: "0 8%", rotate: "4deg", offset: CROWN_DROP.land },
          { translate: "0 -6%", rotate: "-2deg", offset: 0.88 },
          { translate: "0 0", rotate: "0deg", opacity: 1 },
        ], { duration: CROWN_DROP.duration, delay: CROWN_DROP.delay, easing: "ease-in", fill: "both" }),
        flash.animate([{ opacity: 0, scale: 0.3 }, { opacity: 0.9, scale: 1, offset: 0.25 }, { opacity: 0, scale: 1.6 }],
          { duration: 600, delay: CROWN_LANDS - 60, fill: "both" }),
        burst.animate([{ scale: 0, opacity: 0 }, { scale: 1, opacity: 0.45 }],
          { duration: 700, delay: CROWN_LANDS, easing: "ease-out", fill: "both" }),
        rays.animate([{ rotate: "0deg" }, { rotate: "40deg" }],
          { duration: ms - CROWN_LANDS, delay: CROWN_LANDS, fill: "both" }),
        ...courtAnimations,
        canvas,
      ];
    },
  },
  explode: {
    name: "Exploding board",
    play({ under, over }, { pieces, winnerKing, loserKing, orientation, cgBoard, coords, boardEl }) {
      const ms = EXPLODE_MS;
      const off = (t) => t / ms;
      const random = seededRandom(1812);
      over.classList.add("unclipped", "exploding");
      const epicentre = squareCorner(loserKing, orientation);
      epicentre.x += 0.5;
      epicentre.y += 0.5;
      const look = getComputedStyle(cgBoard);
      const riders = new Map(pieces.filter((el) => el.cgKey !== winnerKing).map((el) => {
        const corner = squareCorner(el.cgKey, orientation);
        return [`${corner.x},${corner.y}`, el];
      }));

      const stars = makeStars(random);
      const voidLayer = new CanvasAnimation(under, ms, (ctx, size, now) => drawVoid(ctx, size, now, stars));
      const maxDist = Math.max(...[0, 7].flatMap((x) => [0, 7].map((y) =>
        Math.hypot(x + 0.5 - epicentre.x, y + 0.5 - epicentre.y))));

      const tiles = Array.from({ length: 64 }, (_, i) => {
        const col = i % 8, row = Math.floor(i / 8);
        const tile = element("explode-tile", over);
        tile.style.left = `${col * 12.5}%`;
        tile.style.top = `${row * 12.5}%`;
        // A board-sized face behind the tile's window, so any theme's background lines up.
        const face = element("explode-face", tile);
        face.style.left = `${-col * 100}%`;
        face.style.top = `${-row * 100}%`;
        for (const property of ["backgroundColor", "backgroundImage", "backgroundSize",
          "backgroundRepeat", "backgroundPosition"]) face.style[property] = look[property];
        const rider = riders.get(`${col},${row}`);
        if (rider) {
          const piece = document.createElement("piece");
          piece.className = rider.className;
          tile.append(piece);
          if (rider.cgKey === loserKing) piece.animate([
            { filter: "drop-shadow(0 0 0 rgb(255 40 0 / 0))", scale: 1 },
            { filter: "drop-shadow(0 0 1.5cqw rgb(255 40 0 / 1))", scale: 1.15 },
          ], { duration: BLAST_AT / 4, iterations: 4, direction: "alternate" });
        }
        const flight = tileFlight(col, row, epicentre, maxDist, random);
        return tile.animate(flightFrames(flight, off), { duration: ms, easing: "linear" });
      });

      const king = document.createElement("piece");
      const kingEl = pieces.find((el) => el.cgKey === winnerKing);
      king.className = `${kingEl.className} explode-king`;
      const home = squareCorner(winnerKing, orientation);
      king.style.left = `${home.x * 12.5}%`;
      king.style.top = `${home.y * 12.5}%`;
      over.append(king);

      const flash = element("explode-flash", over);
      flash.style.setProperty("--x", `${(epicentre.x / 8) * 100}%`);
      flash.style.setProperty("--y", `${(epicentre.y / 8) * 100}%`);
      const ring = element("explode-ring", over);
      ring.style.left = `${(epicentre.x / 8) * 100}%`;
      ring.style.top = `${(epicentre.y / 8) * 100}%`;
      const fire = makeBlast(random, { x: epicentre.x / 8, y: epicentre.y / 8 });
      const sparks = new CanvasAnimation(over, ms, (ctx, size, now) => drawBlast(ctx, size, now, fire));
      sparks.canvas.classList.add("on-top");

      const glow = "drop-shadow(0 0 2cqw hsl(48 100% 60% / .95))";
      const dark = "drop-shadow(0 0 0 hsl(48 100% 60% / 0))";
      const bob = [];
      for (let t = BLAST_AT + 1100, up = true; t < REWIND_AT + 600; t += 650, up = !up)
        bob.push({
          translate: translateBy(3 - home.x, 3 - home.y + (up ? -0.12 : 0.04)),
          scale: 1.6, filter: glow, offset: off(t), easing: "ease-in-out",
        });
      const hidden = [{ opacity: 0 }, { opacity: 0, offset: 0.95 }, { opacity: 1 }];

      return [
        ...pieces.map((el) => el.animate(hidden, { duration: ms })),
        ...coords.map((el) => el.animate(hidden, { duration: ms })),
        ...tiles,
        voidLayer,
        sparks,
        king.animate([
          { translate: "0 0", scale: 1, filter: dark },
          { translate: "0 0", scale: 1, filter: dark, offset: off(BLAST_AT), easing: "ease-out" },
          ...bob,
          { translate: "0 0", scale: 1, filter: dark, offset: off(REWIND_AT + FLIGHT) },
          { translate: "0 0", scale: 1, filter: dark },
        ], { duration: ms }),
        boardEl.animate([
          { translate: "0 0" }, { translate: "-0.3% 0.2%" }, { translate: "0.4% -0.3%" },
          { translate: "-0.6% -0.4%" }, { translate: "0.8% 0.6%" }, { translate: "-1% 0.4%" },
          { translate: "1.2% -0.8%" }, { translate: "-3% 2%", offset: 0.75 }, { translate: "2.5% -2%" },
          { translate: "-1% 1%" }, { translate: "0 0" },
        ], { duration: BLAST_AT + 350, easing: "linear" }),
        flash.animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 0 }],
          { duration: 600, delay: BLAST_AT, fill: "both" }),
        ring.animate([{ scale: 0, opacity: 1 }, { scale: 9, opacity: 0 }],
          { duration: 800, delay: BLAST_AT, easing: "ease-out", fill: "both" }),
      ];
    },
  },
  onFire: {
    name: "On fire",
    // Never ends: a golden halo pulses round the winner while the loser burns. The flames are
    // drawn twice, a full fire behind the king and a thinner one in front, so they wrap round it.
    play({ under, over }, { centre, loser }) {
      under.classList.add("unclipped");
      over.classList.add("unclipped");
      const halo = element("halo", under);
      halo.style.left = `${centre.x * 100}%`;
      halo.style.top = `${centre.y * 100}%`;
      const rays = element("halo-rays", halo);
      const ring = element("halo-ring", halo);
      const fire = makeFire(7);
      const margin = 0.25;
      return [
        halo.animate([{ scale: 0, opacity: 0 }, { scale: 1, opacity: 1 }],
          { duration: 700, easing: "cubic-bezier(.3, 1.6, .6, 1)", fill: "forwards" }),
        ring.animate([{ scale: 0.92, opacity: 0.75 }, { scale: 1.08, opacity: 1 }],
          { duration: 1400, iterations: Infinity, direction: "alternate", easing: "ease-in-out" }),
        rays.animate([{ rotate: "0deg" }, { rotate: "360deg" }],
          { duration: 16000, iterations: Infinity }),
        new CanvasAnimation(under, Infinity, (ctx, size, now) => drawFire(ctx, size, now, fire, loser, false), margin),
        new CanvasAnimation(over, Infinity, (ctx, size, now) => drawFire(ctx, size, now, fire, loser, true), margin),
      ];
    },
  },
  ko: {
    name: "SF4 K.O.",
    // Ultra Street Fighter 4's K.O.: the final blow freezes in a strobe, the screen shakes, the
    // scene sinks into a red burst and the word slams in from huge, overshoots and settles.
    play({ over }, { loser, boardEl }) {
      const ms = 3600;
      const backdrop = element("ko-backdrop", over);
      // The backdrop overhangs the board by 60% on each side (so it can turn); place the burst on
      // the mated king in its own coordinates.
      const inBackdrop = (p) => `${((0.6 + p) / 2.2) * 100}%`;
      backdrop.style.setProperty("--x", inBackdrop(loser.x));
      backdrop.style.setProperty("--y", inBackdrop(loser.y));
      const flash = element("ko-flash", over);
      const word = element("ko-word", over);
      word.innerHTML = "<span>CHECK</span><span>MATE</span>";
      const at = (t) => t / ms;
      return [
        flash.animate([
          { background: "#fff", opacity: 1 },
          { background: "#fff", opacity: 1, offset: at(60) },
          { background: "#000", opacity: 1, offset: at(61) },
          { background: "#000", opacity: 1, offset: at(120) },
          { background: "#fff", opacity: 1, offset: at(121) },
          { background: "#fff", opacity: 0, offset: at(320) },
          { background: "#fff", opacity: 0, offset: at(2700) },
          { background: "#fff", opacity: 0.9, offset: at(2760) },
          { background: "#fff", opacity: 0 },
        ], { duration: ms, fill: "forwards" }),
        backdrop.animate([
          { opacity: 0, rotate: "0deg" },
          { opacity: 0.9, offset: at(160) },
          { opacity: 0.9, offset: at(2700) },
          { opacity: 0, rotate: "12deg" },
        ], { duration: ms, fill: "forwards" }),
        word.animate([
          { scale: 4, opacity: 0 },
          { scale: 4, opacity: 0, offset: at(140) },
          { scale: 0.88, opacity: 1, offset: at(300), easing: "ease-out" },
          { scale: 1.04, opacity: 1, offset: at(400) },
          { scale: 1, opacity: 1, offset: at(480) },
          { scale: 1.03, opacity: 1, offset: at(2700) },
          { scale: 1.6, opacity: 0 , filter: "brightness(3)" },
        ], { duration: ms, fill: "forwards" }),
        boardEl.animate([
          { translate: "0 0" }, { translate: "-2.5% 1.5%" }, { translate: "2% -2%" },
          { translate: "-1.5% -1%" }, { translate: "1% 1.5%" }, { translate: "-0.5% 0" },
          { translate: "0 0" },
        ], { duration: 420, delay: 280, easing: "linear" }),
      ];
    },
  },
  fireworks: {
    name: "Fireworks",
    play({ over }) {
      const show = makeShow(20261122);
      const end = Math.max(...show.map((s) => s.launch + s.rise + Math.max(...s.sparks.map((p) => p.life))));
      const draw = (ctx, size, now) => {
        // Night falls on the board, then lifts as the last sparks die.
        const night = 0.75 * Math.min(1, now / 0.6, Math.max(0, (end - now) / 1.2));
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = `rgb(4 6 22 / ${night})`;
        ctx.fillRect(0, 0, size, size);
        ctx.globalCompositeOperation = "lighter";
        ctx.lineCap = "round";
        show.forEach((shell) => drawShell(ctx, size, shell, now));
      };
      return [new CanvasAnimation(over, end * 1000, draw)];
    },
  },
  sunburst: {
    name: "Sunburst",
    play({ under }, { centre }) {
      const burst = element("sunburst", under);
      burst.style.left = `${centre.x * 100}%`;
      burst.style.top = `${centre.y * 100}%`;
      const rays = element("rays", burst);
      const glow = element("glow", burst);
      return [
        burst.animate([
          { scale: 0, opacity: 0 },
          { scale: 1.08, opacity: 1, offset: 0.18 },
          { scale: 1, opacity: 1, offset: 0.26 },
          { scale: 1, opacity: 1, offset: 0.8 },
          { scale: 1.1, opacity: 0 },
        ], { duration: 3200, easing: "ease-out", fill: "forwards" }),
        rays.animate([{ rotate: "0deg" }, { rotate: "45deg" }], { duration: 3200, fill: "forwards" }),
        glow.animate([{ scale: 1 }, { scale: 1.25 }, { scale: 1 }],
          { duration: 900, iterations: 3, easing: "ease-in-out", delay: 300 }),
      ];
    },
  },
};

// The game page (index.html, play.js) plays one of these when a human wins: the beaten bot's own,
// or one of play.js's WIN_ANIMATIONS at random after beating a human; the others (on fire, K.O.,
// fireworks, sunburst) are earlier, shorter experiments.

/* When a handle ends, in ms from the start (Infinity for one that never does). */
function endTime(handle) {
  if (typeof handle.endTime === "number") return handle.endTime;
  return handle.effect?.getComputedTiming().endTime ?? 0;
}

/* Play animation `id` over a chessground board whose game has just ended in mate: `winnerKing`
   and `loserKing` are the kings' squares, `boardEl` the element chessground was given, and
   `restoreBoard` puts the final position back (Replay drives the board). `replay` is the game for
   Replay: { startFen, variant, moves (SAN, space-separated), white, black, date, result }.
   Returns { finished, stop }: `finished` resolves once the animation has ended and its layers are
   gone, whether it ran out or stop() cut it short. */
export function playWin(id, { cg, boardEl, winnerKing, loserKing, restoreBoard, replay }) {
  const container = boardEl.querySelector("cg-container");
  const layers = { under: element("fx", container), over: element("fx over", container) };
  const orientation = cg.state.orientation;
  const handles = ANIMATIONS[id].play(layers, {
    centre: squareCentre(winnerKing, orientation), loser: squareCentre(loserKing, orientation),
    pieces: [...container.querySelectorAll("cg-board piece")], winnerKing, loserKing, orientation,
    cgBoard: container.querySelector("cg-board"), coords: [...container.querySelectorAll("coords")],
    cg, restoreBoard, boardEl, replay,
  });
  const ms = Math.min(20000, Math.max(0, ...handles.map(endTime)));
  let resolve;
  const finished = new Promise((r) => { resolve = r; });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    handles.forEach((h) => h.cancel());
    layers.under.remove();
    layers.over.remove();
    restoreBoard();
    resolve();
  };
  const timer = setTimeout(stop, ms + 150);
  return { finished, stop };
}
