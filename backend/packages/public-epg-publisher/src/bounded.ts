/** FIFO semaphore for bounded concurrent work within one publisher run. */
export class BoundedSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("bounded_semaphore_limit_invalid");
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }
}

/** Map a bounded number of items at once, stop dispatching after failure, and drain active work. */
export async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("bounded_map_limit_invalid");
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index]!, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  if (failed) throw firstError;
  return results;
}
