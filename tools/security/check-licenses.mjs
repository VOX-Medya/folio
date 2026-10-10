import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('Provide the pnpm licenses list --json output file');
const licenses = JSON.parse(readFileSync(file, 'utf8'));
const permitted = new Set([
  'MIT', 'Apache-2.0', 'Apache 2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause',
  '0BSD', 'Unlicense', 'CC-BY-4.0', 'BlueOak-1.0.0', 'Python-2.0',
  'MPL-2.0', '(BSD-3-Clause OR GPL-2.0)',
  '(BSD-2-Clause OR MIT OR Apache-2.0)', '(MIT OR CC0-1.0)',
]);
const unknown = Object.entries(licenses).filter(([name]) => !permitted.has(name));
if (unknown.length) {
  for (const [name, packages] of unknown) {
    console.error(`Unreviewed license ${name}: ${packages.map(p => p.name).join(', ')}`);
  }
  process.exitCode = 1;
} else {
  const count = Object.values(licenses).reduce((n, p) => n + p.length, 0);
  console.log(`Verified ${count} dependency license declarations; preserve required notices in releases.`);
}
