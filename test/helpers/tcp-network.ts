// The test cluster's nodes on real TCP over loopback (milestone 4, T3): the same names as on the
// in-memory network, each given a free port. Remoting still runs on the ManualScheduler, so
// virtual time drives its timers while frames take the real network. `quiet` says when nothing
// is on its way, by pairing each connection with its other end by port and comparing the frames
// each side wrote with those the other read, so settle can wait for the network as well as the
// actors.

import { createServer } from 'node:net';
import type { Transport } from '../../src/cluster/transport.js';
import { openTcpTransport, type TcpConnection, type TcpNode } from '../../src/node/cluster/tcp.js';
import type { TestNetwork } from './cluster.js';

/** The secret every test node shares. */
export const TEST_SECRET = 'test-secret';

/**
 * `count` different ports nothing listens on now, on 127.0.0.1. Every server stays open until all
 * are bound: the OS may hand a port it just freed straight back, so ports asked for one at a time,
 * each closed before the next, can repeat (CI saw two nodes given the same port).
 */
export async function freePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  try {
    return await Promise.all(
      servers.map(
        (server) =>
          new Promise<number>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
              const bound = server.address();
              if (typeof bound !== 'object' || bound === null) reject(new Error('no port'));
              else resolve(bound.port);
            });
          }),
      ),
    );
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server.listening) resolve();
            else
              server.close(() => {
                resolve();
              });
          }),
      ),
    );
  }
}

/** A port nothing listens on now, on 127.0.0.1. */
export async function freePort(): Promise<number> {
  const [port] = await freePorts(1);
  if (port === undefined) throw new Error('no port');
  return port;
}

/** A network of TCP transports on loopback, with ports for up to `size` names. */
export async function tcpTestNetwork(
  size = 10,
): Promise<TestNetwork & { node(name: string): TcpNode }> {
  const ports = await freePorts(size);
  const byName = new Map<string, number>();
  const live = new Map<string, TcpNode>();
  const all: TcpNode[] = [];

  const port = (name: string): number => {
    let p = byName.get(name);
    if (p === undefined) {
      p = ports[byName.size];
      if (p === undefined) throw new Error(`tcpTestNetwork: no port left for ${name}`);
      byName.set(name, p);
    }
    return p;
  };

  return {
    real: true,
    address: (name) => `127.0.0.1:${String(port(name))}`,
    transport(name): Transport {
      if (live.has(name)) throw new Error(`tcpTestNetwork: ${name} already has a live transport`);
      const node = openTcpTransport({ port: port(name), secret: TEST_SECRET });
      live.set(name, node);
      all.push(node);
      const close = () => node.transport.close();
      return {
        ...node.transport,
        close: () => {
          if (live.get(name) === node) live.delete(name);
          return close();
        },
      };
    },
    node(name) {
      const node = live.get(name);
      if (node === undefined) throw new Error(`tcpTestNetwork: ${name} has no live transport`);
      return node;
    },
    kill(name) {
      const node = live.get(name);
      if (node === undefined) return;
      live.delete(name);
      node.kill();
    },
    quiet() {
      const ends = new Map<string, TcpConnection>();
      for (const node of all) {
        for (const c of node.connections) {
          // Dialing, proving, or closed with its close not yet heard: something is on its way.
          if (c.state !== 'open') return false;
          const socket = c.socket;
          if (socket?.localPort === undefined || socket.remotePort === undefined) return false;
          ends.set(`${String(socket.localPort)}>${String(socket.remotePort)}`, c);
        }
      }
      for (const [key, c] of ends) {
        const [local, remote] = key.split('>');
        const other = ends.get(`${remote as string}>${local as string}`);
        if (other === undefined || other.received !== c.sent || c.received !== other.sent) {
          return false;
        }
      }
      return true;
    },
    async close() {
      await Promise.all([...live.values()].map((node) => node.transport.close()));
      live.clear();
    },
  };
}
