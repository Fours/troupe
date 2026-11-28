// Backstage for festival night: one node at a time, the one picked. A source is attached only to
// the picked node, since it turns message events on there. Picking another node, or the picked
// node starting again, connects everyone to a fresh source, which greets them with a new hello. A
// killed node's source closes, so Backstage keeps showing it as it last was.
import {
  backstage,
  type BackstageClient,
  type BackstageSource,
  type Frame,
} from '@kylewillett/troupe/backstage';
import type { FestivalNight, FestivalNode } from './festival-night.ts';

/** A {@link BackstageClient} for whichever node is picked. */
export interface NodeClient extends BackstageClient {
  /** The picked node's address. */
  readonly picked: string;
  /** Shows the node at `address` from now on. */
  pick(address: string): void;
  /** Closes the source. Every connection ends. */
  close(): void;
}

const gone = (node: FestivalNode): boolean => node.state === 'killed' || node.state === 'left';

/** Attaches Backstage to the node at `address`, and follows it as it's picked, killed or restarted. */
export function nodeClient(night: FestivalNight, address: string): NodeClient {
  const connections = new Map<(frame: Frame) => void, () => void>();
  let picked = address;
  let source: BackstageSource | undefined;
  let attachedTo: FestivalNode | undefined;
  let closed = false;

  const detach = (): void => {
    source?.close();
    source = undefined;
    attachedTo = undefined;
  };

  const attach = (node: FestivalNode | undefined): void => {
    if (closed || node === attachedTo) return;
    detach();
    if (node === undefined || gone(node)) return;
    const next = backstage(node.system);
    source = next;
    attachedTo = node;
    for (const listener of connections.keys()) connections.set(listener, next.connect(listener));
  };

  const stopNodes = night.onNode((node) => {
    if (node.address === picked) attach(node);
  });
  const stopChanges = night.onChange(() => {
    if (attachedTo !== undefined && gone(attachedTo)) detach();
  });

  return {
    get picked() {
      return picked;
    },
    pick(next) {
      picked = next;
      attach(night.node(next));
    },
    connect(listener) {
      const own = (frame: Frame) => {
        listener(frame);
      };
      connections.set(own, source?.connect(own) ?? (() => undefined));
      return () => {
        connections.get(own)?.();
        connections.delete(own);
      };
    },
    request: (req) =>
      source === undefined
        ? Promise.resolve({
            ok: false,
            error: { name: 'ClosedError', message: `${picked} is not running` },
          })
        : source.request(req),
    close() {
      closed = true;
      stopNodes();
      stopChanges();
      connections.clear();
      detach();
    },
  };
}
