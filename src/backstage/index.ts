// The /backstage entry point: the inspector protocol, the wire encoding and the in-process source.
// It runs in any runtime (decision 0004). Backstage only watches (decision 0021).

export { backstage } from './source.js';
export { encode } from './encode.js';
export { PROTOCOL } from './types.js';
export type { WireValue } from './encode.js';
export type {
  ActorInfo,
  ActorStatus,
  BackstageClient,
  BackstageError,
  BackstageOptions,
  BackstageRequest,
  BackstageResponse,
  BackstageSource,
  ClusterInfo,
  EntityTypeInfo,
  Frame,
  MemberInfo,
  TimelineEvent,
  WireEvent,
} from './types.js';
