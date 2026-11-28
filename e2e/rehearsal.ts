// What the Rehearsal page's tests share.
import { expect, type Locator } from '@playwright/test';

/** Checks every lane sits beside its label: their middles within a few pixels. */
export async function expectLanesAligned(run: Locator): Promise<void> {
  const middles = (selector: string): Promise<number[]> =>
    run.locator(selector).evaluateAll((els) =>
      els.map((el) => {
        const box = el.getBoundingClientRect();
        return box.top + box.height / 2;
      }),
    );
  const labels = await middles('.lane-label');
  const lanes = await middles('.lane-plot');
  expect(lanes).toHaveLength(labels.length);
  labels.forEach((label, i) => {
    expect(Math.abs(label - (lanes[i] ?? Infinity))).toBeLessThan(4);
  });
}
