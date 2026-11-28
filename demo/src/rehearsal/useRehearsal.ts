import { useCallback, useEffect, useRef, useState } from 'react';
import type { FaultPlan, NetworkMode } from '@kylewillett/troupe/rehearsal';
import type { Drawing } from './domain/drawing.ts';
import type { FromRunner, ToRunner } from './domain/runner.ts';

/** How the seeds are going, as the worker last said. */
export type Progress = Extract<FromRunner, { t: 'progress' }>;

/** A drawing the page asked for: on its way, drawn, or failed. */
export type Requested =
  | { readonly state: 'running' }
  | { readonly state: 'drawn'; readonly drawing: Drawing }
  | { readonly state: 'failed'; readonly message: string };

/**
 * The page's worker, made in the effect, so React's strict-mode double run makes and ends a whole
 * one. Seeds run there, and runs are drawn there on request; the page only draws what comes back.
 */
export function useRehearsal() {
  const worker = useRef<Worker | undefined>(undefined);
  const [progress, setProgress] = useState<Progress | undefined>(undefined);
  const [requested, setRequested] = useState<Readonly<Record<string, Requested>>>({});
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    w.onmessage = (e: MessageEvent<FromRunner>) => {
      const m = e.data;
      switch (m.t) {
        case 'progress':
          setProgress(m);
          break;
        case 'drawn':
          setRequested((r) => ({ ...r, [m.id]: { state: 'drawn', drawing: m.drawing } }));
          break;
        case 'failed': {
          const { id, message } = m;
          if (id === undefined) setError(message);
          else setRequested((r) => ({ ...r, [id]: { state: 'failed', message } }));
          break;
        }
      }
    };
    w.onerror = (e) => {
      setError(e.message);
    };
    return () => {
      w.terminate();
      worker.current = undefined;
    };
  }, []);

  const send = (m: ToRunner) => worker.current?.postMessage(m);
  const start = useCallback((mode: NetworkMode, from: number) => {
    setError(undefined);
    send({ t: 'start', mode, from });
  }, []);
  const stop = useCallback(() => {
    send({ t: 'stop' });
  }, []);
  const request = useCallback((id: string, mode: NetworkMode, seed: number, plan?: FaultPlan) => {
    setRequested((r) => ({ ...r, [id]: { state: 'running' } }));
    send(plan === undefined ? { t: 'draw', id, mode, seed } : { t: 'draw', id, mode, seed, plan });
  }, []);

  return { progress, requested, error, start, stop, request };
}
