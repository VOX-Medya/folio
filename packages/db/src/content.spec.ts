import {describe,expect,it} from 'vitest';
import {contentRevisionCreateSchema} from '@folio/contracts';
import {sha256Text} from './content.js';

function draft() {
  const text='An original paragraph, left untouched.';
  return {
    editionId:'347ae2b1-27f6-4ea3-a64a-a5582f8bffeb',language:'en',
    rawArtifactKey:'local-lab/abc',rawSha256:'a'.repeat(64),parserVersion:'manual-1',
    provenance:{sourceName:'manual_local_pkg'},chapters:[{
      chapterId:'347ae2b1-27f6-4ea3-a64a-a5582f8bffec',ordinal:0,heading:'Part 1',
      blocks:[{blockId:'347ae2b1-27f6-4ea3-a64a-a5582f8bffed',ordinal:0,kind:'paragraph',
        locator:{format:'text',path:'part1/0'},sourceText:text,textSha256:sha256Text(text),includeRsvp:true,includeAudio:true}],
    }],
  };
}
describe('semantic immutable content contracts',()=>{
  it('requires preserved block text and stable, reliable ordinals',()=>{
    expect(contentRevisionCreateSchema.safeParse(draft()).success).toBe(true);
    const copy=draft();copy.chapters[0]!.blocks[0]!.ordinal=10;
    expect(contentRevisionCreateSchema.safeParse(copy).success).toBe(false);
  });
  it('prevents footnotes and printed page numbers from RSVP/audio flow',()=>{
    const copy=draft();copy.chapters[0]!.blocks[0]!.kind='footnote';
    expect(contentRevisionCreateSchema.safeParse(copy).success).toBe(false);
  });
  it('uses exact UTF-8 hash, not regenerated or corrected text',()=>{
    const source='İstanbul\nOrigınal punctuation:  — \u00e7  '; 
    expect(sha256Text(source)).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256Text(source)).not.toBe(sha256Text(source.trim()));
  });
});
