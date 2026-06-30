// M0.5 通用 worker 池:小而稳定的并发原语,供编排器/评测调度复用。

export interface WorkerPoolOptions {
  concurrency: number;
  shouldStop?: () => boolean;
}

export interface WorkerPoolResult<R> {
  results: R[];
  stopped: boolean;
}

export async function runWorkerPool<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R | undefined>,
  opts: WorkerPoolOptions,
): Promise<WorkerPoolResult<R>> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency));
  const results: R[] = [];
  let next = 0;
  let stopped = false;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      if (opts.shouldStop?.()) {
        stopped = true;
        break;
      }
      const index = next;
      next += 1;
      const result = await worker(items[index], index);
      if (result !== undefined) results.push(result);
    }
  });

  await Promise.all(workers);
  return { results, stopped };
}
