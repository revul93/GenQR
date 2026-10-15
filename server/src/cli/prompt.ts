import readline from 'node:readline';

/** Reads a line from the terminal without echoing it. */
export function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.reject(new Error('No terminal available; use --password-stdin to pipe the password.'));
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const mutable = rl as unknown as { _writeToOutput(s: string): void };
    let prompted = false;
    mutable._writeToOutput = (s: string) => {
      // Print the question once, then swallow the echoed keystrokes.
      if (!prompted) {
        process.stdout.write(s);
        prompted = true;
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
