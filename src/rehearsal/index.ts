// The /rehearsal entry point (milestone 5): deterministic simulation testing of a whole cluster in
// one process. Any runtime (decision 0004).

export type { NetworkMode } from './network.js';
export { StallError } from './loop.js';
export type {
  CutFault,
  DelayFault,
  DiskFault,
  DriftFault,
  DuplicateFault,
  Fault,
  FaultKind,
  FaultOptions,
  FaultPlan,
  JoinFault,
  JumpFault,
  KillFault,
  LeaveFault,
  LoseFault,
  PartitionFault,
  PauseFault,
  ReorderFault,
  ResetFault,
} from './plan.js';
export type {
  CompleteEntry,
  DatabaseEntry,
  EventEntry,
  FaultEntry,
  History,
  HistoryEntry,
  InvokeEntry,
  JournalEntry,
  JournalEvent,
  RunEntry,
  SendEntry,
  StartEntry,
  StopEntry,
} from './history.js';
export {
  invariants,
  type AcknowledgedWrite,
  type AcknowledgedWritesOptions,
  type FailoverOptions,
  type Invariant,
  type NoStaleReadsOptions,
  type RecoversOptions,
  type Violation,
} from './invariants.js';
export {
  rehearse,
  replay,
  type Failure,
  type RehearsalReport,
  type RehearseOptions,
  type Replayed,
  type SeedResult,
} from './rehearse.js';
export type { Shrunk } from './shrink.js';
export {
  scenario,
  type Chance,
  type EntityHandle,
  type Run,
  type RunOptions,
  type Scenario,
  type ScenarioCluster,
  type ScenarioOptions,
  type SetupContext,
  type SetupResult,
  type WorkloadContext,
} from './scenario.js';
