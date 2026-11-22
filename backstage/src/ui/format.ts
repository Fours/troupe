// Words and numbers for the panels. No React, so the store's tests can use it too.

import type { WireValue } from '@kylewillett/troupe/backstage';

/**
 * A system time for people. Virtual time starts at 0, so small values are shown as time since
 * the start, m:ss.t. Anything past 2001 is a wall clock, shown as the time of day.
 */
export function formatTime(ms: number): string {
  if (ms > 1e12) return new Date(ms).toLocaleTimeString();
  const tenths = Math.floor(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${String(minutes)}:${seconds.toFixed(1).padStart(4, '0')}`;
}

/** A duration for people: whole ms below a second, else seconds to one place. */
export function formatDuration(ms: number): string {
  return ms < 1_000 ? `${String(Math.round(ms))} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

/** The last part of an actor's path. */
export const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Whether `key` is one of the encoder's markers, such as `$ref`. A user's own key starting with
 * `$` arrives with one more, as `$$`.
 */
export const isMarkerKey = (key: string): boolean => key.startsWith('$') && !key.startsWith('$$');

/** A user's key as they wrote it: the encoder's escape taken off. */
export const unescapeKey = (key: string): string => (key.startsWith('$$') ? key.slice(1) : key);

/** What a marker object means, in a few words, or `undefined` if `value` isn't one. */
export function describeMarker(value: WireValue): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, WireValue>>;
  const keys = Object.keys(record);
  if (keys.length === 0 || !keys.every(isMarkerKey)) return undefined;
  const { $ref, $error, $value, $cycle, $string, $truncated } = record;
  if (typeof $ref === 'string') return `→ ${$ref}`;
  if (typeof $error === 'object' && $error !== null && !Array.isArray($error)) {
    const { name = null, message = null } = $error as Readonly<Record<string, WireValue>>;
    return `${plain(name)}: ${plain(message)}`;
  }
  if (typeof $value === 'string') return $value;
  if ($cycle === true) return 'cycle';
  if (typeof $string === 'string') return `"${$string}…" (+${plain($truncated ?? null)})`;
  if (typeof $truncated === 'number') return `… ${String($truncated)} more`;
  return undefined;
}

/** A string as it is, anything else summarized. */
const plain = (value: WireValue): string => (typeof value === 'string' ? value : summarize(value));

/**
 * A one-line summary of a message, for the message list: compact, keys without quotes, refs as
 * arrows, cut at `max` characters.
 */
export function summarize(value: WireValue, max = 80): string {
  let out = '';
  const write = (v: WireValue): boolean => {
    if (out.length > max) return false;
    const marker = describeMarker(v);
    if (marker !== undefined) {
      out += typeof (v as { $ref?: unknown }).$ref === 'string' ? `→${nameOf(marker)}` : marker;
    } else if (v === null || typeof v !== 'object') {
      out += typeof v === 'string' ? `"${v}"` : String(v);
    } else if (Array.isArray(v)) {
      out += '[';
      (v as readonly WireValue[]).forEach((item, i) => {
        if (i > 0) out += ', ';
        write(item);
      });
      out += ']';
    } else {
      out += '{';
      Object.entries(v).forEach(([key, item], i) => {
        if (i > 0) out += ', ';
        out += `${isMarkerKey(key) ? key : unescapeKey(key)}: `;
        write(item);
      });
      out += '}';
    }
    return out.length <= max;
  };
  write(value);
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
