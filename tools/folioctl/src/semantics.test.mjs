import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fixture} from './fixtures.mjs';
import {validatePreparedFolder} from './manifest.mjs';
import {createJsonlScanner} from './semantics.mjs';

function mutateFixture(root,path,modify){
  const absolute=join(root,path);
  const prior=readFileSync(absolute,'utf8').trim();
  const object=JSON.parse(prior);
  const updated=JSON.stringify(modify(object))+'\n';
  writeFileSync(absolute,updated);
  const manifestFile=join(root,'manifest.json');
  const manifest=JSON.parse(readFileSync(manifestFile,'utf8'));
  const entry=manifest.files.find(item=>item.path===path);
  if(!entry)throw new Error('Fixture missing indexed path');
  entry.sha256=createHash('sha256').update(updated).digest('hex');
  entry.size_bytes=Buffer.byteLength(updated);
  writeFileSync(manifestFile,JSON.stringify(manifest));
  return object;
}

const metadata=[
  {name:'orphan author',file:'metadata/works.ndjson',modify:record=>({...record,authors:[randomUUID()]}),pattern:/Work has missing or duplicate authors/},
  {name:'wrong work edition',file:'metadata/editions.ndjson',modify:record=>({...record,work_id:randomUUID()}),pattern:/Edition refers to a different\/missing work/},
  {name:'language mismatch',file:'metadata/revisions.ndjson',modify:record=>({...record,language:'en'}),pattern:/Revision edition\/language mismatch/},
  {name:'false rights approval',file:'metadata/rights.ndjson',modify:record=>({...record,review_status:'approved'}),pattern:/invalid_value|Invalid option|Invalid input/},
  {name:'rights wrong owner',file:'metadata/rights.ndjson',modify:record=>({...record,work_id:randomUUID()}),pattern:/Rights evidence refers to missing work/},
];
for(const item of metadata){
  test(`cross-record validation rejects ${item.name} even with recomputed package hashes`,async()=>{
    const {root}=fixture();
    try{
      mutateFixture(root,item.file,item.modify);
      await assert.rejects(()=>validatePreparedFolder(root),item.pattern);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
}

test('semantic text rejects forged block SHA despite correct outer file/manifest checksums',async()=>{
  const {root,manifest}=fixture();
  try{
    const file=manifest.files.find(f=>f.kind==='text').path;
    mutateFixture(root,file,record=>({...record,text_sha256:'0'.repeat(64)}));
    await assert.rejects(()=>validatePreparedFolder(root),/Source text checksum mismatch/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('footnotes cannot enter RSVP/audio and old source characters are not trimmed',async()=>{
  const {root,manifest}=fixture();
  try{
    const file=manifest.files.find(f=>f.kind==='text').path;
    mutateFixture(root,file,record=>({...record,kind:'footnote',include_rsvp:true}));
    await assert.rejects(()=>validatePreparedFolder(root),/Auxiliary text cannot enter RSVP or audio/);
    mutateFixture(root,file,record=>({...record,include_rsvp:false,include_audio:false,source_text:record.source_text.trimEnd()+' ',text_sha256:record.text_sha256}));
    await assert.rejects(()=>validatePreparedFolder(root),/Source text checksum mismatch/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('duplicate IDs and non-contiguous chapter and block order are rejected',()=>{
  const {root,manifest}=fixture();
  try{
    const file=manifest.files.find(f=>f.kind==='text').path;
    const row=JSON.parse(readFileSync(join(root,file),'utf8'));
    for(const kind of ['duplicate','gap','wrong-revision']){
      const scanner=createJsonlScanner(file);
      if(kind==='duplicate')assert.throws(()=>scanner.push(Buffer.from(JSON.stringify(row)+'\n'+JSON.stringify(row)+'\n')),/Duplicate stable block identifier/);
      if(kind==='gap'){
        scanner.push(Buffer.from(JSON.stringify({...row,ordinal:8})+'\n'));
        assert.throws(()=>scanner.finish(),/Unreliable semantic block order/);
      }
      if(kind==='wrong-revision')assert.throws(()=>scanner.push(Buffer.from(JSON.stringify({...row,revision_id:randomUUID()})+'\n')),/Text revision scope mismatch/);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('invalid alignment references are caught without creating translated text',async()=>{
  const {root,manifest}=fixture();
  try{
    const sourceRevision=manifest.files.find(f=>f.kind==='text').path.split('/')[1];
    const file=`alignments/${sourceRevision}-${randomUUID()}.jsonl`;
    const body=JSON.stringify({source_revision_id:sourceRevision,target_revision_id:randomUUID(),source_block_id:randomUUID(),target_block_id:randomUUID(),verified:false})+'\n';
    mkdirSync(dirname(join(root,file)),{recursive:true});
    writeFileSync(join(root,file),body);
    const mfile=join(root,'manifest.json');
    const data=JSON.parse(readFileSync(mfile,'utf8'));
    data.files.push({path:file,kind:'alignment',size_bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')});
    writeFileSync(mfile,JSON.stringify(data));
    await assert.rejects(()=>validatePreparedFolder(root),/Alignment references an absent prepared block/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
