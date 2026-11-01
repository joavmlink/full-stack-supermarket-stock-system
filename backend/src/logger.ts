export type LogFields = Record<string, unknown>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

type Level = 'info' | 'error';
type Write = (line: string) => void;

/** A JSON logger: one line per event, with no dependencies. */
export function createLogger(
  write: Record<Level, Write> = {
    info: (line) => process.stdout.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
  },
): Logger {
  const log = (level: Level, event: string, fields: LogFields = {}) => {
    write[level](JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }));
  };
  return {
    info: (event, fields) => log('info', event, fields),
    error: (event, fields) => log('error', event, fields),
  };
}

export const silentLogger: Logger = { info: () => {}, error: () => {} };

/** Name, message, stack and (for system and Postgres errors) code of any thrown value. */
export function serializeError(error: unknown): LogFields {
  if (!(error instanceof Error)) return { name: 'NonError', message: String(error) };
  const fields: LogFields = { name: error.name, message: error.message, stack: error.stack };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') fields.code = code;
  return fields;
}

/** The single helper used to record every error, including startup failures. */
export function logError(logger: Logger, event: string, error: unknown, fields: LogFields = {}): void {
  logger.error(event, { ...fields, error: serializeError(error) });
}
