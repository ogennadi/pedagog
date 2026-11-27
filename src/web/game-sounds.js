/* Sounds, for the game page (index.html) and the sound sampler (sounds.html): short synthesised
   knocks and chimes, so there are no audio files to load. Browsers only let a page make sound
   after the user has touched it, so the first tap or key unlocks it (audioContext). Everything
   below audioContext only schedules sounds on a context it is given, so it also renders offline. */
let audio = null;

/* The page's audio context, woken if the browser suspended it; null where there is no Web Audio. */
export function audioContext() {
  if (!audio) {
    const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContextClass) return null;
    audio = new AudioContextClass();
  }
  if (audio.state === "suspended") audio.resume().catch(() => {});
  return audio;
}

/* 0.12 s of fading white noise, made once per context: the raw material of every knock. */
const noises = new WeakMap();
function noiseOf(ctx) {
  if (!noises.has(ctx)) {
    const length = Math.floor(ctx.sampleRate * 0.12);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    noises.set(ctx, buffer);
  }
  return noises.get(ctx);
}

/* The level of every sound: each one goes through this one gain, made once per context. */
const VOLUME = 0.5;
const outputs = new WeakMap();
function outputOf(ctx) {
  if (!outputs.has(ctx)) {
    const master = ctx.createGain();
    master.gain.value = VOLUME;
    master.connect(ctx.destination);
    outputs.set(ctx, master);
  }
  return outputs.get(ctx);
}

/* A pitch gliding from freq to `to` and dying away. */
function tone(ctx, { at, freq, to = freq, length, volume, type = "sine" }) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + length);
  gain.gain.setValueAtTime(volume, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(outputOf(ctx));
  osc.start(at);
  osc.stop(at + length + 0.02);
}

/* A burst of the noise through a band-pass filter: wood striking wood. */
function knock(ctx, { at, centre, q = 1.4, length, volume }) {
  const source = ctx.createBufferSource();
  source.buffer = noiseOf(ctx);
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = centre;
  band.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  source.connect(band).connect(gain).connect(outputOf(ctx));
  source.start(at);
}

/* The noise swelling while its band sweeps from `from` to `to`: a swish. */
function sweep(ctx, { at, from, to, q = 2, length, volume }) {
  const source = ctx.createBufferSource();
  source.buffer = noiseOf(ctx);
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.setValueAtTime(from, at);
  band.frequency.exponentialRampToValueAtTime(to, at + length);
  band.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + length * 0.8);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  source.connect(band).connect(gain).connect(outputOf(ctx));
  source.start(at);
}

/* The move sound: one soft knock. */
function moveSound(ctx, at) {
  knock(ctx, { at, centre: 1800, length: 0.07, volume: 0.6 });
  tone(ctx, { at, freq: 210, to: 70, length: 0.08, volume: 0.3 });
}

/* The check ping: a soft mid note (A5), after the move's own sound. */
const PING = 880;

/* Capture sounds, by id: GAME_CAPTURE is the game's; the rest are ideas to try in sounds.html.
   checkAt: when the check ping follows this capture, if not at 0.12 s. glass, ting, titing and
   chirp ring well above the ping, so a capture that checks falls from high to the ping, where a
   plain check is a knock and the ping. */
