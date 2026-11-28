// The replay line (milestone 5, T6): one printable string that replays a run exactly, since a run
// is a pure function of its seed and plan (decision 0034). It's base64url JSON, written here with
// no runtime global, so it reads the same in every runtime (0004): the seed, the network mode,
// the plan, where the run was cut short, the bug planted if there was one, the violation the
// run found, so a replay can say whether it reproduced, and the package's version, since a seed's
// plan and history are promised only within one (decision 0039).

import { describe } from '../checks.js';
import type { Plant } from '../internal.js';
import { VERSION } from '../version.js';
import type { NetworkMode } from './network.js';
import type { FaultPlan } from './plan.js';

/** What a replay line holds. */
export interface ReplayLine {
  readonly seed: number;
  readonly mode: NetworkMode;
  readonly plan: FaultPlan;
  /** Where the run was cut short, if it was. */
  readonly untilMs?: number;
  /** The bug planted on the run's nodes, for the package's own tests and script. */
  readonly plant?: Plant;
  /** The violation the run found, which a replay must find again. None for a run that passed. */
  readonly violation?: { readonly invariant: string; readonly message: string };
  /**
   * The package version that recorded it. Lines from before 1.0 have none. Encoding always
   * writes this version's.
   */
  readonly version?: string;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const KEYS = new Set(['seed', 'mode', 'plan', 'untilMs', 'plant', 'violation', 'version']);

/** `line` as a replay line: seed first, as it prints, and this package's version last. */
export function encodeReplay(line: ReplayLine): string {
  const ordered: Record<string, unknown> = { seed: line.seed, mode: line.mode, plan: line.plan };
  if (line.untilMs !== undefined) ordered.untilMs = line.untilMs;
  if (line.plant !== undefined) ordered.plant = line.plant;
  if (line.violation !== undefined) {
    ordered.violation = { invariant: line.violation.invariant, message: line.violation.message };
  }
  ordered.version = VERSION;
  // Escaped to ASCII, so each character is one byte and the encoding needs no UTF-8 step.
  const json = JSON.stringify(ordered).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return toBase64Url(json);
}

/**
 * The replay line `text` holds. Its plan is checked when it's run, against the scenario.
 * @throws TypeError for anything that isn't a replay line.
 */
export function decodeReplay(text: unknown): ReplayLine {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new TypeError(`replay: not a replay line, got ${describe(text)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64Url(text));
  } catch {
    throw new TypeError('replay: not a replay line: it does not decode to JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('replay: not a replay line: it does not decode to an object');
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!KEYS.has(key)) throw new TypeError(`replay: unknown key ${key} in the line`);
  }
  if (typeof r.seed !== 'number' || !Number.isSafeInteger(r.seed)) {
    throw new TypeError(`replay: the line's seed must be a safe integer, got ${describe(r.seed)}`);
  }
  if (r.mode !== 'contract' && r.mode !== 'chaos') {
    throw new TypeError(
      `replay: the line's mode must be contract or chaos, got ${describe(r.mode)}`,
    );
  }
  if (!Array.isArray(r.plan)) {
    throw new TypeError(`replay: the line's plan must be a list, got ${describe(r.plan)}`);
  }
  if (
    r.untilMs !== undefined &&
    (typeof r.untilMs !== 'number' || !Number.isSafeInteger(r.untilMs))
  ) {
    throw new TypeError(
      `replay: the line's untilMs must be an integer, got ${describe(r.untilMs)}`,
    );
  }
  if (r.plant !== undefined && typeof r.plant !== 'string') {
    throw new TypeError(`replay: the line's plant must be a name, got ${describe(r.plant)}`);
  }
  const v = r.violation as { invariant?: unknown; message?: unknown } | undefined | null;
  if (
    v !== undefined &&
    (typeof v !== 'object' ||
      v === null ||
      typeof v.invariant !== 'string' ||
      typeof v.message !== 'string')
  ) {
    throw new TypeError("replay: the line's violation must have an invariant and a message");
  }
  if (r.version !== undefined && typeof r.version !== 'string') {
    throw new TypeError(`replay: the line's version must be a string, got ${describe(r.version)}`);
  }
  return {
    seed: r.seed,
    mode: r.mode,
    plan: r.plan as FaultPlan,
    ...(r.untilMs === undefined ? {} : { untilMs: r.untilMs }),
    ...(r.plant === undefined ? {} : { plant: r.plant as Plant }),
    ...(v === undefined
      ? {}
      : { violation: { invariant: v.invariant as string, message: v.message as string } }),
    ...(r.version === undefined ? {} : { version: r.version }),
  };
}

// Base64url with no padding, over a string whose characters are all below 256.
function toBase64Url(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i);
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) : 0;
    const n = (a << 16) | (b << 8) | c;
    out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63);
    if (i + 1 < text.length) out += ALPHABET.charAt((n >> 6) & 63);
    if (i + 2 < text.length) out += ALPHABET.charAt(n & 63);
  }
  return out;
}

function fromBase64Url(text: string): string {
  if (text.length % 4 === 1) throw new TypeError('not base64url');
  let out = '';
  for (let i = 0; i < text.length; i += 4) {
    const chunk = text.slice(i, i + 4);
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const k = j < chunk.length ? ALPHABET.indexOf(chunk.charAt(j)) : 0;
      n = (n << 6) | k;
    }
    out += String.fromCharCode((n >> 16) & 255);
    if (chunk.length > 2) out += String.fromCharCode((n >> 8) & 255);
    if (chunk.length > 3) out += String.fromCharCode(n & 255);
  }
  return out;
}
