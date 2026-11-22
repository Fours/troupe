# 0020. Message events are opt-in per subscriber, and the sender is best-effort

- **Status:** Accepted
- **Date:** 2026-11-22
- **Milestone:** 3

## Context

Backstage needs to see messages: when each goes into a mailbox, how long it waits, how long it takes, and who sent it. Milestone 1 left message-level events for this milestone. They sit on the hot path of every message, though, and most systems will never look at them. The benchmark ([0019](0019-how-the-benchmark-measures.md)) put ping-pong without yields at about 4.6 million messages a second, so even an allocation per message would show. Knowing the sender is the other hard part. The `tell` signature can't change, since milestone 4's remote refs implement `ActorRef`, and the core has no `AsyncLocalStorage`, because it runs in every runtime ([0004](0004-runtime-agnostic-core.md)).

## Decision

- **Two public `SystemEvent` variants.** `delivered` is published as a message goes into a mailbox, with a per-system `id`, the message, the mailbox's depth after it went in, and `from` when the sender is known. `processed` is published when the handler settles, async work included, with the same `id`, the scheduler time it took, the depth when the message came out, and whether the handler returned a different state object.
- **Opt-in per subscriber.** `events.subscribe(listener, { messages: true })` asks for them. Other listeners never see them. The bus keeps a second list of message listeners. Each cell checks one boolean before building anything, so while no listener has asked, a message costs that check and nothing else: no wrapper, no id, no event object.
- **Every event takes a `seq`.** Every published event takes the next `seq`, so a listener without messages sees gaps while one with them is attached. `seq` orders events. It no longer counts them, and its TSDoc says so.
- **Every `delivered` ends exactly once,** so a UI can track each message by `id`:
  - with a `processed`, including when the handler throws or rejects, or a `pipeToSelf` mapper throws. The `processed` comes before the `failed`.
  - with a `deadLetter` carrying the same `id`, when a stop drains the message from the mailbox. `deadLetter` gains an optional `id` for this.
  - with a `processed` that has `skipped: true`, for a timer message whose timer was cancelled after it was queued, whether it's taken or drained. These used to vanish without an event.
- **A message is tracked from the moment it goes in.** While message events are on, the cell wraps each mailbox item with its id. One that went in before anyone asked has no `delivered`, so it gets no `processed` either. One that went in while someone was listening still gets its `processed` if they've left, as long as some listener still wants messages.
- **The sender is best-effort.** While message events are on, the dispatcher keeps the runnable whose turn it is. A cell's turn is the only code that runs inside a drain, so this covers `initial`, `receive`, `onSignal` and `pipeToSelf` mappers. Outside a turn, a cell sets an override on its host around the code it runs once an awaited handler settles, which is where a `preRestart` or `postStop` after an async failure runs. A tell after an `await`, from a timer or from outside any actor has no `from`. Persistent actors run their effect steps and `recoveryCompleted` after recovery's or the append's `await`, so they go through an internal `asSender` hook that sets it.
- **Only mailbox messages get these events:** `tell`s, timer messages and `pipeToSelf` results. Signals are already visible as `stopped`, `failed`, `restarted` and `terminated`. Replies to an ask's temporary ref aren't either, since that ref isn't an actor and has no mailbox ([0009](0009-ask-is-a-temporary-ref.md)).
- **`message` is the object itself.** Encoding it for a wire is Backstage's job (T3), not the core's.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Message events for every subscriber, as other events are | Every system would pay for them. Every existing listener, the testkit's included, would see millions of events it never asked for |
| A system option, such as `createActorSystem({ messageEvents: true })` | It has to be chosen before the system starts, so you can't attach an inspector to a running system. It also wouldn't turn off again when the inspector leaves. Per subscriber, the cost follows whoever is actually watching |
| Private events that only Backstage sees | Tests, logging and later tracing want the same events. The opt-in already keeps them free for everyone else (open question 7) |
| An explicit sender, `tell(msg, { from })` | It changes the `ActorRef` interface that milestone 4's remote refs implement, and puts the work on every caller (open question 6) |
| No sender | Backstage would lose its message-flow view. Most handlers send before they await, so best-effort covers most sends |
| `AsyncLocalStorage` to follow the sender across `await` | Node only. The core runs in browsers too, which the demo depends on ([0004](0004-runtime-agnostic-core.md)) |
| Each cell saving and restoring a sender slot on its host around its turn | It was the first cut, and it cost about 3% of ping-pong with nobody watching (see Evidence). The dispatcher already knows whose turn it is |
| Setting the sender around each handler call | A `try`/`finally` per message, for the same answer |
| A parallel queue of ids beside the mailbox | It needs a push for every message, events on or off, to stay aligned. Wrapping only while events are on costs nothing while they're off |

## Evidence

**Tests (T2, 2026-11-22).**

- `test/message-events.test.ts` covers:
  - ids and depths through a burst
  - timer and pipe messages, and no events for `initial` or signals
  - `durationMs` across an async handler under virtual time
  - `stateChanged`
  - the opt-in: a spy on the bus shows that nothing is built or numbered with no message subscriber, or after the last one unsubscribes, and a plain subscriber sees `seq` gaps
  - `from` in `initial`, `receive`, `onSignal`, a `preRestart` and `postStop` after an async failure, `thenReply` and `recoveryCompleted`, and its absence after an `await`, from outside and from a timer
  - each way a `delivered` ends
