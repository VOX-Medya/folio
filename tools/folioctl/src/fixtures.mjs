import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

export function fixture(){
  const root=mkdtempSync(join(tmpdir(),'folio-ctl-test-'));
  const authorId=randomUUID(),workId=randomUUID(),editionId=randomUUID(),revisionId=randomUUID(),chapterId=randomUUID(),blockId=randomUUID();
  const sourceText='Tamamen sentetik metin. Noktalama aynen korunur.';
  const digest=createHash('sha256').update(sourceText,'utf8').digest('hex');
  const files=[
    ['metadata/authors.ndjson',JSON.stringify({id:authorId,canonical_name:'Fixture Author'})+'\n','metadata'],
    ['metadata/works.ndjson',JSON.stringify({id:workId,original_title:'Fixture',original_language:'tr',authors:[authorId]})+'\n','metadata'],
    ['metadata/editions.ndjson',JSON.stringify({id:editionId,work_id:workId,language:'tr'})+'\n','metadata'],
    ['metadata/revisions.ndjson',JSON.stringify({id:revisionId,edition_id:editionId,language:'tr',status:'draft',source_sha256:'b'.repeat(64)})+'\n','metadata'],
    ['metadata/rights.ndjson',JSON.stringify({work_id:workId,evidence:'Manual review required; not approved',review_status:'pending'})+'\n','metadata'],
    [`texts/${revisionId}/blocks.jsonl`,JSON.stringify({revision_id:revisionId,chapter_id:chapterId,chapter_ordinal:0,block_id:blockId,ordinal:0,kind:'paragraph',source_text:sourceText,text_sha256:digest,locator:{format:'text',path:'chapter/0'},include_rsvp:true,include_audio:true})+'\n','text'],
  ];
  const indexed=[];
  for(const [path,text,kind] of files){
    mkdirSync(dirname(join(root,path)),{recursive:true});
    writeFileSync(join(root,path),text);
    indexed.push({path,sha256:createHash('sha256').update(text).digest('hex'),size_bytes:Buffer.byteLength(text),kind});
  }
  const manifest={schema_version:'1.0.0',package_id:randomUUID(),created_at:'2026-10-10T00:00:00.000Z',source:'local-editorial',scope:'licensed-library',
    declared_counts:{authors:1,works:1,editions:1,revisions:1},tool:{name:'synthetic-test',version:'0.1.0'},files:indexed};
  writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return {root,manifest};
}
