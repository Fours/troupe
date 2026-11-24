// Tells festival night's story from `docker compose logs`, in plain words (story.ts).
// `npm run cluster:logs` runs it, following the cluster's log:
//
//   docker compose -f docker-compose.cluster.yml logs -f -t --no-color | node examples/cluster/narrate.ts
//
// It needs the timestamps (-t), so the history it reads at the start keeps its real timing.
import { createInterface } from 'node:readline';
import { parseComposeLine } from './compose.ts';
import { Story } from './story.ts';

const story = new Story();
for await (const raw of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const line = parseComposeLine(raw);
  if (line === undefined) continue;
  for (const sentence of story.read(line.service, line.text, line.at)) {
    process.stdout.write(`${sentence}\n`);
  }
}
