import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyExpoExports} from './check-expo-exports.mjs';

test('CI requires all three Expo platform JS bundles, rejects missing Android/iOS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'folio-export-check-'));
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    writeFileSync(join(dir, 'metadata.json'), '{}');
    for (const platform of ['web','android','ios']) {
      const path = join(dir, '_expo','static','js',platform);
      mkdirSync(path, {recursive: true});
      writeFileSync(join(path,`entry-${'a'.repeat(16)}.${platform==='web'?'js':'hbc'}`), 'test');
    }
    assert.deepEqual(verifyExpoExports(dir), ['web','android','ios']);
    rmSync(join(dir,'_expo','static','js','ios'), {recursive:true});
    assert.throws(() => verifyExpoExports(dir), /Missing Expo ios bundle directory/);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
