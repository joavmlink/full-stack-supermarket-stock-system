import { createInterface } from 'node:readline';
import { readHiddenKeys } from '../lib/hidden-input.js';

/**
 * Terminal prompts. On a TTY the hidden prompt switches stdin to raw mode so
 * the password is never echoed. When stdin is piped (scripts, tests), answers
 * are read line by line.
 */
export function createPrompter() {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin, terminal: false });
    const lines = rl[Symbol.asyncIterator]();
    const next = async (question: string) => {
      stdout.write(question);
      const line = await lines.next();
      stdout.write('\n');
      if (line.done === true) throw new Error('Input ended before every answer was given.');
      return line.value;
    };
    return { ask: next, askHidden: next, close: () => rl.close() };
  }

  const ask = (question: string) =>
    new Promise<string>((resolve) => {
      const rl = createInterface({ input: stdin, output: stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });

  // Input typed or pasted after an Enter, kept for the next hidden prompt.
  let pending = '';
  const askHidden = (question: string) =>
    new Promise<string>((resolve, reject) => {
      stdout.write(question);
      let value = '';
      const finish = (cancelled: boolean) => {
        stdin.off('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        stdout.write('\n');
        if (cancelled) reject(new Error('Cancelled.'));
        else resolve(value);
      };
      const onData = (chunk: Buffer | string) => {
        const result = readHiddenKeys(value, chunk.toString());
        value = result.value;
        if (!result.done) return;
        pending = result.rest;
        finish(result.cancelled);
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
      if (pending !== '') {
        const buffered = pending;
        pending = '';
        onData(buffered);
      }
    });

  return { ask, askHidden, close: () => {} };
}