- `test/determinism.test.ts` replays milestone 1's scenario with a message subscriber to identical events. It also checks that the lifecycle events are the same with or without one, `seq` aside.
- Each key behaviour was broken in turn and a test failed (listed in commit 8d535be).

**What a piped ask's result names.** A piped ask's result is queued the moment the reply is told ([0010](0010-piped-asks-stay-on-the-scheduler.md)), so its `delivered` names the actor that replied as `from`. That's the actor that caused it, so it's left that way, and a test pins it.

**Benchmark (T2, 2026-11-22).** Apple M5 Pro, the same machine as the baseline. `npm run bench -- --only events,ping-pong-noyield --out docs/decisions/data/0020-message-events-node<N>-2026-11-22 --compare docs/decisions/data/0019-baseline-node<N>-2026-11-22`, on commit 921fd59, on Node 22.23.5, 24.22.3 and 26.12.1. Medians of 10 runs in msg/s, with the range, against [0019's baseline](data/0019-baseline-node24-2026-11-22/):

| Scenario | Node 22 | Node 24 | Node 26 |
| --- | --- | --- | --- |
| `events-none`, baseline | 4,534,862 (4,242,669–4,684,046) | 4,692,937 (4,393,376–4,797,594) | 4,642,459 (3,936,162–4,780,642) |
| `events-none`, T2 | 4,356,377 (4,153,085–4,455,993) | 4,412,439 (4,216,163–4,585,967) | 4,274,425 (3,995,715–4,564,825) |
| `events-plain`, T2 | 4,206,250 | 4,432,083 | 4,344,139 |
| `events-messages`, T2 | 2,539,255 (2,355,528–2,595,056) | 2,621,023 (2,519,897–2,763,411) | 2,595,987 (2,409,349–2,667,505) |

Raw data: [Node 22](data/0020-message-events-node22-2026-11-22/), [Node 24](data/0020-message-events-node24-2026-11-22/), [Node 26](data/0020-message-events-node26-2026-11-22/).

- **With no message subscriber, ping-pong is within the baseline's spread.** `events-none`'s median lands inside the recorded range on all three Node lines. That's T2's check.
- **The medians are 4 to 8% lower than the recorded ones, and most of that is the machine.** As 0019 advises, T1's code was rebuilt in a scratch worktree and run alternately with T2's on Node 24 in the same sitting. In three rounds of 10 runs, T1 gave 4,480,788, 4,591,535 and 4,587,517 msg/s for `events-none`, and T2 gave 4,485,731, 4,424,988 and 4,485,358: 0 to 4% lower, about 2% on average. T1's code, rerun the same day, was itself about 3% under its recorded median. `events-plain` on Node 24 lands 0.6% under its range, for the same reason. Its listener sees no events once the actors are spawned, so it runs the same path as `events-none`.
- **With a message subscriber, ping-pong runs at about 56% of the speed.** Each message builds two events, takes two `seq`s and calls the listener twice. That's what watching costs, and only while someone watches.
- **The first cut cost 7%, and the hot path's shape is why.** Alternated in the same way against T1, the first version of this change was 7 to 10% slower with no subscriber (4,256,626 and 4,270,118 against 4,568,133 and 4,588,072 msg/s). Three changes, each measured on its own, brought it back:
  - Each cell had saved, set and restored a sender slot on its host every turn. Moving that to one write on the dispatcher won back about half. The write happens only while message events are on, since storing a pointer every turn pays a GC write barrier.
  - `#invoke` with tracking branches grew past what V8 would inline. Tracked messages now get their own copy, `#invokeTracked`.
  - `#receive` stays one function. Splitting the untracked path into a wrapper and a `#handle` cost about 3% by itself.
  - Skipping the `instanceof Tracked` check while the mailbox holds no tracked items made no measurable difference. It's kept, since it costs one integer compare.
  - Swapping T1's compiled `cell.js` into T2's build closed the gap to noise, which is how the cost was traced to the cell.

## Consequences

- A system that nobody watches pays about 2% of ping-pong throughput for this, within the benchmark's noise. One that's watched runs at about 56%.
- The cell's message path is now shaped for V8's inliner: one `#receive`, and separate tracked copies of what the untracked path runs. A change there should be measured side by side with the commit before it, as this one was.
- A listener can't count events by `seq` any more. Nothing in the repo did.
- `from` can be missing for a message an actor did send, after an `await`. The UI has to treat it as optional, and the docs say so.
- An event listener that calls `tell` during a cell's turn makes that cell the `from`. That's true in a sense, since the cell's code led to the send, and it's rare.
- `SystemEvent` gained variants, so an exhaustive `switch` over it in user code must handle `delivered` and `processed`. The example's narrator does. This is a source-level change, and it's fine while the package is unpublished.
- Milestone 4 can send these events from another node as they are: paths and numbers, plus the message, which T3's encoder makes JSON.
