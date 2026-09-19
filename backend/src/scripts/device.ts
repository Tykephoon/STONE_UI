/**
 * Device provisioning CLI.
 *
 * Device keys are the only credential left in the system, and they are what
 * stops an anonymous caller writing to the readings table. Minting one is
 * therefore a local operation — it requires access to the server or its
 * database, not merely access to the API.
 *
 *   npm run device -- list
 *   npm run device -- add "Pico-01 · Trail Rig" --notes "BME280 + MPU-6050"
 *   npm run device -- rotate dev_0123456789abcdefgh
 *   npm run device -- remove dev_0123456789abcdefgh
 *
 * On Fly.io, run it against the live volume with:
 *
 *   fly ssh console -C "node /app/dist/scripts/device.js add 'Pico-01'"
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { openDatabase } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { newId, newSecret } from '../lib/ids.js';

const DEVICE_KEY_PREFIX = 'stk';

const { values, positionals } = parseArgs({
  options: {
    notes: { type: 'string' },
    yes: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

function generateKey(): { key: string; hash: string; prefix: string } {
  const secret = newSecret(32);
  const key = `${DEVICE_KEY_PREFIX}_${secret}`;
  return {
    key,
    hash: sha256(key),
    prefix: `${DEVICE_KEY_PREFIX}_${secret.slice(0, 6)}`,
  };
}

function printKey(name: string, key: string): void {
  console.log('');
  console.log(`  Device:  ${name}`);
  console.log(`  Key:     ${key}`);
  console.log('');
  console.log('  Only a hash of this key is stored, so it cannot be shown again.');
  console.log('  Copy it onto the device now; if you lose it, rotate.');
  console.log('');
}

async function confirm(question: string): Promise<boolean> {
  if (values.yes) return true;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

function usage(): void {
  console.log(`
  Device provisioning

    npm run device -- list
    npm run device -- add <name> [--notes "..."]
    npm run device -- rotate <device-id>
    npm run device -- remove <device-id> [--yes]
`);
}

async function main(): Promise<void> {
  const command = positionals[0];
  const db = openDatabase();

  try {
    switch (command) {
      case 'list': {
        const rows = db
          .prepare(
            `SELECT d.id, d.name, d.key_prefix, d.created_at, d.last_seen_at,
                    (SELECT COUNT(*) FROM readings r WHERE r.device_id = d.id) AS readings
               FROM devices d ORDER BY d.created_at ASC`,
          )
          .all() as {
          id: string;
          name: string;
          key_prefix: string;
          created_at: string;
          last_seen_at: string | null;
          readings: number;
        }[];

        if (rows.length === 0) {
          console.log('\n  No devices registered. Add one with:  npm run device -- add "My Pico"\n');
          break;
        }

        console.log('');
        for (const row of rows) {
          console.log(`  ${row.name}`);
          console.log(`    id         ${row.id}`);
          console.log(`    key        ${row.key_prefix}…`);
          console.log(`    readings   ${row.readings.toLocaleString()}`);
          console.log(`    last seen  ${row.last_seen_at ?? 'never'}`);
          console.log('');
        }
        break;
      }

      case 'add': {
        const name = positionals[1]?.trim();
        if (!name) {
          console.error('\n  A name is required:  npm run device -- add "Pico-01"\n');
          process.exitCode = 1;
          break;
        }
        if (name.length > 80) {
          console.error('\n  Keep the name under 80 characters.\n');
          process.exitCode = 1;
          break;
        }

        const id = newId('dev');
        const { key, hash, prefix } = generateKey();

        db.prepare(
          `INSERT INTO devices (id, name, key_hash, key_prefix, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, name, hash, prefix, values.notes ?? null, new Date().toISOString());

        console.log(`\n  Registered ${id}`);
        printKey(name, key);
        break;
      }

      case 'rotate': {
        const id = positionals[1]?.trim();
        if (!id) {
          console.error('\n  A device id is required. Run:  npm run device -- list\n');
          process.exitCode = 1;
          break;
        }

        const device = db.prepare('SELECT name FROM devices WHERE id = ?').get(id) as
          | { name: string }
          | undefined;

        if (!device) {
          console.error(`\n  No device with id ${id}\n`);
          process.exitCode = 1;
          break;
        }

        const { key, hash, prefix } = generateKey();

        // Overwriting the hash kills the previous key immediately.
        db.prepare(
          'UPDATE devices SET key_hash = ?, key_prefix = ?, key_rotated_at = ? WHERE id = ?',
        ).run(hash, prefix, new Date().toISOString(), id);

        console.log(`\n  Rotated. The previous key stopped working just now.`);
        printKey(device.name, key);
        break;
      }

      case 'remove': {
        const id = positionals[1]?.trim();
        if (!id) {
          console.error('\n  A device id is required. Run:  npm run device -- list\n');
          process.exitCode = 1;
          break;
        }

        const device = db
          .prepare(
            `SELECT d.name, (SELECT COUNT(*) FROM readings r WHERE r.device_id = d.id) AS readings
               FROM devices d WHERE d.id = ?`,
          )
          .get(id) as { name: string; readings: number } | undefined;

        if (!device) {
          console.error(`\n  No device with id ${id}\n`);
          process.exitCode = 1;
          break;
        }

        const ok = await confirm(
          `\n  Delete "${device.name}" and its ${device.readings.toLocaleString()} readings?`,
        );
        if (!ok) {
          console.log('  Cancelled.\n');
          break;
        }

        // Readings cascade with the device.
        db.prepare('DELETE FROM devices WHERE id = ?').run(id);
        console.log('  Deleted.\n');
        break;
      }

      default:
        usage();
        if (command !== undefined) process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((cause) => {
  console.error('Device command failed:', cause);
  process.exit(1);
});
