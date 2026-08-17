import fs from 'node:fs';
import path from 'node:path';

const sampleRate = 44_100;
const twoPi = Math.PI * 2;

function envelope(time, start, length, attack = 0.035, release = 0.7) {
  const local = time - start;
  if (local < 0 || local >= length) return 0;
  const rise = Math.min(1, local / attack);
  const fall = Math.min(1, (length - local) / release);
  return rise * fall;
}

function rhodes(freq, local) {
  const modulation = 0.42 * Math.exp(-local * 2.8) * Math.sin(twoPi * freq * 2 * local);
  return Math.sin(twoPi * freq * local + modulation) * 0.78
    + Math.sin(twoPi * freq * 2 * local) * 0.15
    + Math.sin(twoPi * freq * 3 * local) * 0.07;
}

function seededNoise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0xFFFFFFFF * 2 - 1;
  };
}

function writeWav(file, duration, render) {
  const frameCount = Math.floor(duration * sampleRate);
  const data = Buffer.alloc(frameCount * 4);
  for (let i = 0; i < frameCount; i += 1) {
    const [rawLeft, rawRight] = render(i / sampleRate, i);
    const left = Math.tanh(rawLeft * 1.22) * 0.78;
    const right = Math.tanh(rawRight * 1.22) * 0.78;
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left)) * 32_767), i * 4);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right)) * 32_767), i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

const root = path.resolve(import.meta.dirname, '..');
const assets = path.join(root, 'assets');
const temp = path.join(root, '.audio-build');
fs.mkdirSync(temp, { recursive: true });

// An original 72-BPM lo-fi jazz loop: dusty Rhodes, swung drums, vinyl and upright-style bass.
const beatLength = 60 / 72;
const barLength = beatLength * 4;
const musicLength = barLength * 8;
const chords = [
  [146.83, 174.61, 220.00, 261.63, 329.63], // Dm9
  [98.00, 123.47, 164.81, 220.00, 329.63],  // G13
  [130.81, 164.81, 196.00, 246.94, 293.66], // Cmaj9
  [110.00, 138.59, 164.81, 207.65, 233.08], // A7b9
  [87.31, 130.81, 164.81, 196.00, 220.00],  // Fmaj9
  [82.41, 123.47, 155.56, 196.00, 207.65],  // E7#9
  [110.00, 130.81, 164.81, 196.00, 246.94], // Am9
  [110.00, 138.59, 164.81, 196.00, 233.08], // A7alt
];
const bassRoots = [73.42, 49.00, 65.41, 55.00, 43.65, 41.20, 55.00, 55.00];
const melodyEvents = [
  [0, 0.65, 440.00, 0.72], [0, 2.15, 523.25, 0.52],
  [1, 1.45, 493.88, 0.82], [2, 0.45, 392.00, 0.55], [2, 2.55, 329.63, 0.75],
  [3, 1.15, 415.30, 0.55], [4, 0.65, 440.00, 0.95], [4, 2.65, 523.25, 0.48],
  [5, 1.15, 466.16, 0.68], [6, 0.45, 392.00, 0.62], [6, 2.10, 329.63, 0.90],
  [7, 1.45, 277.18, 0.48], [7, 2.45, 311.13, 0.62],
];
const noise = seededNoise(0x4C4F4649);
let previousVinyl = 0;

