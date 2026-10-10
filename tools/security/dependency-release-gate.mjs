import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/**
 * Honest release gate. It is deliberately separate from the Metro structural
 * compatibility check. A green build does not waive advisory findings.
 */
export function dependencyReleaseProblems(lock, audit) {
  const failures=[];
  if(typeof lock!=='string'||!lock.startsWith("lockfileVersion: '9.0'")){
    failures.push('Expected pnpm lockfile v9');
  }else{
    // These versions remain transitive in SDK 54. Do not pretend an absent
    // image-size snapshot clears advisories returned by a live registry audit.
    const vulnerable={
      'node-forge':/^ {2}node-forge@(?:0\.\d+\.\d+|1\.[0-4]\.\d+):/m,
      'braces':/^ {2}braces@(?:[0-2]\.\d+\.\d+|3\.0\.[0-3]):/m,
    };
    for(const [name,pattern] of Object.entries(vulnerable)){
      if(pattern.test(lock))failures.push('Known vulnerable transitive package remains: '+name);
    }
  }
  if(!audit||typeof audit!=='object'||Array.isArray(audit)){
    failures.push('Missing pnpm audit JSON evidence');
    return failures;
  }
  if(audit.error)failures.push('Dependency audit could not complete');
  const totals=audit.metadata?.vulnerabilities;
  if(!totals||typeof totals!=='object'){
    failures.push('Dependency audit has no vulnerability totals');
    return failures;
  }
  for(const level of ['critical','high','moderate']){
    const count=totals[level];
    if(!Number.isInteger(count)||count<0)failures.push('Invalid audit count for '+level);
    else if(count>0)failures.push(level+' advisories: '+count);
  }
  return failures;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [lockPath,auditPath]=process.argv.slice(2);
  if(!lockPath||!auditPath)throw new Error('Provide pnpm-lock.yaml and pnpm audit --json output');
  let report;
  try{report=JSON.parse(readFileSync(auditPath,'utf8'));}
  catch{report=null;}
  const failures=dependencyReleaseProblems(readFileSync(lockPath,'utf8'),report);
  if(failures.length){
    for(const f of failures)console.error('Folio release security BLOCKED: '+f);
    process.exitCode=1;
  }else{
    console.log('Folio release dependency gate PASS: no known affected lock versions and no moderate-or-higher audit vulnerabilities.');
  }
}
