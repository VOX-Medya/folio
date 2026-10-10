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
