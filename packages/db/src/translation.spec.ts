import {describe,expect,it} from 'vitest';
import {translationLinkCreateSchema,translationSwitchRequestSchema} from '@folio/contracts';
const source='a227e7f8-2f04-41e4-b764-ad9a2c558811';
const target='a227e7f8-2f04-41e4-b764-ad9a2c558812';
const block='a227e7f8-2f04-41e4-b764-ad9a2c558813';
const valid={sourceRevisionId:source,targetRevisionId:target,provenance:{kind:'manual_import',packageId:'ready-fixture'},alignments:[{sourceBlockId:block,targetBlockId:block}]};
describe('prepared translation links',()=>{
  it('never accepts a self-referential revision or generation provider',()=>{
    expect(translationLinkCreateSchema.safeParse(valid).success).toBe(true);
    expect(translationLinkCreateSchema.safeParse({...valid,targetRevisionId:source}).success).toBe(false);
    expect(translationLinkCreateSchema.safeParse({...valid,provenance:{kind:'auto-ai',packageId:'x'}}).success).toBe(false);
  });
  it('rejects duplicate block edge and unknown switch identifiers',()=>{
    expect(translationLinkCreateSchema.safeParse({...valid,alignments:[...valid.alignments,...valid.alignments]}).success).toBe(false);
    expect(translationSwitchRequestSchema.safeParse({linkId:'bad',sourceBlockId:block}).success).toBe(false);
  });
});
