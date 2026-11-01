import { logError, type Logger } from '../logger.js';

/**
 * With the given probability, starts `task` without waiting for it (the request
 * never pays for it) and logs its failure as `event`. Returns the started task,
 * which never rejects, so tests can await it; undefined when it was not drawn.
 */
export function maybeRunInBackground(options: {
  probability: number;
  random: () => number;
  task: () => Promise<unknown>;
  logger: Logger;
  event: string;
}): Promise<void> | undefined {
  if (options.random() >= options.probability) return undefined;
  return options.task().then(
    () => undefined,
    (error: unknown) => logError(options.logger, options.event, error),
  );
}
