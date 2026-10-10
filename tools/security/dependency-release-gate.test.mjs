import test from 'node:test';
import assert from 'node:assert/strict';
import {dependencyReleaseProblems} from './dependency-release-gate.mjs';
const clean="lockfileVersion: '9.0'\n\npackages:\n  safe@1.0.0:\n";
const audit=(high=0,moderate=0)=>({metadata:{vulnerabilities:{critical:0,high,moderate}}});
test('clean lockfile and zero security findings pass',()=>{
  assert.deepEqual(dependencyReleaseProblems(clean,audit()),[]);
});
test('actual vulnerable forge and braces versions block publishing',()=>{
  const lock=clean+"  node-forge@1.4.0:\n  braces@3.0.3:\n";
  const result=dependencyReleaseProblems(lock,audit());
  assert.match(result.join('|'),/node-forge/);
  assert.match(result.join('|'),/braces/);
});
test('live audit findings block release even when image-size is absent from lockfile',()=>{
  assert.match(dependencyReleaseProblems(clean,audit(4,5)).join('|'),/high advisories: 4/);
  assert.match(dependencyReleaseProblems(clean,audit(4,5)).join('|'),/moderate advisories: 5/);
});
test('missing or malformed audit data never means release approved',()=>{
  assert.match(dependencyReleaseProblems(clean,null).join('|'),/Missing pnpm audit/);
  assert.match(dependencyReleaseProblems(clean,{error:'registry unavailable'}).join('|'),/could not complete/);
  assert.match(dependencyReleaseProblems('invalid',audit()).join('|'),/Expected pnpm/);
});
