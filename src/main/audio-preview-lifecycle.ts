/** Wait for every already-owned preview task without allowing one failure to skip shutdown cleanup. */
export async function settleAudioPreviewWork(
  refreshTask: Promise<unknown> | undefined,
  buildTasks: Iterable<Promise<unknown>>,
): Promise<void> {
  const tasks = new Set(buildTasks);
  if (refreshTask) tasks.add(refreshTask);
  if (tasks.size) await Promise.allSettled(tasks);
}
