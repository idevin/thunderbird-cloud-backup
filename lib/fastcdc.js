const MIN = 256 * 1024;
const AVG = 1024 * 1024;
const MAX = 4 * 1024 * 1024;

function gearTable() {
  let x = 0x9e3779b9;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    table[i] = x;
  }
  return table;
}

const GEAR = gearTable();
const MASK = (1 << 20) - 1;

export function cutPoint(bytes, min = MIN, max = MAX) {
  const n = bytes.length;
  if (n <= min) return n;
  const limit = Math.min(n, max);
  let hash = 0;
  for (let i = min; i < limit; i++) {
    hash = (Math.imul(hash, 2) + GEAR[bytes[i]]) >>> 0;
    if ((hash & MASK) === 0) return i + 1;
  }
  return limit;
}

function concatInto(a, b) {
  if (!a.length) return b.slice();
  if (!b.length) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function createChunker() {
  let buf = new Uint8Array(0);
  return {
    push(slice) {
      buf = concatInto(buf, slice);
      const out = [];
      while (buf.length >= MAX) {
        const n = cutPoint(buf.subarray(0, MAX));
        out.push(buf.slice(0, n));
        buf = buf.slice(n);
      }
      return out;
    },
    finish() {
      const out = [];
      while (buf.length > MAX) {
        const n = cutPoint(buf.subarray(0, MAX));
        out.push(buf.slice(0, n));
        buf = buf.slice(n);
      }
      if (buf.length) out.push(buf.slice());
      buf = new Uint8Array(0);
      return out;
    },
  };
}

export const CHUNK_LIMITS = { MIN, AVG, MAX };
