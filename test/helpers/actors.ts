import { actor } from '../../src/actor.js';
import type { ActorDef, AnyRef } from '../../src/types.js';

/** An actor shape for hierarchy tests: spawns its children, and logs its postStop. */
export interface Node {
  readonly name: string;
  readonly children?: readonly Node[];
  /** Makes postStop async, logging once it has finished. */
  readonly asyncStop?: boolean;
}

/**
 * @param refs Optional. Collects every descendant's ref by path, since children are otherwise
 * private to their parent.
 */
export function tree(
  node: Node,
  log: string[],
  refs?: Map<string, AnyRef>,
): ActorDef<string, null> {
  return actor<string, null>({
    initial: (ctx) => {
      for (const child of node.children ?? []) {
        const ref = ctx.spawn(tree(child, log, refs), child.name);
        refs?.set(ref.path, ref);
      }
      return null;
    },
    receive: (s, msg) => {
      log.push(`${node.name} got ${msg}`);
      return s;
    },
    onSignal: async (s, signal) => {
      if (signal.type !== 'postStop') return s;
      if (!node.asyncStop) {
        log.push(`${node.name} postStop`);
        return s;
      }
      log.push(`${node.name} postStop started`);
      await Promise.resolve();
      log.push(`${node.name} postStop done`);
      return s;
    },
  });
}

/** An actor that watches whatever ref it's sent, and logs each terminated signal it gets. */
export function watcher(log: string[]): ActorDef<{ watch: AnyRef } | { unwatch: AnyRef }, null> {
  return actor<{ watch: AnyRef } | { unwatch: AnyRef }, null>({
    initial: null,
    receive: (s, msg, ctx) => {
      if ('watch' in msg) ctx.watch(msg.watch);
      else ctx.unwatch(msg.unwatch);
      return s;
    },
    onSignal: (s, signal) => {
      if (signal.type === 'terminated') {
        log.push(
          'failure' in signal
            ? `watcher saw ${signal.ref.path} fail: ${String(signal.failure)}`
            : `watcher saw ${signal.ref.path}`,
        );
      }
      return s;
    },
  });
}

/** An actor that does nothing. */
export const idle = actor<never, null>({ initial: null, receive: (s) => s });
