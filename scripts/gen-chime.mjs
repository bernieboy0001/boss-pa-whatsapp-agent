/*
 * Generates public/notify-chime.wav — the notification sound served as a real
 * audio asset (replacing the old purely synthesised Web Audio chime).
 *
 * It is a short, soft two-note bell (A5 -> E6) with a fast attack and an
 * exponential decay, plus a couple of quiet harmonics so it reads as a "ding"
 * rather than a flat beep. Deterministic, no dependencies: run
 *   node scripts/gen-chime.mjs
 * and it rewrites the file. The browser pitch-shifts this one asset per event
 * kind (see CHIME_RATES in public/dashboard.js), so a single file is enough.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 44100;
const DURATION = 0.9; // seconds
const NOTES = [
  { t: 0.0, freq: 880.0 }, // A5
  { t: 0.14, freq: 1318.51 }, // E6
  { t: 0.28, freq: 1760.0 }, // A6 (soft sparkle)
];
// Relative weights for the fundamental + harmonics of each note.
const PARTIALS = [
  { mult: 1, gain: 1.0, decay: 6.5 },
  { mult: 2, gain: 0.35, decay: 9.0 },
  { mult: 3, gain: 0.12, decay: 12.0 },
];

const samples = new Float64Array(Math.round(RATE * DURATION));
for (const note of NOTES) {
  const start = Math.round(note.t * RATE);
  for (const part of PARTIALS) {
    const freq = note.freq * part.mult;
    const decay = part.decay;
    for (let i = start; i < samples.length; i++) {
      const t = (i - start) / RATE;
      const attack = Math.min(1, t / 0.006); // 6 ms soft attack
      const env = attack * Math.exp(-decay * t);
      samples[i] += part.gain * env * Math.sin(2 * Math.PI * freq * t);
    }
  }
}

// Normalise to a comfortable peak, then convert to 16-bit PCM.
let peak = 0;
for (const s of samples) peak = Math.max(peak, Math.abs(s));
const scale = peak > 0 ? 0.82 / peak : 1;

const data = Buffer.alloc(samples.length * 2);
for (let i = 0; i < samples.length; i++) {
  const v = Math.max(-1, Math.min(1, samples[i] * scale));
  data.writeInt16LE(Math.round(v * 32767), i * 2);
}

const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16); // PCM chunk size
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits per sample
header.write("data", 36);
header.writeUInt32LE(data.length, 40);

const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "notify-chime.wav");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, data]));
console.log(`wrote ${out} (${(header.length + data.length) / 1024 | 0} KB, ${DURATION}s)`);
