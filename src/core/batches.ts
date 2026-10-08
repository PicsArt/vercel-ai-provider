import { PicsartInputError } from './errors';

export function planBatches(n: number, allowedCounts?: number[]): number[] {
  if (!Number.isInteger(n) || n < 1) throw new PicsartInputError('n', `n must be a positive whole number, got ${n}.`);
  if (!allowedCounts || allowedCounts.length === 0) return Array.from({ length: n }, () => 1);
  const counts = [...new Set(allowedCounts)].filter((count) => Number.isInteger(count) && count > 0).sort((a, b) => b - a);
  const batches: Array<number | undefined> = [0];
  const last: number[] = [];
  for (let total = 1; total <= n; total += 1) {
    for (const count of counts) {
      const previous = total - count >= 0 ? batches[total - count] : undefined;
      const current = batches[total];
      if (previous !== undefined && (current === undefined || previous + 1 < current)) {
        batches[total] = previous + 1;
        last[total] = count;
      }
    }
  }
  if (batches[n] === undefined) {
    const allowed = [...counts].reverse().join(', ');
    throw new PicsartInputError('n', `This model makes batches of ${allowed}; ${n} can't be made from them.`);
  }
  const plan: number[] = [];
  for (let total = n; total > 0; total -= last[total]) plan.push(last[total]);
  return plan.sort((a, b) => b - a);
}
