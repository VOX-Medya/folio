import {describe,expect,it} from 'vitest';
import {compareSemanticRevisionMetadata} from './content-diff.js';
import type {SemanticDiffBlock} from './content-diff.js';

const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007'];
const chapters=['00000000-0000-4000-8000-111111111111',
  '00000000-0000-4000-8000-222222222222',
  '00000000-0000-4000-8000-333333333333'];
const mk=(blockId:string,hash:string,chapterId=chapters[0]!,ordinal=0):SemanticDiffBlock=>({
  blockId,chapterId,ordinal,parentBlockId:null,kind:'paragraph',textSha256:hash,
  sourceLocator:{path:'src/a',offset:ordinal},includeNormal:true,
  includeRsvp:true,includeAudio:true,
});
describe('immutable semantic source revision metadata diff',()=>{
  it('classifies stable IDs by SHA, chapter/ordinal, include flags and source locator; no invented text',()=>{
    const before=[
      mk(ids[0]!,'a',chapters[0],0),
      mk(ids[1]!,'b',chapters[0],1),
      mk(ids[2]!,'c',chapters[0],2),
      mk(ids[3]!,'d',chapters[0],3),
      mk(ids[4]!,'e',chapters[1],0),
      mk(ids[6]!,'g',chapters[1],1),
    ];
    const after=[
      mk(ids[0]!,'a',chapters[0],0),
      mk(ids[1]!,'bb',chapters[0],1),
      mk(ids[2]!,'c',chapters[1],2),
      {...mk(ids[3]!,'d',chapters[0],3),includeRsvp:false},
      mk(ids[5]!,'f',chapters[1],0),
      {...mk(ids[6]!,'g',chapters[1],1),sourceLocator:{offset:1,path:'src/changed'}},
    ];
    const compared=compareSemanticRevisionMetadata(
      before,after,
      [{chapterId:chapters[0]!,ordinal:0,heading:'Chapter I'},
        {chapterId:chapters[1]!,ordinal:1,heading:'Chapter II'}],
      [{chapterId:chapters[0]!,ordinal:0,heading:'Chapter I (reviewed)'},
        {chapterId:chapters[1]!,ordinal:1,heading:'Chapter II'},
        {chapterId:chapters[2]!,ordinal:2,heading:'New'}],
    );
    expect(compared.summary).toEqual({
      added:1,removed:1,text_changed:1,metadata_changed:2,moved:1,unchanged:1,
    });
    expect(compared.changes.map(row=>[row.blockId,row.kind])).toEqual([
      [ids[1],'text_changed'],[ids[2],'moved'],[ids[3],'metadata_changed'],
      [ids[4],'removed'],[ids[5],'added'],[ids[6],'metadata_changed'],
    ]);
    expect(compared.chapterChanges).toEqual([
      {chapterId:chapters[0],kind:'renamed'},
      {chapterId:chapters[2],kind:'added'},
    ]);
    expect(compared.changes.find(row=>row.blockId===ids[1])?.before?.textSha256).toBe('b');
    expect(compared.changes.find(row=>row.blockId===ids[1])?.after?.textSha256).toBe('bb');
    expect(JSON.stringify(compared)).not.toContain('sourceLocator');
    expect(JSON.stringify(compared)).not.toContain('sourceText');
    expect(JSON.stringify(compared)).not.toContain('Chapter I (reviewed)');
  });
  it('does NOT infer lexical similarity or translate renamed IDs, even when hashes match',()=>{
    const old=[mk(ids[0]!,'same'),mk(ids[1]!,'unchanged',chapters[1],1)];
    const newer=[mk(ids[2]!,'same'),mk(ids[1]!,'unchanged',chapters[1],1)];
    const diff=compareSemanticRevisionMetadata(old,newer,[],[]);
    expect(diff.summary).toEqual({
      added:1,removed:1,text_changed:0,metadata_changed:0,moved:0,unchanged:1,
    });
  });
  it('is deterministic regardless of row order and refuses duplicate stable IDs',()=>{
    const old=[mk(ids[0]!,'old'),mk(ids[1]!,'old')];
    const next=[mk(ids[1]!,'new'),mk(ids[0]!,'new')];
    const forward=compareSemanticRevisionMetadata(old,next,[],[]);
    const reverse=compareSemanticRevisionMetadata([...old].reverse(),[...next].reverse(),[],[]);
    expect(forward).toEqual(reverse);
    expect(()=>compareSemanticRevisionMetadata([...old,old[0]!],next,[],[]))
      .toThrow('Duplicate stable block ID');
    expect(()=>compareSemanticRevisionMetadata([],[],[
      {chapterId:chapters[0]!,ordinal:0,heading:'A'},
      {chapterId:chapters[0]!,ordinal:1,heading:'B'},
    ],[])).toThrow('Duplicate stable chapter ID');
  });
});
