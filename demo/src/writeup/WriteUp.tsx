// The design write-up (milestone 3, T8): the decision records told as one story, in the order a
// reader needs it, with the benchmark's numbers as charts. The data comes in as a prop, read from
// docs/decisions/data/ when the site builds, so every number here is the one the records quote.
// Every claim cites its record with <Record>, and test/demo/records.test.ts checks that every
// record is cited.
import { SiteBar } from '../site/SiteBar.tsx';
import { NPM_URL, REPO_URL } from '../site/links.ts';
import { Figure, RangeChart, type ChartRow, type FigureTable } from './charts.tsx';
import { HEADLINE, NODE_LINES, type Setup, type Stat, type WriteupData } from './data.ts';
import { Record } from './Record.tsx';

const whole = (n: number) => Math.round(n).toLocaleString('en-US');
/** Short, for chart labels: 4.7M, 542k, 1,551. */
const short = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${String(Math.round(n / 1e3))}k` : whole(n);
const times = (a: number, b: number) => `${(a / b).toFixed(1)}×`;
const pct = (share: number) => `${String(Math.round(share * 100))}%`;
const range = (s: Stat) => [whole(s.median), `${whole(s.min)}–${whole(s.max)}`] as const;

const dataUrl = (folder: string) => `${REPO_URL}/tree/main/docs/decisions/data/${folder}`;

type ByLine = Readonly<{ [line: string]: Stat }>;

/** A chart row that keeps every Node line's numbers, for its figure's table. */
interface Row extends ChartRow {
  readonly stats: ByLine;
}

/** A figure's table: one row per scenario, one column per Node line. */
function byNode(rows: readonly Row[], unit: string): FigureTable {
  return {
    columns: [`Scenario, ${unit}`, ...NODE_LINES.map((line) => `Node ${line}`)],
    rows: rows.map(
      (r) => [r.label, ...NODE_LINES.map((line) => range(r.stats[line] ?? zero))] as const,
    ),
  };
}

const describe = (rows: readonly ChartRow[], format: (n: number) => string) =>
  rows.map((r) => `${r.label} ${format(r.stat.median)}`).join(', ');

const zero: Stat = { median: 0, min: 0, max: 0 };

function Source({ setup }: { setup: Setup }) {
  return (
    <>
      Source: <a href={dataUrl(setup.folder)}>{setup.folder}</a>, on an {setup.cpu} with Node{' '}
      {setup.node.replace(/^v/, '')}. Medians of 10 runs, each in a fresh process, with the lowest
      and highest run as the whisker. The table has all three Node lines, with each range under its
      median.
    </>
  );
}

const SECTIONS = [
  ['state', 'An actor is a state and a reducer'],
  ['one-at-a-time', 'One message at a time'],
  ['failure', 'When an actor fails'],
  ['ask', 'Asking, as if the actor were far away'],
  ['injected', 'Every clock and coin flip is injected'],
  ['browser', 'Why the demo runs in your browser'],
  ['event-sourcing', 'Event sourcing'],
  ['cluster', 'A cluster of nodes'],
  ['rehearsal', 'Rehearsal: a thousand bad nights'],
  ['numbers', 'The numbers'],
  ['next', 'What’s next'],
] as const;

export function WriteUp({ data }: { data: WriteupData }) {
  const b = data.baseline.scenarios;
  const e = data.events.scenarios;
  const hunt = data.rehearsal;
  // The loader fills in every line, so a miss is a bug in this page.
  const at = (stats: ByLine) => stats[HEADLINE] ?? zero;
  const m = (stats: ByLine) => at(stats).median;
  const row = (label: string, stats: ByLine, comparison = false): Row => ({
    label,
    stats,
    stat: at(stats),
    comparison,
  });
  const baselineSetup = data.baseline.setup[HEADLINE];
  const eventsSetup = data.events.setup[HEADLINE];
  const ask = data.baseline.askLatencyUs[HEADLINE];

  const pingPong = m(b['ping-pong']);
  const pingPongFree = m(b['ping-pong-noyield']);
  const fanOut = m(b['fan-out']);
  const fanOutFree = m(b['fan-out-noyield']);
  const none = m(e['events-none']);
  const plain = m(e['events-plain']);
  const watched = m(e['events-messages']);
  const pg1 = m(b['journal-postgres-1']);
  const pg100 = m(b['journal-postgres-100']);
  const pgFree = m(b['journal-postgres-100-nolock']);
  const c = data.cluster.scenarios;
  const clusterSetup = data.cluster.setup[HEADLINE];
  const failover = data.cluster.failoverMs;
  const failoverP50s = NODE_LINES.map((line) => failover[line].p50);
  const failoverWorst = Math.max(...NODE_LINES.map((line) => failover[line].max));
  const remoteAsk = data.cluster.remoteAskUs[HEADLINE];
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

  const yieldRows: Row[] = [
    row('Ping-pong', b['ping-pong']),
    row('Ping-pong, no yield', b['ping-pong-noyield'], true),
    row('Fan-out', b['fan-out']),
    row('Fan-out, no yield', b['fan-out-noyield'], true),
  ];
  const eventRows: Row[] = [
    row('Nobody listening', e['events-none']),
    row('A lifecycle listener', e['events-plain']),
    row('Message events on', e['events-messages']),
  ];
  const backendRows: Row[] = [
    row('In memory, 1 stream', b['journal-memory-1']),
    row('In memory, 100 streams', b['journal-memory-100']),
    row('SQLite, 1 stream', b['journal-sqlite-1']),
    row('SQLite, 100 streams', b['journal-sqlite-100']),
    row('Postgres, 1 stream', b['journal-postgres-1']),
    row('Postgres, 100 streams', b['journal-postgres-100']),
  ];
  const clusterRows: Row[] = [
    row('Plain refs, one process', c['ping-pong']),
    row('Entity ref, shard on this node', c['entity-tell-local']),
    row('Plain refs, across processes', c['remote-ping-pong']),
    row('Entity ref, shard on the other node', c['entity-tell-remote']),
  ];
  const lockRows: Row[] = [
    row('1 stream', b['journal-postgres-1']),
    row('100 streams', b['journal-postgres-100']),
    row('100 streams, no lock', b['journal-postgres-100-nolock'], true),
  ];
  return (
    <div className="writeup">
      <SiteBar page="how-it-works" />
      <main className="wu-main">
        <article className="wu-article">
          <header className="wu-head">
            <p className="wu-eyebrow">Design write-up</p>
            <h1>How Troupe works</h1>
            <p className="wu-lede">
              The design behind{' '}
              <a href={NPM_URL}>
                <code>@kylewillett/troupe</code>
              </a>
              , an actor framework for TypeScript. Each choice links to its decision record, which
              has the alternatives and the evidence in full.
            </p>
          </header>

          <section className="wu-summary" aria-labelledby="summary">
            <h2 id="summary">In short</h2>
            <p>
              Troupe is a toolkit for building software out of many small, independent workers
              called actors. Each actor looks after its own piece of information and deals with one
              request at a time, so two requests can never trip over each other. When an actor goes
              wrong, the actor in charge of it decides what happens next. Usually it starts again
              from a clean slate after a short pause, while everything around it carries on.
            </p>
            <p>
              An actor can also keep a diary of everything that happened to it. When it starts
              again, it reads its diary back and carries on where it left off, so a crash loses
              nothing it had written down. And Troupe never looks at the clock or rolls a dice by
              itself: it’s handed both. That’s why a whole box office can run in your browser, with
              no server, and be paused, slowed down, and played the same way twice.
            </p>
            <p>
              Actors can also be spread across several computers. Each show lives on one of them,
              and anyone can reach it by name without knowing which. When a computer dies, its shows
              start again on the others within seconds, from their diaries, and two copies of a show
              never run at once.
            </p>
            <p>
              And all of it can be rehearsed: a whole cluster, its network and its database, run a
              minute at a time inside one simulation, with crashes, cut cables and slow disks drawn
              from a single number. A million such runs found twenty bugs, every one now fixed, and
              any run can be replayed exactly.
            </p>
            <p className="wu-cta">
              <a href="../">Watch it in the demo</a>, where a box office sells out on opening night,
              crashes, and recovers. Then <a href="../cluster/">kill a node at festival night</a>,{' '}
              <a href="../rehearsal/">rehearse it in your browser</a>, or install it with{' '}
              <code>npm install @kylewillett/troupe</code>.
            </p>
          </section>

          <nav className="wu-toc" aria-label="Contents">
            <ol>
              {SECTIONS.map(([id, title]) => (
                <li key={id}>
                  <a href={`#${id}`}>{title}</a>
                </li>
              ))}
            </ol>
          </nav>

          <section id="state" aria-labelledby="state-h">
            <h2 id="state-h">An actor is a state and a reducer</h2>
            <p>
              An actor is a value and a function. <code>initial</code> is its first state, and{' '}
              <code>receive(state, msg, ctx)</code> takes the current state and one message and
              returns the next state. The framework holds the state between messages{' '}
              <Record id="0001" />.
            </p>
            <pre>
              <code>{`const counter = actor<CounterMsg, number>({
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
});`}</code>
            </pre>
            <p>
              In Akka Typed, an actor returns its next behaviour, and its state hides in closures.
              Troupe keeps state a plain value instead, because later parts of the framework need to
              read, copy and compare it. A persistent actor snapshots it, Backstage shows it, and
              the demo’s timeline replays it to any point in a show’s history. All three use this
              shape as it is, with no adapters <Record id="0001" />. An actor that changes how it
              behaves is a state machine, with a discriminated union as its state.
            </p>
            <p>
              The cost is a rule: no functions or class instances in state. Events and snapshots
              enforce it, since they’re checked as JSON values before they’re written{' '}
              <Record id="0014" />. The check is public, so a library built on Troupe can run the
              very same one on a value before it gets as far as the journal <Record id="0037" />.
            </p>
          </section>

          <section id="one-at-a-time" aria-labelledby="one-at-a-time-h">
            <h2 id="one-at-a-time-h">One message at a time</h2>
            <p>
              The actor model’s main promise is that an actor handles one message at a time, so its
              state needs no locks. TypeScript makes that easy to break: if <code>receive</code> is{' '}
              <code>async</code> and the next message ran during an <code>await</code>, two messages
              would interleave inside one actor. So a <code>receive</code> that returns a promise
              holds the actor’s mailbox until the promise settles. Other actors keep running
              meanwhile <Record id="0002" />.
            </p>
            <p>
              The price is a deadlock to know about: an actor that awaits an <code>ask</code> to an
              actor that asks it back waits until the ask times out. Work that shouldn’t hold the
              mailbox goes through <code>ctx.pipeToSelf</code>, which turns its result into a later
              message <Record id="0002" />.
            </p>
            <p>
              All of a system’s actors share one thread with I/O and timers. The dispatcher keeps a
              queue of actors with work. It wakes on a microtask, which is fast, and gives each
              actor up to 10 messages a turn before moving it to the back. After 1,000 messages in a
              row, it yields with a zero-delay timer, so actors that message each other without end
              can’t starve the event loop <Record id="0007" />. That yield turned out to set the
              pace of a busy system, as <a href="#numbers">the numbers</a> show.
            </p>
          </section>

          <section id="failure" aria-labelledby="failure-h">
            <h2 id="failure-h">When an actor fails</h2>
            <p>
              A failure is a throw or a rejected promise in an actor’s code. Something has to decide
              whether the actor stops, carries on, or starts again. In Troupe the parent chooses,
              child by child, when it spawns each one, as Akka Typed does: <code>stop</code>,{' '}
              <code>resume</code>, <code>restart</code> with a limit, or{' '}
              <code>restartWithBackoff</code>. The default is to stop, so restarting is a choice
              someone made <Record id="0006" />.
            </p>
            <pre>
              <code>{`ctx.spawn(show, 'hamlet', {
  supervision: supervise.restartWithBackoff({ minMs: 200, maxMs: 5_000 }),
});`}</code>
            </pre>
            <p>
              A restart throws the state away and runs <code>initial</code> again. The harder
              question is what else goes with it. Senders hold the actor’s ref and expect it to keep
              working, so the ref, the mailbox and the actor’s watchers carry over. Everything the
              old incarnation set up for its old state doesn’t: its children are stopped, its timers
              cancelled and its own watches dropped, and its old <code>ctx</code> goes stale.{' '}
              <code>initial</code> is then the one place an actor sets itself up, for its first
              start and every restart <Record id="0008" />.
            </p>
            <p>
              Supervision decides from the failure times as each failure happens, so neither the
              restart limit’s window nor the backoff needs a timer of its own <Record id="0006" />.
              A failure can also say how long to wait. A model call that got a 429 with a{' '}
              <code>retry-after</code> shouldn’t come back sooner, so a backoff strategy can read
              each failure for a minimum delay, and wait for that or for its own backoff, whichever
              is longer. It’s the parent’s strategy that reads it, not the actor that decides, and a
              server’s answer outranks <code>maxMs</code>, Troupe’s own guess <Record id="0041" />.
              In the demo, “Bad request” crashes <code>hamlet</code>, and you can watch it come back
              200 ms later.
            </p>
          </section>

          <section id="ask" aria-labelledby="ask-h">
            <h2 id="ask-h">Asking, as if the actor were far away</h2>
            <p>
              <code>tell</code> sends a message and returns at once. <code>ask</code> sends a
              request and returns a promise of the reply. It works by creating a temporary ref, such
              as <code>/temp/$1</code>, and passing it to the message as <code>replyTo</code>. To
              the target, an ask is just a message with somewhere to reply to, so a ref to an actor
              on another node does the same thing <Record id="0009" />.
            </p>
            <p>
              The less obvious choice is what an ask does when its target has stopped. It could fail
              at once, since locally the system knows. But a remote ref can’t know whether its
              target is alive, and code written against the faster local answer would break once the
              actor moved to another node. So an ask never fails fast. It times out, locally as it
              will remotely <Record id="0009" />. Location transparency is a rule for the whole API:
              nothing public may assume that sender and receiver share memory.
            </p>
            <p>
              The testkit needed one more piece. Piping an ask into an actor’s mailbox is the
              pattern that avoids the deadlock above, so a piped ask is delivered by the system
              itself rather than through a promise. It then runs entirely on the scheduler, and
              virtual time can settle it, timeouts included <Record id="0010" />. Work an actor
              bounds with its own timer, such as a call it cancels after a timeout, gets the same
              treatment once the actor pipes it with an abort signal. The signal aborting ends the
              pipe on the spot, so the pipe isn’t waiting on anything time can’t reach, and virtual
              time is free to move on to the timer <Record id="0038" />.
            </p>
          </section>

          <section id="injected" aria-labelledby="injected-h">
            <h2 id="injected-h">Every clock and coin flip is injected</h2>
            <p>
              Timers, ask timeouts and backoff depend on time, and backoff jitter on chance. So a
              system is handed a scheduler, with <code>now</code>, <code>runSoon</code> and{' '}
              <code>setTimer</code>, and a <code>random()</code> function, and the core uses nothing
              else. Lint fails any <code>Date.now()</code>, <code>setTimeout</code> or{' '}
              <code>Math.random()</code> in the core <Record id="0003" />.
            </p>
            <p>
              This pays off three times. Tests run on the testkit’s virtual time, so a five-second
              backoff takes no time at all and no test sleeps. A whole scenario, with timers, asks,
              crashes and backoff jitter, gives identical events every time it runs from the same
              seed, and a test proves it <Record id="0003" />. And the demo can be paused: its
              system runs on virtual time that the page moves forward from animation frames, so
              pausing stops the system itself, not just the drawing <Record id="0022" />.
            </p>
            <p>
              Journal timestamps are the one place a wall clock is needed, so people can see when
              something happened. That clock is injected too, and nothing is ordered by it: streams
              are ordered by sequence number <Record id="0015" />.
            </p>
          </section>

          <section id="browser" aria-labelledby="browser-h">
            <h2 id="browser-h">Why the demo runs in your browser</h2>
            <p>
              The demo has no backend. The core uses only what every JavaScript runtime has, and the
              build has no Node types at all, so a Node API in the core fails to compile{' '}
              <Record id="0004" />. The SQLite and Postgres journals, and the Backstage server, are
              separate entry points of the one package, so the core never loads them{' '}
              <Record id="0005" />.
            </p>
            <p>
              The page drives the system’s virtual time one due time at a time, letting promises
              settle at each, as the testkit does. Button presses queue on the same clock, so a
              night depends only on its seed and when you pressed what, not on how fast your
              computer draws frames <Record id="0022" />.
            </p>
            <p>
              Backstage, the inspector beside the demo, only watches. It attaches to a system,
              receives a stream of JSON frames, and can ask for an actor’s state or a show’s
              history, but nothing it sends changes anything. Refs travel as paths, and a show’s
              history is read from its journal, never from the live actor, so the same protocol can
              come from another node later <Record id="0021" />. To see messages, it turns on
              message events, which cost nothing while nobody asks for them <Record id="0020" />.
              The same UI attaches to a system in Node: <code>serveBackstage(system)</code> streams
              the frames as server-sent events on <code>node:http</code>, on localhost only, with no
              dependency <Record id="0023" />. And any page can put it beside its own views:{' '}
              <code>mountBackstage(element, options)</code> draws it in an element the page gives
              it, on any client, with the selection the page’s to keep. React comes inside that
              entry point, so the package still has no dependencies, and nothing else loads it{' '}
              <Record id="0045" />.
            </p>
          </section>

          <section id="event-sourcing" aria-labelledby="event-sourcing-h">
            <h2 id="event-sourcing-h">Event sourcing</h2>
            <p>
              A persistent actor doesn’t store its state. It stores what happened, as events in a
              journal, and its state is those events folded together. After a crash it replays them
              and is back where it was. Each show in the demo is one.
            </p>
            <p>
              <strong>Commands return effects.</strong> <code>onCommand</code> can’t change the
              state. It returns a value that lists the events to persist and what to do once they’re
              safe, such as replying. <code>onEvent</code> folds one event into the state, and it’s
              the only thing that can. So the state after a replay is always the state before it,
              and a client is never told “done” about a write that didn’t happen{' '}
              <Record id="0012" />.
            </p>
            <pre>
              <code>{`onCommand(state, cmd, { persist, reply }) {
  if (cmd.amount > state.balance) {
    return reply(cmd.replyTo, { ok: false, reason: 'insufficient funds' });
  }
  return persist({ type: 'withdrawn', amount: cmd.amount })
    .thenReply(cmd.replyTo, (s) => ({ ok: true, balance: s.balance }));
}`}</code>
            </pre>
            <p>
              <strong>The mailbox is the stash.</strong> While events are being written, or the
              actor is recovering, it doesn’t know its state for sure. Akka moves commands that
              arrive then into a stash. Troupe already holds the mailbox for an async{' '}
              <code>receive</code>, so persisting and recovery just hold it, and the next command
              sees the state after the last one <Record id="0011" />.
            </p>
            <p>
              <strong>Two writers.</strong> Two actors can both believe they own the same stream: a
              bug in one process, or, from milestone 4, two nodes that both think they own a shard.
              Every append says which sequence number it follows, and the journal refuses it if the
              stream has moved on. A failed append applies nothing, and a restart settles what the
              journal really holds <Record id="0013" />. On Postgres, appends also take a lock for
              the whole journal, so the offsets projections read by commit in order{' '}
              <Record id="0016" />.
            </p>
            <p>
              <strong>Events outlive code.</strong> An event written today may be replayed years
              from now by a different deployment, so events are JSON values, checked before they’re
              written, and every backend gives back exactly what it took <Record id="0014" />. Their
              shape can be checked by any Standard Schema library, such as Zod, and an old event is
              upgraded on every read by one upcaster per version step. Events are never rewritten{' '}
              <Record id="0018" />.
            </p>
            <p>
              <strong>No dependencies.</strong> The SQLite backend uses <code>node:sqlite</code>,
              which ships with Node. The Postgres backend takes your own <code>pg</code> pool, typed
              by its shape, so the package never imports a driver <Record id="0017" />.
            </p>
          </section>

          <section id="cluster" aria-labelledby="cluster-h">
            <h2 id="cluster-h">A cluster of nodes</h2>
            <p>
              Several Node processes form a cluster, and an entity, such as a show, is addressed by
              its type and ID from any of them. Its ref works the same wherever the show happens to
              live, and keeps working when it moves. Throughout, there is at most one live copy of
              each entity. The same code runs in a browser tab on an in-memory network, which is how{' '}
              <a href="../cluster/">festival night</a> runs three nodes in the page{' '}
              <Record id="0022" />.
            </p>

            <h3>Messages on the wire</h3>
            <p>
              Messages between nodes are JSON, as events are, with refs anywhere a value can go. A
              ref travels as the cluster’s name, the node’s address and its path, and an entity ref
              as just its type and ID, so it stays good after the entity moves. A message to an
              entity is encoded even when the entity is on the same node, so a message that can’t
              cross the network fails on a laptop’s one-node cluster, not in production when a shard
              happens to move <Record id="0025" />.
            </p>
            <p>
              Delivery is at most once, and in order from one node to one actor, over any transport
              that carries text. Nothing is retried: a lost connection loses what was on it, and an
              ask times out, as it always could. A remote ask settles on the scheduler, as a local
              one does <Record id="0026" />. Between processes the transport is TCP, with nothing
              but Node underneath. A node must prove it knows the cluster’s secret, without sending
              it, before it can say anything else. Nothing is encrypted, so the cluster belongs on a
              private network <Record id="0027" />.
            </p>

            <h3>Who’s in the cluster</h3>
            <p>
              Nodes find each other through a list of seeds, and gossip who’s up, leaving and down,
              with no leader. Every node checks every other with a heartbeat, and one that stays
              silent too long is marked down automatically. In Akka that’s unsafe: a node marked
              down while it’s still running would keep its shards, and two copies of an entity could
              run. Here, membership only decides where to send messages and where a shard should go.
              It never decides who owns one <Record id="0028" />. What it did cost was availability.
              When a partition cut the cluster in two, each half marked the other down, and they
              never spoke again. Now only the side with most of the members marks the rest down. A
              smaller side marks itself down and rejoins once it can, and two halves that each
              thought themselves the larger settle it the moment they meet again{' '}
              <Record id="0042" />.
            </p>

            <h3>Who owns a shard</h3>
            <p>
              Entities are grouped into shards by a hash of their ID, and a shard belongs to whoever
              holds its lease in Postgres. Postgres judges a lease’s expiry on its own clock. The
              holder lets go a margin earlier, by its own clock, timed from before it asked, so no
              two clocks ever have to agree. A node cut off from Postgres stops its shards before
              anyone else can start them <Record id="0029" />. If a node pauses past its lease and
              wakes to write once more, the journal’s sequence check refuses one of the two writes,
              so the show’s history stays one history <Record id="0013" />.
            </p>

            <h3>Where a shard goes</h3>
            <p>
              Where a shard should live is worked out, not stored. Every node scores each shard
              against each member and picks the highest, so they all agree with no coordinator, and
              a new node takes only the shards it now tops, about one in N. A shard moves only when
              its owner hands it off, after its entities have finished what they were doing, a write
              included, or when its lease runs out. A node that leaves hands every shard off first{' '}
              <Record id="0030" />.
            </p>

            <h3>When a node dies</h3>
            <p>
              Real processes found a gap that the in-memory tests hadn’t: a node killed with{' '}
              <code>kill -9</code> went on being sent messages until it was marked down, so its
              shows came back after 16 seconds. Now a node routes only to holders it can hear, and a
              dead node’s shows come back as soon as their leases run out. Over 60 kills, three
              festival-night nodes on TCP and Postgres brought a killed node’s show back in{' '}
              {sec(Math.min(...failoverP50s))} to {sec(Math.max(...failoverP50s))} at the median,
              and {sec(failoverWorst)} at worst. A shorter lease would be faster, but it would also
              take a node’s shards away after a shorter stall, so the defaults stay{' '}
              <Record id="0031" />. In process, over 200 seeds of kills, partitions, store outages,
              joins, leaves and handoffs, no two copies of an entity were ever live at once, and
              every acknowledged write was in the journal <Record id="0030" />.
            </p>

            <h3>What a hop costs</h3>
            <p>
              Encoding every message to an entity costs about a microsecond. Through an entity ref
              whose shard is on the same node, ping-pong ran at {short(m(c['entity-tell-local']))}{' '}
              messages a second, against {short(m(c['ping-pong']))} on plain refs in the same run.
              Across processes the network dwarfs it: entity refs ran at{' '}
              {short(m(c['entity-tell-remote']))} against {short(m(c['remote-ping-pong']))} for
              plain refs on TCP loopback, and a remote ask took {remoteAsk.p50.toFixed(0)} µs at the
              median <Record id="0030" />.
            </p>
            <Figure
              id="cluster-hops"
              title="Messages a second, by where the other actor is"
              description="Ping-pong with the default yields. Two processes on TCP loopback for the bottom two."
              table={byNode(clusterRows, 'msg/s')}
              source={
                <>
                  <Source setup={clusterSetup} /> Record: <Record id="0030" />.
                </>
              }
            >
              <RangeChart
                rows={clusterRows}
                format={short}
                label={`Messages a second: ${describe(clusterRows, short)}.`}
              />
            </Figure>
            <p>
              Backstage shows a cluster from the node it’s attached to: the members as that node
              sees them, a grid of who holds each shard, and the regions, shards and entities in the
              tree. It still only watches <Record id="0021" />.
            </p>
          </section>

          <section id="rehearsal" aria-labelledby="rehearsal-h">
            <h2 id="rehearsal-h">Rehearsal: a thousand bad nights</h2>
            <p>
              A cluster’s worst bugs need bad luck: a node that freezes just as its lease renews, a
              partition that heals while a handoff is halfway done. Tests that wait for bad luck on
              real machines are slow and never fail the same way twice. Troupe can do better,
              because nothing in it reads a clock or rolls a dice by itself <Record id="0003" />,
              and nothing in its core knows it’s on Node <Record id="0004" />. So Rehearsal,{' '}
              <code>@kylewillett/troupe/rehearsal</code>, runs a whole cluster inside one
              simulation, on one thread: every node, the network between them, the database behind
              them and every clock.
            </p>
            <h3>Closing time</h3>
            <p>
              A run has one simulation clock, and each node a clock of its own made from it, which
              can run fast or slow, or stop while its process is frozen. Every timer and every call
              to the network or the database resolves on that clock, so the simulation never waits
              on real time: when nothing is ready, it jumps straight to the next timer. A minute of
              festival night takes about 30 ms <Record id="0033" />. The simulated network
              partitions, resets, delays and reorders. In one mode it keeps TCP’s promises, and in
              another it breaks them, losing and repeating messages, because whether a show ever
              runs twice should depend on its lease and its journal, never on the network{' '}
              <Record id="0035" />. The simulated database can be slow, hang, fail, lose its answers
              after doing the work, or have its clock jump, and it passes the same contract tests as
              the real backends. A database that hangs meant every journal and shard store call
              needed a timeout, and a timed-out write is an unknown: it may have landed, so the
              entity starts again and reads its journal to find out <Record id="0036" />.
            </p>
            <h3>A run is a seed and a plan</h3>
            <p>
              A seed draws a plan of faults, plain data that prints, edits and shrinks: kills,
              freezes, partitions, slow disks, drifting clocks. Each part of a run draws its chance
              from a stream of its own, so removing one fault changes nothing that happened before
              it. After a run, invariants are checked against its history: no show ran twice at
              once, no sale a customer was told about was lost, no customer saw fewer sales than an
              earlier one had, and the cluster settled once the faults healed. A run that breaks one
              shrinks itself, with faults coming out and the rest getting shorter, to the smallest
              plan that still breaks it, which replays exactly from one printed line{' '}
              <Record id="0034" />. Getting there tightened a few public pieces on the way: the JSON
              check that events use is now yours to call <Record id="0037" />, a piped ask with a
              signal ends on the scheduler <Record id="0038" />, and a failure can ask for a longer
              backoff <Record id="0041" />.
            </p>
            <h3>Bugs put back on purpose</h3>
            <p>
              A check that never fails proves nothing. So bugs went back into Troupe, one at a time,
              most of them ones milestone 4 had found by hand, and Rehearsal had to find each from
              random seeds without being told where to look. It counts a seed only if the same run
              without the bug passes <Record id="0040" />.
            </p>
            <div className="wu-table-wrap">
              <table className="wu-planted" aria-label="The planted bugs">
                <thead>
                  <tr>
                    <th scope="col">Bug</th>
                    <th scope="col">Caught by</th>
                    <th scope="col">First seed</th>
                    <th scope="col">Faults, shrunk to</th>
                  </tr>
                </thead>
                <tbody>
                  {hunt.planted.map((p) => (
                    <tr key={p.plant}>
                      <th scope="row">{p.bug}</th>
                      <td>{p.invariant ?? 'nothing: harmless now'}</td>
                      <td>{p.foundAtSeed === undefined ? '–' : whole(p.foundAtSeed)}</td>
                      <td>
                        {p.faults === undefined
                          ? '–'
                          : `${String(p.faults)} → ${String(p.shrunkTo ?? 0)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              One of them, a status that gossip let go backwards, can no longer do harm: keeping the
              majority downs such a member again before anything is checked, and 10,000 seeds with
              the bug in place all passed <Record id="0043" />.
            </p>
            <h3>The hunt</h3>
            <p>
              Then Rehearsal ran against the real code: {whole(hunt.hunt.seeds)} seeds, in both
              network modes and five mixes of faults, with {whole(hunt.hunt.faults)} faults between
              them, on one {hunt.hunt.machine.split(',')[0]}. It found {hunt.found.length} bugs,
              from a cluster that split in two for good to a message that lost its place in line
              after bouncing off a stale owner, and {hunt.hunt.checkBugs} in its own checks. The
              biggest fix was a split-brain strategy: when the network splits, only the side with
              more than half the members carries on, and a smaller side stops and rejoins{' '}
              <Record id="0042" />. Every bug’s shrunk plan is now a test, and the fixed code passed
              all {whole(hunt.hunt.seeds)} seeds. The journal’s own sequence check refused{' '}
              {whole(hunt.hunt.fenced.refused)} stale writes, in {whole(hunt.hunt.fenced.seeds)}{' '}
              seeds, and none got past it, so the journal stays free of leases <Record id="0043" />.
            </p>
            <ul className="wu-list">
              {hunt.found.map((b) => (
                <li key={b.name}>
                  <strong>{b.name}.</strong> {b.what}.
                </li>
              ))}
            </ul>
            <p className="wu-cta">
              <a href="../rehearsal/">Rehearse it yourself</a>: run seeds in your browser, in a
              worker of their own so the page never stutters, and step through each planted bug’s
              recorded failing run to the moment it broke <Record id="0044" />.
            </p>
          </section>

          <section id="numbers" aria-labelledby="numbers-h">
            <h2 id="numbers-h">The numbers</h2>
            <p>
              The benchmark is a baseline for later milestones, not a race against other actor
              libraries, whose semantics differ too much for one number to mean anything. Each
              scenario ran 10 times, each run in a fresh process after warm-ups, because runs that
              shared a process shaped how V8 optimised the ones after them. Each scenario shows its
              median and its fastest and slowest run <Record id="0019" />.
            </p>
            <p>
              On its own, Troupe is quick. An <code>ask</code> takes {ask.p50.toFixed(2)} µs at the
              median and {ask.p99.toFixed(2)} µs at the 99th percentile, and a system spawns and
              stops {short(m(b['spawn-stop']))} actors a second <Record id="0019" />.
            </p>

            <h3>The yield sets the pace</h3>
            <p>
              Two actors messaging each other as fast as they can manage {short(pingPong)} messages
              a second with the default settings, and {short(pingPongFree)} with the yield out of
              reach. With the defaults, the pair spends about {pct(1 - pingPong / pingPongFree)} of
              its time waiting for the yield’s zero-delay timer, which Node holds for at least a
              millisecond. Fan-out, one actor messaging 10,000 children, waits about{' '}
              {pct(1 - fanOut / fanOutFree)} of the time <Record id="0019" />.
            </p>
            <Figure
              id="yield"
              title="Messages a second between busy actors"
              description="With the default yield every 1,000 messages, and with the yield set out of reach (hollow)."
              table={byNode(yieldRows, 'msg/s')}
              source={
                <>
                  <Source setup={baselineSetup} /> Record: <Record id="0019" />.
                </>
              }
            >
              <RangeChart
                rows={yieldRows}
                format={short}
                label={`Messages a second: ${describe(yieldRows, short)}.`}
              />
            </Figure>
            <p>
              The yield is working as designed: it’s what lets I/O and timers in while actors
              message each other without end <Record id="0007" />. But a cheaper one is the biggest
              speed-up available, and it’s an open question for a later milestone, not a change
              here. Yielding after a time budget rather than a count of messages would keep the
              fairness and lose most of the wait. Until then, <code>yieldAfter</code> is a setting a
              busy system can raise <Record id="0019" />.
            </p>

            <h3>What watching costs</h3>
            <p>
              Message events sit on the path of every message, and most systems never look at them.
              So a listener has to ask for them, and while nobody has, each message costs one check
              of a boolean. A system with an ordinary lifecycle listener ran at {short(plain)}{' '}
              messages a second against {short(none)} with none, within the noise. With message
              events on, for a listener that does nothing with them, it ran at {short(watched)},{' '}
              {pct(watched / none)} of the speed <Record id="0020" />. Backstage also encodes every
              message for the wire, which costs more again, and the benchmark doesn’t measure that
              yet <Record id="0021" />.
            </p>
            <Figure
              id="events"
              title="Messages a second, by who’s listening"
              description="Ping-pong without yields, so the cost per message shows."
              table={byNode(eventRows, 'msg/s')}
              source={
                <>
                  <Source setup={eventsSetup} /> Record: <Record id="0020" />.
                </>
              }
            >
              <RangeChart
                rows={eventRows}
                format={short}
                label={`Messages a second: ${describe(eventRows, short)}.`}
              />
            </Figure>

            <h3>Where an append goes</h3>
            <p>
              A persistent actor waits for each append before its next command <Record id="0011" />,
              so a journal’s speed is an entity’s speed. The in-memory journal manages{' '}
              {short(m(b['journal-memory-1']))} appends a second, SQLite{' '}
              {short(m(b['journal-sqlite-1']))} for one stream, and Postgres {short(pg1)}, one round
              trip after another <Record id="0017" />. The scale is logarithmic: each step is ten
              times the last.
            </p>
            <Figure
              id="backends"
              title="Appends a second, by backend"
              description="One stream appending one event at a time, and 100 streams appending in parallel. Log scale."
              table={byNode(backendRows, 'appends/s')}
              source={
                <>
                  <Source setup={baselineSetup} /> Record: <Record id="0019" />.
                </>
              }
            >
              <RangeChart
                rows={backendRows}
                format={short}
                scale="log"
                label={`Appends a second: ${describe(backendRows, short)}.`}
              />
            </Figure>

            <h3>The Postgres lock</h3>
            <p>
              A hundred Postgres streams in parallel manage only {short(pg100)} appends a second,{' '}
              {times(pg100, pg1)} one stream, because every append waits for the journal’s one lock.
              With the lock taken away and nothing else changed, the same hundred streams manage{' '}
              {short(pgFree)}, {times(pgFree, pg100)} as many <Record id="0016" />. The lock is what
              keeps projections correct, so it stays, and it’s the cluster’s ceiling too. A hundred
              shows spread over three nodes appended {short(m(c['cluster-appends-postgres']))}{' '}
              events a second, against {short(m(c['journal-postgres-100']))} for a hundred streams
              in one process in the same run: more nodes add no writes to one journal{' '}
              <Record id="0030" />. Removing the lock, with gap detection in the readers instead, is
              the change that would <Record id="0019" />.
            </p>
            <Figure
              id="lock"
              title="Postgres appends a second, with and without the journal lock"
              description="The lock ships. The run without it (hollow) is for comparison only."
              table={byNode(lockRows, 'appends/s')}
              source={
                <>
                  <Source setup={baselineSetup} /> Record: <Record id="0016" />.
                </>
              }
            >
              <RangeChart
                rows={lockRows}
                format={short}
                label={`Postgres appends a second: ${describe(lockRows, short)}.`}
              />
            </Figure>
          </section>

          <section id="next" aria-labelledby="next-h">
            <h2 id="next-h">What’s next</h2>
            <p>
              Troupe is <a href={NPM_URL}>on npm</a>, published from CI with provenance, which ties
              each release to the commit and the run that built it <Record id="0024" />. It stayed
              at 0.x until Rehearsal had tried the cluster’s interfaces against faults, and 1.0
              comes next, once every export has been reviewed <Record id="0032" />. After that, the
              roadmap’s later ideas, none of them scheduled:
            </p>
            <ul className="wu-list">
              <li>A dispatcher on worker threads, for actors that are heavy on CPU.</li>
              <li>
                OpenTelemetry tracing across <code>tell</code> and <code>ask</code>.
              </li>
              <li>Durable timers and reminders for persistent entities.</li>
              <li>Routers and pools.</li>
              <li>
                A transport from the browser to a server, so the same actors run on both ends.
              </li>
            </ul>
            <p>
              The code, the specs and every record are <a href={REPO_URL}>on GitHub</a>.
            </p>
          </section>
        </article>
      </main>
    </div>
  );
}
