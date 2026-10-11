import {and,eq,ilike,inArray,or} from 'drizzle-orm';
import {z} from 'zod';
import {publishedCatalogSearchPageSchema,publishedCatalogSearchQuerySchema} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';
import {getPublishedBookDetail} from './published-book.js';

type Database=ReturnType<typeof createFolioDb>['db'];
const contains=(value:string)=>'%'+value.replace(/[\\%_]/g,'\\$&')+'%';

/** Search ONLY books and authors, never accounts or private draft metadata. */
export async function searchPublishedCatalog(db:Database,raw:unknown,territory:string){
  const input=publishedCatalogSearchQuerySchema.parse(raw);
  z.string().regex(/^[A-Z]{2}$/).parse(territory);
  const pattern=contains(input.q);
  const authorMatches=db.select({authorId:schema.authors.id})
    .from(schema.authors).where(ilike(schema.authors.canonicalName,pattern));
  const workMatches=db.select({workId:schema.workAuthors.workId})
    .from(schema.workAuthors).where(inArray(schema.workAuthors.authorId,authorMatches));
  // Small first-catalog bounded candidate scan; rights filtering occurs BEFORE return.
  const ids=await db.select({id:schema.works.id}).from(schema.works).where(and(
    eq(schema.works.publicationStatus,'published'),
    or(ilike(schema.works.originalTitle,pattern),inArray(schema.works.id,workMatches)),
  )).orderBy(schema.works.id).limit(100);
  const items: Array<{
    id:string;title:string;authors:string[];editionId:string;revisionId:string;
    audioAvailable:boolean;
  }>=[];
  for(const item of ids){
    const work=await getPublishedBookDetail(db,item.id,territory);
    if(!work)continue;
    const first=work.editions[0];
    if(!first)continue;
    items.push({id:work.id,title:work.title,authors:work.authors.map(a=>a.name),
      editionId:first.id,revisionId:first.revisionId,audioAvailable:first.audioAvailable});
    if(items.length>=input.limit)break;
  }
  return publishedCatalogSearchPageSchema.parse({items});
}
