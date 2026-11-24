// The shows at festival night, on their own and importing nothing, so scripts that run without a
// build, such as scripts/cluster-smoke.ts, can read them without loading the package from dist/.

/** The shows the crowd buys seats at. Entity ids, so actor names. */
export const SHOWS = [
  'hamlet',
  'macbeth',
  'othello',
  'king-lear',
  'the-tempest',
  'twelfth-night',
  'as-you-like-it',
  'much-ado',
  'the-seagull',
  'uncle-vanya',
  'three-sisters',
  'the-cherry-orchard',
] as const;
