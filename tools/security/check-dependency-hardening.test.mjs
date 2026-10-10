import test from 'node:test';
import assert from 'node:assert/strict';
import {dependencyHardeningProblems} from './check-dependency-hardening.mjs';

const root={pnpm:{overrides:{
  'drizzle-kit@0.31.11>@esbuild-kit/esm-loader':'-',
  'js-yaml@5.3.0':'5.4.1',
}}};
const clean="lockfileVersion: '9.0'\n\noverrides:\n  js-yaml@5.3.0: 5.4.1\n\npackages:\n  js-yaml@5.4.1:\n";

test('an installed patched js-yaml node is distinct from its vulnerable override selector',()=>{
  assert.deepEqual(dependencyHardeningProblems(clean,root),[]);
});
test('rejects vulnerable packages returning without hiding external advisory risk',()=>{
  for(const bad of [
    clean+'  esbuild@0.18.20:\n',
    clean+"  '@esbuild-kit/esm-loader@2.6.5':\n",
    clean+"  '@esbuild-kit/core-utils@3.3.2':\n",
    clean+'  js-yaml@5.3.0:\n',
  ]){
    assert.match(dependencyHardeningProblems(bad,root).join('|'),/Vulnerable dependency regression/);
  }
});
test('refuses to bless an absent patched node or missing exact scoped rules',()=>{
  assert.match(dependencyHardeningProblems(clean.replace('  js-yaml@5.4.1:\n',''),root).join('|'),
    /patched js-yaml/i);
  assert.match(dependencyHardeningProblems(clean,{pnpm:{overrides:{}}}).join('|'),
    /must be removed/);
  assert.match(dependencyHardeningProblems(clean,{
    pnpm:{overrides:{...root.pnpm.overrides,'js-yaml@5.3.0':'5.3.0'}},
  }).join('|'),/must resolve/);
  assert.match(dependencyHardeningProblems('wrong',root).join('|'),/lockfile/);
});
