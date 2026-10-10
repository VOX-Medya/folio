import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/**
 * Guard ONLY the two objectively removed transitive advisory edges.
 * This is not a registry audit or a release waiver: pnpm audit still blocks
 * production until all moderate/high/critical findings are gone.
 */
export function dependencyHardeningProblems(lock,root) {
  const errors=[];
  if(typeof lock!=='string'||!lock.startsWith("lockfileVersion: '9.0'")){
    return ['Expected pnpm lockfile v9'];
  }
  if(!root||typeof root!=='object'||Array.isArray(root)){
    return ['Expected workspace package.json'];
  }
  const overrides=root.pnpm?.overrides??{};
  if(overrides['drizzle-kit@0.31.11>@esbuild-kit/esm-loader']!=='-'){
    errors.push('Drizzle unused legacy esbuild-kit loader must be removed');
  }
  if(overrides['js-yaml@5.3.0']!=='5.4.1'){
    errors.push('Legacy js-yaml 5.3.0 must resolve to patched 5.4.1');
  }
  // Match PACKAGE entries, not an override selector:
  //   "  js-yaml@5.3.0: 5.4.1" is the intended override, not an installed node.
  const legacy={
    'abandoned @esbuild-kit/esm-loader':/^  '@esbuild-kit\/esm-loader@[^']+':\s*$/m,
    'abandoned @esbuild-kit/core-utils':/^  '@esbuild-kit\/core-utils@[^']+':\s*$/m,
    'affected esbuild 0.18.20':/^  esbuild@0\.18\.20:\s*$/m,
    'affected js-yaml 5.3.0':/^  js-yaml@5\.3\.0:\s*$/m,
  };
  for(const [name,pattern] of Object.entries(legacy)){
    if(pattern.test(lock))errors.push('Vulnerable dependency regression: '+name);
  }
  if(!/^  js-yaml@5\.4\.1:\s*$/m.test(lock)){
    errors.push('Patched js-yaml 5.4.1 package not present');
  }
  return errors;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [lockPath,manifestPath]=process.argv.slice(2);
  if(!lockPath||!manifestPath)throw Error('Supply pnpm-lock.yaml and package.json');
  const errors=dependencyHardeningProblems(
    readFileSync(lockPath,'utf8'),JSON.parse(readFileSync(manifestPath,'utf8')),
  );
  if(errors.length){
    for(const item of errors)console.error('Dependency hardening failed: '+item);
    process.exitCode=1;
  }else{
    console.log('Dependency hardening PASS: unused Drizzle esbuild 0.18 path removed, js-yaml 5.4.1 selected; release audit remains independent.');
  }
}
