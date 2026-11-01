import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createLogger, logError, serializeError, silentLogger } from '../src/logger.js';

function capture() {
  const lines: Record<'info' | 'error', string[]> = { info: [], error: [] };
  const logger = createLogger({ info: (line) => lines.info.push(line), error: (line) => lines.error.push(line) });
  return { logger, lines };
}

describe('logger', () => {
  test('writes one JSON line per event with time, level and fields', () => {
    const { logger, lines } = capture();
    logger.info('server_started', { port: 3000 });
    logger.error('boom');
    assert.equal(lines.info.length, 1);
    const info = JSON.parse(lines.info[0]!);
    assert.equal(info.level, 'info');
    assert.equal(info.event, 'server_started');
    assert.equal(info.port, 3000);
    assert.ok(!Number.isNaN(Date.parse(info.time)));
    assert.equal(JSON.parse(lines.error[0]!).level, 'error');
  });

  test('the default writers use stdout and stderr', (t) => {
    const out = t.mock.method(process.stdout, 'write', () => true);
    const err = t.mock.method(process.stderr, 'write', () => true);
    const logger = createLogger();
    logger.info('a');
    logger.error('b');
    assert.match(String(out.mock.calls[0]?.arguments[0]), /"event":"a"/);
    assert.match(String(err.mock.calls[0]?.arguments[0]), /"event":"b"/);
  });

  test('silentLogger does nothing', () => {
    silentLogger.info('x');
    silentLogger.error('y');
  });
});

describe('serializeError', () => {
  test('keeps name, message, stack and string codes', () => {
    const error = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    const fields = serializeError(error);
    assert.equal(fields.name, 'Error');
    assert.equal(fields.message, 'refused');
    assert.equal(fields.code, 'ECONNREFUSED');
    assert.match(String(fields.stack), /refused/);
  });

  test('ignores non-string codes and handles non-errors', () => {
    assert.equal(serializeError(Object.assign(new Error('x'), { code: 42 })).code, undefined);
    assert.deepEqual(serializeError('plain'), { name: 'NonError', message: 'plain' });
  });
});

describe('logError', () => {
  test('logs the serialized error with extra fields', () => {
    const { logger, lines } = capture();
    logError(logger, 'startup_failed', new TypeError('bad'), { phase: 'config' });
    const entry = JSON.parse(lines.error[0]!);
    assert.equal(entry.event, 'startup_failed');
    assert.equal(entry.phase, 'config');
    assert.equal(entry.error.name, 'TypeError');
    assert.match(entry.error.stack, /TypeError: bad/);
  });
});
