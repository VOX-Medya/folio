import {describe, expect, it} from 'vitest';
import {authorCreateSchema, workCreateSchema} from '@folio/contracts';

describe('canonical author/work create contracts', () => {
  const authorId = '9a77012c-bc47-4539-aebf-539bcc74007e';
  it('requires a canonical author name and validates alias/foreign-ID metadata', () => {
    expect(authorCreateSchema.safeParse({canonicalName: ' ', aliases: [], externalIds: []}).success).toBe(false);
    expect(authorCreateSchema.safeParse({canonicalName: 'Example', aliases: [{name: 'Alias',locale:'en'}]}).success).toBe(true);
  });
  it('requires at least one real author and blocks repeated author links', () => {
    const work = {originalTitle: 'Draft', originalLanguage: 'tr', authors: [{authorId}]};
    expect(workCreateSchema.safeParse({...work,authors:[]}).success).toBe(false);
    expect(workCreateSchema.safeParse({...work,authors:[{authorId},{authorId}]}).success).toBe(false);
    expect(workCreateSchema.safeParse(work).success).toBe(true);
  });
  it('permits multiple translations/editions and repeated ISBN across different editions', () => {
    expect(workCreateSchema.safeParse({originalTitle:'Draft',originalLanguage:'tr',authors:[{authorId}],editions:[
      {language:'tr',label:'TR',identifiers:[{kind:'isbn-13',value:'9780000000001'}]},
      {language:'en',label:'EN',identifiers:[{kind:'isbn-13',value:'9780000000001'}]},
    ]}).success).toBe(true);
  });
});
