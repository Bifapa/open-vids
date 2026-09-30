/**
 * Batches on one project run one at a time: each is a read-modify-write of the same composition file. Shared by the
 * editing route and Build Story, which both write compositions.
 */
const queues = new Map<string, Promise<unknown>>();

export function serializedEdits<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
  const settled = run.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}