writeWav(path.join(temp, 'luku-lofi-jazz.wav'), musicLength, (time) => {
  const bar = Math.min(chords.length - 1, Math.floor(time / barLength));
  const barStart = bar * barLength;
  let left = 0;
  let right = 0;

  for (const offset of [0, beatLength * 2.55]) {
    const start = barStart + offset;
    const env = envelope(time, start, offset === 0 ? beatLength * 2.35 : beatLength * 1.35, 0.045, 0.62);
    if (!env) continue;
    chords[bar].forEach((freq, index) => {
      const local = time - start;
      const wow = 1 + Math.sin(twoPi * 0.31 * time + index) * 0.0016;
      const voice = rhodes(freq * wow, local) * env * 0.047;
      const pan = index / (chords[bar].length - 1);
      left += voice * (0.91 - pan * 0.31);
      right += voice * (0.60 + pan * 0.31);
    });
  }

  const beat = Math.floor(time / beatLength);
  const beatStart = beat * beatLength;
  const beatInBar = beat % 4;
  const nextRoot = bassRoots[(bar + 1) % bassRoots.length];
  const bassFreq = beatInBar === 0 ? bassRoots[bar] : beatInBar === 1 ? bassRoots[bar] * 1.5 : beatInBar === 2 ? bassRoots[bar] * 2 : nextRoot * 0.94;
  const bassEnv = envelope(time, beatStart, beatLength * 0.82, 0.018, 0.24) * Math.exp(-(time - beatStart) * 0.36);
  const bass = (Math.sin(twoPi * bassFreq * (time - beatStart)) + Math.sin(twoPi * bassFreq * 2 * (time - beatStart)) * 0.18) * bassEnv * 0.076;
  left += bass; right += bass * 0.94;

  if (beatInBar === 0 || beatInBar === 2) {
    const local = time - beatStart;
    const kick = Math.sin(twoPi * (58 - local * 16) * local) * Math.exp(-local * 14) * 0.043;
    left += kick; right += kick;
  }

  const rawNoise = noise();
  const vinyl = rawNoise * 0.24 + previousVinyl * 0.76;
  previousVinyl = vinyl;
  const beatLocal = time - beatStart;
  const swingLocal = beatLocal >= beatLength * 0.62 ? beatLocal - beatLength * 0.62 : beatLocal;
  const hat = (rawNoise - vinyl) * Math.exp(-swingLocal * 38) * (beatLocal >= beatLength * 0.62 ? 0.010 : 0.007);
  const brush = (beatInBar === 1 || beatInBar === 3) ? rawNoise * Math.exp(-beatLocal * 9) * 0.018 : 0;
  const crackle = Math.abs(rawNoise) > 0.9987 ? rawNoise * 0.055 : 0;
  left += vinyl * 0.005 + hat + brush + crackle;
  right += vinyl * 0.006 - hat * 0.65 + brush * 0.86 + crackle * 0.72;

  for (const [eventBar, eventBeat, freq, eventDuration] of melodyEvents) {
    if (eventBar !== bar) continue;
    const start = barStart + eventBeat * beatLength;
    const env = envelope(time, start, eventDuration * beatLength, 0.028, 0.38);
    if (!env) continue;
    const local = time - start;
    const tone = rhodes(freq * (1 + Math.sin(twoPi * 0.43 * time) * 0.0012), local) * env * 0.033;
    left += tone * 0.67; right += tone;
  }

  const edge = Math.min(1, time / 0.14, (musicLength - time) / 0.14);
  return [left * edge, right * edge];
});

writeWav(path.join(temp, 'luku-open.wav'), 1.55, (time) => {
  const notes = [[0.08, 523.25], [0.24, 659.25], [0.47, 987.77]];
  let left = 0; let right = 0;
  notes.forEach(([start, freq], index) => {
    const env = envelope(time, start, 1.18 - index * 0.12, 0.03, 0.7) * Math.exp(-Math.max(0, time - start) * 0.55);
    if (!env) return;
    const tone = rhodes(freq, time - start) * env * 0.13;
    left += tone * (index === 0 ? 0.82 : 0.66);
    right += tone * (index === 0 ? 0.66 : 0.86);
  });
  return [left, right];
});

const tapNoise = seededNoise(0x544150);
writeWav(path.join(temp, 'luku-tap.wav'), 0.13, (time) => {
  const env = Math.exp(-time * 44);
  const wood = Math.sin(twoPi * 310 * time) * 0.12 + Math.sin(twoPi * 515 * time) * 0.055;
  const texture = tapNoise() * 0.032;
  return [(wood + texture) * env, (wood * 0.9 + texture) * env];
});

console.log(temp);