export const CAPTURES = {
  glass: {
    name: "Glass clink",
    about: "Two glasses touching: a bright click and a high, shimmering ring, far above the check ping.",
    play(ctx, at) {
      knock(ctx, { at, centre: 7000, q: 1.2, length: 0.015, volume: 0.9 });
      tone(ctx, { at, freq: 2637, length: 0.25, volume: 0.1 });
      tone(ctx, { at, freq: 2650, length: 0.25, volume: 0.08 });
      tone(ctx, { at, freq: 6100, length: 0.08, volume: 0.03 });
    },
  },
  ting: {
    name: "Ting",
    about: "A small, bright bell, more than an octave above the check ping: with check it goes ting-dong.",
    play(ctx, at) {
      knock(ctx, { at, centre: 6000, q: 1, length: 0.012, volume: 0.5 });
      tone(ctx, { at, freq: 2093, length: 0.2, volume: 0.15 });
      tone(ctx, { at, freq: 5440, length: 0.06, volume: 0.04 });
    },
  },
  titing: {
    name: "Ti-ting",
    about: "Two quick high taps, rising, where everything else falls; both above the check ping.",
    checkAt: 0.17,
    play(ctx, at) {
      [[0, 1568], [0.07, 2349]].forEach(([dt, freq]) => {
        knock(ctx, { at: at + dt, centre: 5000, q: 1, length: 0.012, volume: 0.5 });
        tone(ctx, { at: at + dt, freq, length: 0.09, volume: 0.17, type: "triangle" });
      });
    },
  },
  chirp: {
    name: "Chirp",
    about: "A quick whistle falling from very high, a “pew”, that stays above the check ping.",
    play(ctx, at) {
      knock(ctx, { at, centre: 5000, q: 1, length: 0.012, volume: 0.5 });
      tone(ctx, { at, freq: 4200, to: 1400, length: 0.09, volume: 0.18 });
    },
  },
  clack: {
    name: "Clack and thud",
    about: "A bright clack, the taking piece striking the taken one, then a deeper thud as it lands.",
    play(ctx, at) {
      knock(ctx, { at, centre: 3200, q: 2.5, length: 0.04, volume: 2.2 });
      tone(ctx, { at, freq: 1300, to: 950, length: 0.05, volume: 0.15, type: "triangle" });
      knock(ctx, { at: at + 0.06, centre: 900, length: 0.11, volume: 0.9 });
      tone(ctx, { at: at + 0.06, freq: 140, to: 60, length: 0.13, volume: 0.5 });
    },
  },
  knock: {
    name: "Low knock",
    about: "The first capture sound: the move's knock, lower, louder and longer.",
    play(ctx, at) {
      knock(ctx, { at, centre: 1100, length: 0.11, volume: 0.9 });
      tone(ctx, { at, freq: 150, to: 70, length: 0.12, volume: 0.5 });
    },
  },
  rattle: {
    name: "Crack and rattle",
    about: "A loud crack, then the taken piece rattling as it tumbles off the board.",
    play(ctx, at) {
      knock(ctx, { at, centre: 2600, q: 1.2, length: 0.06, volume: 1.3 });
      tone(ctx, { at, freq: 170, to: 60, length: 0.12, volume: 0.45 });
      [[0.085, 3600, 1.8], [0.13, 3000, 1.3], [0.165, 3400, 0.9], [0.19, 2900, 0.6]].forEach(([dt, centre, volume]) =>
        knock(ctx, { at: at + dt, centre, q: 3, length: 0.025, volume }));
    },
  },
  tiktok: {
    name: "Tik-tok",
    about: "Two pitched woodblock taps, high then low.",
    play(ctx, at) {
      [[0, 1500, 0.28], [0.09, 1000, 0.3]].forEach(([dt, freq, volume]) => {
        knock(ctx, { at: at + dt, centre: 2800, q: 1.5, length: 0.015, volume: 0.7 });
        tone(ctx, { at: at + dt, freq, to: freq * 0.94, length: 0.11, volume });
        tone(ctx, { at: at + dt, freq: freq * 2.7, length: 0.03, volume: volume / 4 });
      });
      tone(ctx, { at: at + 0.09, freq: 150, to: 60, length: 0.12, volume: 0.4 });
    },
  },
  swipe: {
    name: "Swipe and thunk",
    about: "A swish, the taken piece swept off, then a heavy thunk.",
    play(ctx, at) {
      sweep(ctx, { at, from: 700, to: 4500, q: 1.5, length: 0.11, volume: 0.9 });
      knock(ctx, { at: at + 0.11, centre: 800, length: 0.12, volume: 1.1 });
      tone(ctx, { at: at + 0.11, freq: 130, to: 50, length: 0.16, volume: 0.6 });
    },
  },
  clink: {
    name: "Clink",
    about: "Metal, not wood: a short ring of out-of-tune partials, like a coin dropped in a dish.",
    play(ctx, at) {
      knock(ctx, { at, centre: 5000, q: 1, length: 0.02, volume: 0.8 });
      [[1850, 0.16, 0.3], [2980, 0.1, 0.22], [4410, 0.07, 0.14]].forEach(([freq, volume, length]) =>
        tone(ctx, { at, freq, length, volume }));
      tone(ctx, { at, freq: 180, to: 70, length: 0.08, volume: 0.3 });
    },
  },
  pop: {
    name: "Pop",
    about: "A pitch leaping upward, like a cork, with a click on top.",
    play(ctx, at) {
      knock(ctx, { at, centre: 2500, length: 0.02, volume: 0.8 });
      tone(ctx, { at, freq: 280, to: 1100, length: 0.07, volume: 0.55 });
      tone(ctx, { at, freq: 560, to: 2200, length: 0.05, volume: 0.12, type: "triangle" });
    },
  },
  snap: {
    name: "Snap",
    about: "One very short, bright crack, much sharper than a move.",
    play(ctx, at) {
      knock(ctx, { at, centre: 4200, q: 0.7, length: 0.03, volume: 1.1 });
      tone(ctx, { at, freq: 240, to: 80, length: 0.05, volume: 0.3 });
    },
  },
  thump: {
    name: "Deep thump",
    about: "A heavy, bass-deep thump that lasts a little longer.",
    play(ctx, at) {
      knock(ctx, { at, centre: 500, q: 1, length: 0.15, volume: 0.9 });
      tone(ctx, { at, freq: 110, to: 40, length: 0.25, volume: 0.6 });
    },
  },
};
export const GAME_CAPTURE = "thump";

/* Schedule one of the game's sounds at time `at`. kind: "move", "capture", "check", "win" or
   "end" (each of which starts with its move's knock); check adds a ping, so a move that captures
   and checks is "capture" with check true. capture: which of CAPTURES a capture plays. */
export function scheduleSound(ctx, at, kind, check = kind === "check", capture = GAME_CAPTURE) {
  if (kind === "capture") CAPTURES[capture].play(ctx, at);
  else moveSound(ctx, at);
  const pingAt = kind === "capture" ? CAPTURES[capture].checkAt ?? 0.12 : 0.06;
  if (check) tone(ctx, { at: at + pingAt, freq: PING, length: 0.25, volume: 0.08, type: "triangle" });
  const chime = { win: [523, 659, 784, 1047], end: [440, 392] }[kind];
  chime?.forEach((freq, i) => tone(ctx, { at: at + 0.15 + i * 0.13, freq, length: 0.45, volume: 0.12, type: "triangle" }));
}

/* Play one of the game's sounds now, if the page may make sound yet (see scheduleSound). */
export function playSound(kind, check = kind === "check") {
  const ctx = audioContext();
  if (ctx?.state === "running") scheduleSound(ctx, ctx.currentTime + 0.005, kind, check);
}
