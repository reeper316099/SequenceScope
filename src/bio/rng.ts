// Seeded, platform-independent PRNG. NO Math.random anywhere in the project (lint-enforced).
//
// Generator: sfc32 (Chris Doty-Humphrey, PractRand), 128-bit state, 32-bit integer arithmetic only, so every
// platform and JS engine produces identical output for the same seed. Seeding: splitmix32 expands one 32-bit
// seed into the four state words, then 12 outputs are discarded (warm-up).
import { BioError } from './errors';

/** Returns a splitmix32 stream starting from `seed` (used for seeding and stream derivation). */
export function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** Checks a seed is an unsigned 32-bit integer (the UI shows and stores seeds in this form). */
export function assertSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new BioError('invalid-argument', `Seed must be an integer from 0 to 4294967295, got ${seed}.`);
  }
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  /** Builds the generator from a 32-bit seed (see file header for the algorithm). */
  constructor(seed: number) {
    assertSeed(seed);
    const sm = splitmix32(seed);
    this.a = sm() | 0;
    this.b = sm() | 0;
    this.c = sm() | 0;
    this.d = sm() | 0;
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  /** Next unsigned 32-bit integer (sfc32 step). */
  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1) with 32 bits of resolution. */
  nextFloat(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Unbiased integer in [0, bound) using rejection sampling (no modulo bias). */
  nextInt(bound: number): number {
    if (!Number.isInteger(bound) || bound < 1 || bound > 4294967296) {
      throw new BioError('invalid-argument', `nextInt bound must be an integer in [1, 2^32], got ${bound}.`);
    }
    const limit = Math.floor(4294967296 / bound) * bound; // largest multiple of bound that fits in 2^32
    let x = this.nextUint32();
    while (x >= limit) x = this.nextUint32();
    return x % bound;
  }
}

/** Convenience constructor. */
export function createRng(seed: number): Rng {
  return new Rng(seed);
}

/**
 * Derives an independent seed for stream number `stream` from a master seed (e.g. bootstrap replicate r), so
 * results do not depend on how work is split across workers.
 */
export function deriveSeed(seed: number, stream: number): number {
  assertSeed(seed);
  if (!Number.isInteger(stream) || stream < 0) throw new BioError('invalid-argument', 'stream must be a non-negative integer.');
  const mixed = splitmix32(seed)() ^ Math.imul(stream + 1, 0x85ebca6b);
  return splitmix32(mixed >>> 0)() >>> 0;
}
