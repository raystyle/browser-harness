/**
 * Env parsing helpers with setdefault semantics: a typo'd config value must
 * never kill the process at import time — unparsable/<=0 values fall back to
 * the default (Python `_env_seconds` parity).
 */

/** Parse a seconds value from env; fall back to `def` on missing/invalid/<=0. */
export function envSeconds(name: string, def: number): number {
  return envNumber(name, def);
}

/** Parse a number from env; fall back to `def` on missing/invalid/<=0. */
export function envNumber(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return def;
  return v;
}

/** env value treated as boolean-ish: 1/true/yes/on → true; 0/false/no/off → false; unset → undefined. */
export function envTriBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  return undefined;
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
