import {describe,expect,it} from 'vitest';
import {
  adminCatalogAuthorPageSchema,adminCatalogSearchQuerySchema,
  adminCatalogWorkPageSchema,
} from './index.js';

const id='a7d09a10-d218-4e7f-8871-cb93dab6bf23';
const page={items:[{id,originalTitle:'Test Work',originalLanguage:'tr',publicationStatus:'draft'}],
  nextCursor:null};

describe('admin-only canonical metadata search contracts',()=>{
  it('requires a query and rejects user/role selectors and unbounded pagination',()=>{
    expect(adminCatalogSearchQuerySchema.parse({q:'  Folio  '})).toEqual({
      q:'Folio',limit:20,
    });
    expect(adminCatalogSearchQuerySchema.parse({q:'work',limit:'50',cursor:id}))
      .toEqual({q:'work',limit:50,cursor:id});
    for(const invalid of [
      {},{q:''},{q:'   '},{q:'a'.repeat(121)},
      {q:'title',limit:0},{q:'title',limit:'00'},
      {q:'title',limit:51},{q:'title',limit:'999'},
      {q:'title',limit:1.1},{q:'title',cursor:'malformed'},
      {q:'title',userId:id},{q:'title',role:'superadmin'},
      {q:'title',country:'US'}, {q:['title']},
    ]){
      expect(adminCatalogSearchQuerySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('returns strict work/author metadata without private bodies or session identifiers',()=>{
    expect(adminCatalogWorkPageSchema.parse(page)).toEqual(page);
    const authors={items:[{id,canonicalName:'A Writer',sortName:'Writer, A'}],
      nextCursor:null};
    expect(adminCatalogAuthorPageSchema.parse(authors)).toEqual(authors);
    for(const invalid of [
      {...page,items:[{...page.items[0],body:'PRIVATE BOOK CONTENT'}]},
      {...page,items:[{...page.items[0],ownerId:id}]},
      {...page,items:[{...page.items[0],email:'private@example.com'}]},
      {...page,sessionToken:'A'.repeat(43)},
      {...page,items:[{...page.items[0],originalLanguage:'fr'}]},
      {...page,nextCursor:'not-a-uuid'},
      {...page,items:Array.from({length:51},()=>page.items[0])},
    ]){
      expect(adminCatalogWorkPageSchema.safeParse(invalid).success).toBe(false);
    }
    expect(adminCatalogAuthorPageSchema.safeParse({
      ...authors,items:[{...authors.items[0],phone:'private'}],
    }).success).toBe(false);
  });
});
