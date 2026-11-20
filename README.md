# Troupe

Typed actors for TypeScript, in the spirit of Akka: hierarchies, supervision, `ask`, timers, and a testkit that runs on virtual time. Event-sourced persistent actors and cluster sharding come next.

> **Status:** early development, not published yet. See the [roadmap](docs/roadmap.md) and the [milestone 1 spec](docs/milestone-1.md).

```ts
import { actor, createActorSystem, type ActorRef } from '@kylewillett/troupe';

type CounterMsg =
  | { type: 'inc'; by: number }
  | { type: 'get'; replyTo: ActorRef<number> };

const counter = actor<CounterMsg, number>({
  initial: 0,
  receive(count, msg) {
    switch (msg.type) {
      case 'inc':
        return count + msg.by;
      case 'get':
        msg.replyTo.tell(count);
        return count;
    }
  },
});

const system = createActorSystem();
const ref = system.spawn(counter, 'counter');
ref.tell({ type: 'inc', by: 2 });
console.log(await ref.ask((replyTo) => ({ type: 'get', replyTo }))); // 2
await system.terminate();
```

## Development

```bash
npm install
npm run lint && npm run typecheck && npm test && npm run build
```

Design decisions are recorded in [docs/decisions](docs/decisions/README.md).

## License

MIT
