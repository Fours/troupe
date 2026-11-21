import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleLogger, isLogger, safeLogger, silentLogger } from '../src/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('consoleLogger', () => {
  it('writes at its level and above, to the matching console method', () => {
    const spies = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
    const log = consoleLogger('info');
    log.debug('d');
    log.info('i', { n: 1 });
    log.warn('w');
    log.error('e');
    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalledWith('[troupe] i', { n: 1 });
    expect(spies.warn).toHaveBeenCalledWith('[troupe] w');
    expect(spies.error).toHaveBeenCalledWith('[troupe] e');
  });

  it('defaults to warn', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = consoleLogger();
    log.info('quiet');
    log.warn('loud');
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('rejects an unknown level', () => {
    expect(() => consoleLogger('verbose' as never)).toThrow(/got "verbose"/);
  });
});

describe('silentLogger', () => {
  it('discards everything', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    silentLogger.error('nothing');
    expect(spy).not.toHaveBeenCalled();
    expect(isLogger(silentLogger)).toBe(true);
  });
});

describe('safeLogger', () => {
  it('swallows a logger that throws', () => {
    const throwing = {
      debug: () => {
        throw new Error('x');
      },
      info: () => {
        throw new Error('x');
      },
      warn: () => {
        throw new Error('x');
      },
      error: () => {
        throw new Error('x');
      },
    };
    const log = safeLogger(throwing, { path: '/user/a' });
    expect(() => {
      log.error('fine');
    }).not.toThrow();
  });

  it('adds its fields, letting entry fields win', () => {
    const entries: unknown[] = [];
    const inner = { ...silentLogger, info: (msg: string, f?: unknown) => entries.push([msg, f]) };
    const log = safeLogger(inner, { path: '/user/a', n: 0 });
    log.info('one', { n: 1 });
    log.info('two');
    expect(entries).toEqual([
      ['one', { path: '/user/a', n: 1 }],
      ['two', { path: '/user/a', n: 0 }],
    ]);
  });
});

describe('isLogger', () => {
  it('needs all four methods', () => {
    expect(isLogger(null)).toBe(false);
    expect(isLogger('log')).toBe(false);
    expect(isLogger({ debug() {}, info() {}, warn() {} })).toBe(false);
  });
});
