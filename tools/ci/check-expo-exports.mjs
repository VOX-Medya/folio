import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

/** Verifies all three Expo JS bundle targets. Does NOT attest native builds/device tests. */
export function verifyExpoExports(root) {
  const dir = resolve(root);
  if (!existsSync(join(dir, 'index.html')) || !existsSync(join(dir, 'metadata.json'))) {
    throw new Error('Expo Web HTML or export metadata is missing');
  }
  const platforms = ['web', 'android', 'ios'];
  for (const platform of platforms) {
    const bundlePath = join(dir, '_expo', 'static', 'js', platform);
    if (!existsSync(bundlePath)) throw new Error(`Missing Expo ${platform} bundle directory`);
    const files = readdirSync(bundlePath);
    if (!files.some(file => /^entry-[a-f0-9]+\.(?:js|hbc)$/.test(file) &&
      (platform === 'web' ? file.endsWith('.js') : file.endsWith('.hbc')))) {
      throw new Error(`Missing compiled Expo ${platform} entry bundle`);
    }
  }
  const metadata = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'));
  if (!metadata || typeof metadata !== 'object') throw new Error('Invalid Expo export metadata');
  return platforms;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const targets = verifyExpoExports(process.argv[2] || 'apps/mobile/dist');
  console.log(`Verified Expo JS export targets: ${targets.join(', ')}. Native simulator/device tests are separate.`);
}
