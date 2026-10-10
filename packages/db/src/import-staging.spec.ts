import {describe,expect,it} from 'vitest';
import {canonicalJson,payloadHash,preparedImportSchema} from './import-staging.js';
const uuid='9d4c3c6a-6045-4c16-8c87-991eb78dce01';
const other='9d4c3c6a-6045-4c16-8c87-991eb78dce02';
const packageData={packageId:uuid,manifestChecksum:'a'.repeat(64),schemaVersion:'1.0.0',
  records:{authors:[{id:uuid,canonical_name:'Test Author'}],works:[{
    id:other,original_title:'Test Work',original_language:'tr',authors:[uuid]}],
  editions:[],revisions:[],rightsRecords:[]}};
describe('verified local batch staging boundary',()=>{
  it('hashes staged JSON independent of object property ordering',()=>{
    expect(canonicalJson({z:2,a:{z:1,a:'x'}})).toEqual(canonicalJson({a:{a:'x',z:1},z:2}));
    expect(payloadHash({text:'A',n:1})).toEqual(payloadHash({n:1,text:'A'}));
    expect(payloadHash({n:1,text:'A'})).not.toEqual(payloadHash({n:1,text:'A '}));
  });
  it('rejects unsigned versions, non-UUID links and nonlocal work author references',()=>{
    expect(preparedImportSchema.safeParse(packageData).success).toBe(true);
    expect(preparedImportSchema.safeParse({...packageData,schemaVersion:'2.0.0'}).success).toBe(false);
    expect(preparedImportSchema.safeParse({...packageData,records:{...packageData.records,works:[{...packageData.records.works[0],authors:[other]}]}}).success).toBe(false);
    expect(preparedImportSchema.safeParse({...packageData,manifestChecksum:'unverified'}).success).toBe(false);
  });
});

const editionId='9d4c3c6a-6045-4c16-8c87-991eb78dce03';
const revisionId='9d4c3c6a-6045-4c16-8c87-991eb78dce04';
const anotherWorkId='9d4c3c6a-6045-4c16-8c87-991eb78dce05';
const extended={...packageData,records:{...packageData.records,
  editions:[{id:editionId,work_id:other,language:'tr'}],
  revisions:[{id:revisionId,edition_id:editionId,language:'tr',source_sha256:'b'.repeat(64)}],
  rightsRecords:[{work_id:other,edition_id:editionId,revision_id:revisionId,
    evidence:'Synthetic rights evidence requires manual human review.'}],
}};
describe('cross-scope package relationships are checked before DB staging',()=>{
  it('accepts a coherent draft package without approving rights',()=>{
    expect(preparedImportSchema.safeParse(extended).success).toBe(true);
  });
  it('rejects a revision language mismatch before any write',()=>{
    const bad={...extended,records:{...extended.records,revisions:[
      {...extended.records.revisions[0],language:'en'},
    ]}};
    expect(preparedImportSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects rights mixing two valid works in the same package',()=>{
    const bad={...extended,records:{...extended.records,
      works:[...extended.records.works,{id:anotherWorkId,original_title:'Other',
        original_language:'en',authors:[uuid]}],
      rightsRecords:[{...extended.records.rightsRecords[0],work_id:anotherWorkId}],
    }};
    expect(preparedImportSchema.safeParse(bad).success).toBe(false);
  });
  it('does not allow the manifest to mark rights approved or the work published',()=>{
    const approved={...extended,records:{...extended.records,
      rightsRecords:[{...extended.records.rightsRecords[0],review_status:'approved'}],
    }};
    expect(preparedImportSchema.safeParse(approved).success).toBe(false);
    const published={...extended,records:{...extended.records,
      rightsRecords:[{...extended.records.rightsRecords[0],publication_status:'published'}],
    }};
    expect(preparedImportSchema.safeParse(published).success).toBe(false);
  });
  it('rejects duplicated work author IDs',()=>{
    const bad={...extended,records:{...extended.records,
      works:[{...extended.records.works[0],authors:[uuid,uuid]}],
    }};
    expect(preparedImportSchema.safeParse(bad).success).toBe(false);
  });
});
