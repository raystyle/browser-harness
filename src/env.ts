/**
 * Env parsing helpers with setdefault semantics: a typo'd config value must
 * never kill the process at import time — unparsable/<=0 values fall back to
 * the default (Python `_env_seconds` parity).
 *
 * D29: schemas are Zod; the "silent fallback" contract is preserved by
 * safeParse — a bad value never throws, it just lands on the default.
 */

import { z } from 'zod';

/** positive finite number (env strings are coerced) */
const positiveNumber = z.coerce.number().refine(v => Number.isFinite(v) && v > 0, { message: 'must be a positive finite number' });

/** true-ish / false-ish strings, case-insensitive (TRUE/On/No/OFF all legal) */
const TRI_TRUE = /^(1|true|yes|on)$/i;
const TRI_FALSE = /^(0|false|no|off)$/i;
const triBool = z.string()
  .refine(v => TRI_TRUE.test(v) || TRI_FALSE.test(v), { message: 'not a tri-bool' })
  .transform(v => TRI_TRUE.test(v));

/** Parse a seconds value from env; fall back to `def` on missing/invalid/<=0. */
export function envSeconds(name: string, def: number): number {
  return envNumber(name, def);
}

/** Parse a number from env; fall back to `def` on missing/invalid/<=0. */
export function envNumber(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const r = positiveNumber.safeParse(raw);
  return r.success ? r.data : def;
}

/** env value treated as boolean-ish: 1/true/yes/on → true; 0/false/no/off → false; unset/unparsable → undefined. */
export function envTriBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const r = triBool.safeParse(raw);
  return r.success ? r.data : undefined;
}

/** `setdefault` for process.env: the real process environment always wins. */
export function envSetDefault(key: string, value: string): void {
  if (process.env[key] === undefined || process.env[key] === '') {
    process.env[key] = value;
  }
}

/** Clamp v into [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
