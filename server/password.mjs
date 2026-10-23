import { randomBytes, scryptSync } from 'node:crypto';

// Password is read from stdin, never a command argument or source file.
let password = '';
if (process.stdin.isTTY) {
  process.stderr.write('Choose the game password (hidden): ');
  process.stdin.setRawMode(true);
  for await (const buffer of process.stdin) {
    for (const character of buffer.toString()) {
      if (character === '\u0003') process.exit(130);
      if (character === '\r' || character === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); finish(); process.exit(0); }
      if (character === '\u007f') password = password.slice(0, -1); else password += character;
    }
  }
} else { for await (const chunk of process.stdin) password += chunk; password = password.replace(/[\r\n]+$/, ''); finish(); }
function finish() {
  if (password.length < 12 || password.length > 256) throw new Error('Use a password between 12 and 256 characters');
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
  process.stdout.write(`${salt.toString('hex')}:${hash.toString('hex')}\n`);
}
