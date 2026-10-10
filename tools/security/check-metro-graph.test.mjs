import test from 'node:test';
import assert from 'node:assert/strict';
import {metroLockProblems,pinnedMetroPackages} from './check-metro-graph.mjs';

const fixture=()=>[
  "lockfileVersion: '9.0'","", "overrides:",
  ...pinnedMetroPackages.map(name=>'  '+name+': 0.83.8'),
  "", "importers:", "  .:", "    dependencies: {}", "",
  "packages:",
  ...pinnedMetroPackages.map(name=>'  '+name+'@0.83.8:'),
  "snapshots:",
  ...pinnedMetroPackages.map(name=>'  '+name+'@0.83.8:'),
  "",
].join('\n');

test('all 14 packages pinned and image-size absent passes',()=>{
  assert.deepEqual(metroLockProblems(fixture()),[]);
});
test('reintroduction of image-size fails closed',()=>{
  const issues=metroLockProblems(fixture()+'  image-size@1.2.1:\n');
  assert.match(issues.join('\n'),/image-size/);
});
test('mixed patch versions fail even if pinned version is also present',()=>{
  const issues=metroLockProblems(fixture()+'  metro@0.83.3:\n');
  assert.match(issues.join('\n'),/metro must resolve only to 0\.83\.8/);
});
test('dropping an override fails even when graph currently resolves patched version',()=>{
  const changed=fixture().replace('\n  metro-core: 0.83.8\n','\n');
  assert.match(metroLockProblems(changed).join('\n'),/Missing exact 0\.83\.8 override for metro-core/);
});
test('missing lockfile or package fails closed',()=>{
  assert.match(metroLockProblems('')?.join('\n')??'',/Expected a pnpm/);
  const without=fixture().replaceAll('  metro-symbolicate@0.83.8:','');
  assert.match(metroLockProblems(without).join('\n'),/metro-symbolicate must resolve only/);
});
