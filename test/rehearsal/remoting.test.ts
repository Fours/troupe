import { remotingSuite } from '../cluster/remoting-suite.js';

// Milestone 5, T2: remoting on the simulated network with no faults (decision 0035), as on the
// in-memory network and TCP. The suite's timings assume a fixed 1 ms latency, so it runs on that.
// network.test.ts runs remoting on the default, drawn latency.
remotingSuite('simulated', { simulated: { latencyMs: [1, 1] } });
