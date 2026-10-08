import { describe, expect, it } from 'vitest';
import { planBatches } from '../../src/core/batches';
import { PicsartInputError } from '../../src/core/errors';

describe('planBatches', () => {
  it('uses the fewest allowed batches', () => {
    expect(planBatches(3, [1, 2, 4])).toEqual([2, 1]);
    expect(planBatches(8, [4, 6])).toEqual([4, 4]);
    expect(planBatches(10, [1, 2, 4, 6, 8, 10])).toEqual([10]);
  });

  it('makes one job per item when the model has no count', () => {
    expect(planBatches(3)).toEqual([1, 1, 1]);
  });

  it('rejects counts that the allowed batches cannot make', () => {
    expect(() => planBatches(3, [2])).toThrow(PicsartInputError);
    expect(() => planBatches(0, [1])).toThrow(PicsartInputError);
  });
});

describe('planBatches at scale', () => {
  it('plans a large n with count options in linear memory and the fewest batches', () => {
    const plan = planBatches(100_000, [1, 2, 4]);
    expect(plan).toHaveLength(25_000);
    expect(plan.every((count) => count === 4)).toBe(true);
  });
});
