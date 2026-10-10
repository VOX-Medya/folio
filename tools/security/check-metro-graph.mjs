import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const pinnedMetroPackages=Object.freeze([
  'metro','metro-babel-transformer','metro-cache','metro-cache-key',
  'metro-config','metro-core','metro-file-map','metro-minify-terser',
  'metro-resolver','metro-runtime','metro-source-map','metro-symbolicate',
  'metro-transform-plugins','metro-transform-worker',
]);

/**
 * A structural regression gate, not a blanket security/audit waiver.
 * SDK 54 @expo/metro pins 0.83.3 exactly; this tested 0.83.8 cohort removes
 * the image-size parsers affected by two advisories. Do not mix Metro minors.
 */
export function metroLockProblems(lock){
  const errors=[];
  if(typeof lock!=='string'||!lock.startsWith("lockfileVersion: '9.0'")){
    return ['Expected a pnpm v9 lockfile'];
  }
  const overrides=lock.slice(
    lock.indexOf('\noverrides:\n')+1,lock.indexOf('\nimporters:\n'),
  );
  if(!overrides.startsWith('overrides:\n')){
    errors.push('Missing workspace-level overrides section');
  }
  for(const name of pinnedMetroPackages){
    const match=Array.from(lock.matchAll(
      new RegExp('^  '+name+'@([0-9.]+):','gm'),
    ));
    const resolved=[...new Set(match.map(x=>x[1]))];
    if(resolved.length!==1||resolved[0]!=='0.83.8'){
      errors.push(name+' must resolve only to 0.83.8; found '+(resolved.join(',')||'none'));
    }
    if(!overrides.includes('\n  '+name+': 0.83.8\n')){
      errors.push('Missing exact 0.83.8 override for '+name);
    }
  }
  if(/^  image-size@/m.test(lock)){
    errors.push('image-size is back in dependency graph; original DoS advisories are not removed');
  }
  return errors;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const file=process.argv[2];
  if(!file)throw new Error('Expected pnpm-lock.yaml path');
  const errors=metroLockProblems(readFileSync(file,'utf8'));
  if(errors.length){
    for(const error of errors)console.error('Metro dependency guard: '+error);
    process.exitCode=1;
  }else{
    console.log('Metro dependency guard PASS: 14 aligned 0.83.8 packages, exact overrides, image-size absent. This does not clear other pnpm audit findings.');
  }
}
