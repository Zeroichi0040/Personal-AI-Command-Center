import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smoke } from '../apps/server/src/runtime/codex/smoke.mjs';
const args = process.argv.slice(2);
if (args.some(x => x !== '--live')) { console.error('Usage: npm run smoke -- [--live]'); process.exit(2); }
const cwd = await mkdtemp(join(tmpdir(), 'pacc-smoke-'));
try {
  await smoke({ cwd, live: args.includes('--live'), onStep: line => console.log('\n' + line), onDelta: delta => process.stdout.write(delta.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')) });
  console.log('\nPASS');
} catch (error) { console.error('\nFAIL:', error.message); process.exitCode = 1; }
finally { await rm(cwd, { recursive: true, force: true }); }
