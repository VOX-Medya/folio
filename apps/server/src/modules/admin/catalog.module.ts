import {
  BadRequestException,Body,CanActivate,ConflictException,Controller,
  Delete,ExecutionContext,ForbiddenException,Get,Header,Inject,Injectable,Module,
  NotFoundException,OnModuleDestroy,Param,Patch,Post,Query,Req,ServiceUnavailableException,
  UnauthorizedException,UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,ApiBody,ApiCreatedResponse,ApiOkResponse,
  ApiOperation,ApiParam,ApiQuery,ApiSecurity,ApiTags,
} from '@nestjs/swagger';
import {
  authenticateUserSession,createFolioDb,createVerifiedAdminDraftAuthor,
  createVerifiedAdminDraftWork,getVerifiedAdminAuthorDetails,
  getVerifiedAdminWorkDetails,patchVerifiedAdminAuthorMetadata,
  patchVerifiedAdminWorkMetadata,appendVerifiedAdminWorkEdition,
  appendVerifiedAdminWorkTitle,appendVerifiedAdminWorkAuthor,
  removeVerifiedAdminWorkTitle,removeVerifiedAdminWorkAuthor,
  patchVerifiedAdminWorkTitleMetadata,patchVerifiedAdminWorkAuthorMetadata,
  removeVerifiedAdminEmptyDraftEdition,
  patchVerifiedAdminEditionMetadata,getVerifiedAdminRevisionMetadataDiff,
  getVerifiedAdminEditionRevisions,getVerifiedAdminRightsLedger,
  searchVerifiedAdminAuthors,searchVerifiedAdminWorks,
  proposeVerifiedAdminWorkMatchReview,decideVerifiedAdminWorkMatchReview,
  listVerifiedAdminWorkMatchReviews,
  proposeVerifiedAdminImportCandidateReview,decideVerifiedAdminImportCandidateReview,
  listVerifiedAdminImportCandidateReviews,
} from '@folio/db';
import {
  adminCatalogAuthorCreatedSchema,adminCatalogAuthorDetailSchema,
  adminCatalogAuthorPageSchema,adminCatalogIdSchema,
  canonicalAuthorMetadataPatchSchema,canonicalWorkMetadataPatchSchema,
  canonicalAuthorMetadataUpdatedSchema,canonicalWorkMetadataUpdatedSchema,
  adminCatalogSearchQuerySchema,adminCatalogWorkCreatedSchema,
  adminCatalogWorkPageSchema,adminCatalogWorkDetailSchema,
  authorCreateSchema,workCreateSchema,
  adminCatalogEditionAppendSchema,adminCatalogTitleAppendSchema,
  adminCatalogWorkAuthorAppendSchema,adminCatalogEditionAppendedSchema,
  adminCatalogEditionMetadataPatchSchema,adminCatalogEditionMetadataUpdatedSchema,
  adminCatalogTitleAppendedSchema,adminCatalogWorkAuthorAppendedSchema,
  adminCatalogRelationRemoveSchema,adminCatalogTitleMetadataPatchSchema,
  adminCatalogWorkAuthorMetadataPatchSchema,adminCatalogEditionRemovedSchema,
  adminWorkMatchProposeSchema,adminWorkMatchDecisionSchema,
  adminWorkMatchQuerySchema,adminWorkMatchResultSchema,
  adminWorkMatchPageSchema,
  adminImportCandidateProposeSchema,adminImportCandidateResultSchema,
  adminImportCandidatePageSchema,
  adminCatalogRevisionDiffQuerySchema,adminCatalogRevisionDiffSchema,
  adminCatalogRevisionListQuerySchema,adminCatalogRevisionListSchema,
  adminCatalogRightsLedgerQuerySchema,adminCatalogRightsLedgerSchema,
} from '@folio/contracts';
import {
  VERIFIED_SESSION_LOOKUP,VerifiedSelfSessionGuard,
} from '../../common/session-auth.js';
import type {BearerSessionLookup} from '../../common/session-auth.js';
import {verifiedWebCookieBearer} from '../../common/web-cookie-session.js';

interface CatalogRequest {
  socket?:{encrypted?:boolean};
  headers?:Record<string,string|string[]|undefined>;
  method?:string;
  requestId?:string;
  auth?:{userId:string;sessionId:string};
}

/**
 * Nothing serves draft metadata unless an operator explicitly opts into
 * direct application TLS. Untrusted X-Forwarded-Proto cannot open this gate.
 * A role/MFA proof is still required after the transport is admitted.
 */
@Injectable()
export class AdminCatalogOptInGuard implements CanActivate {
  canActivate(context:ExecutionContext):boolean{
    if(process.env.FOLIO_ADMIN_CATALOG_HTTP_MODE!=='direct-tls-only'){
      throw new NotFoundException('Admin catalog search unavailable');
    }
    const request=context.switchToHttp().getRequest<CatalogRequest>();
    if(request.socket?.encrypted!==true){
      throw new ServiceUnavailableException('Verified application HTTPS required');
    }
    return true;
  }
}

/** An independent explicit opt-in: enabling catalog READ never enables writes. */
@Injectable()
export class AdminCatalogWriteGuard implements CanActivate {
  canActivate():boolean{
    if(process.env.FOLIO_ADMIN_CATALOG_WRITE_MODE!=='direct-tls-only'){
      throw new NotFoundException('Admin catalog draft creation unavailable');
    }
    return true;
  }
}

@Injectable()
export class AdminCatalogDb implements OnModuleDestroy {
  private readonly connection=process.env.DATABASE_URL
    ?createFolioDb(process.env.DATABASE_URL):undefined;
  private db(){
    if(!this.connection)throw new ServiceUnavailableException('Catalog database unavailable');
    return this.connection.db;
  }
  verify(bearer:string){return authenticateUserSession(this.db(),bearer);}
  private async authorized<T>(work:()=>Promise<T>):Promise<T>{
    try{return await work();}
    catch(error){
      if(error instanceof Error&&
        error.message==='Verified administrator MFA permission required'){
        throw new ForbiddenException('Current administrator MFA permission required');
      }
      if(error instanceof Error&&['Verified independent catalog reviewer required',
        'Independent import candidate reviewer required'].includes(error.message)){
        throw new ForbiddenException('An independently authenticated catalog editor must review');
      }
      if(error instanceof Error&&error.message==='Cannot compare a canonical work to itself'){
        throw new BadRequestException('Select two different canonical works');
      }
      if(error instanceof Error&&[
        'Canonical metadata version conflict',
        'Published canonical work is immutable via draft editor',
        'Published canonical edition is immutable via draft editor',
        'Canonical original title cannot be unlinked',
        'Last canonical author link cannot be removed',
        'Last canonical author cannot be demoted to editor',
        'Canonical original title cannot be edited through optional title editor',
        'Edition with source revisions or rights cannot be removed',
        'Canonical work match review is stale or unavailable',
        'Import candidate review stale or evidence unavailable',
        'Incoming claim does not match canonical title or source digest',
        'Import package UUID reused with different checksum',
      ].includes(error.message)){
        throw new ConflictException('Canonical metadata changed or is no longer editable');
      }
      // Drizzle may wrap a PostgreSQL error in a cause chain. Never include
      // SQL, stack, token, constraint names or arbitrary PG details in HTTP.
      let candidate:unknown=error;
      for(let depth=0;depth<4;depth++){
        if(!candidate||typeof candidate!=='object')break;
        const code='code' in candidate?candidate.code:undefined;
        if(code==='23503'){
          throw new BadRequestException('Unknown canonical author or contributor');
        }
        if(code==='23505'){
          throw new ConflictException('Canonical identifier already exists');
        }
        if(code==='23514'){
          throw new BadRequestException('Invalid canonical catalog relationship');
        }
        candidate='cause' in candidate?candidate.cause:undefined;
      }
      throw new ServiceUnavailableException('Administrator catalog operation unavailable');
    }
  }
  works(bearer:string,input:unknown){
    return this.authorized(()=>searchVerifiedAdminWorks(this.db(),bearer,input));
  }
  authors(bearer:string,input:unknown){
    return this.authorized(()=>searchVerifiedAdminAuthors(this.db(),bearer,input));
  }
  workDetail(bearer:string,id:string){
    return this.authorized(()=>getVerifiedAdminWorkDetails(this.db(),bearer,id));
  }
  revisionDiff(bearer:string,input:unknown){
    return this.authorized(()=>getVerifiedAdminRevisionMetadataDiff(this.db(),bearer,input));
  }
  revisionList(bearer:string,input:unknown){
    return this.authorized(()=>getVerifiedAdminEditionRevisions(this.db(),bearer,input));
  }
  rightsLedger(bearer:string,input:unknown){
    return this.authorized(()=>getVerifiedAdminRightsLedger(this.db(),bearer,input));
  }
  authorDetail(bearer:string,id:string){
    return this.authorized(()=>getVerifiedAdminAuthorDetails(this.db(),bearer,id));
  }
  createAuthor(bearer:string,input:unknown,requestId:string){
    return this.authorized(()=>
      createVerifiedAdminDraftAuthor(this.db(),bearer,input,requestId));
  }
  createWork(bearer:string,input:unknown,requestId:string){
    return this.authorized(()=>
      createVerifiedAdminDraftWork(this.db(),bearer,input,requestId));
  }
  patchAuthor(bearer:string,id:string,input:unknown,requestId:string){
    return this.authorized(()=>
      patchVerifiedAdminAuthorMetadata(this.db(),bearer,id,input,requestId));
  }
  patchWork(bearer:string,id:string,input:unknown,requestId:string){
    return this.authorized(()=>
      patchVerifiedAdminWorkMetadata(this.db(),bearer,id,input,requestId));
  }
  appendEdition(bearer:string,id:string,input:unknown,requestId:string){
    return this.authorized(()=>
      appendVerifiedAdminWorkEdition(this.db(),bearer,id,input,requestId));
  }
  patchEdition(bearer:string,workId:string,editionId:string,input:unknown,requestId:string){
    return this.authorized(()=>
      patchVerifiedAdminEditionMetadata(this.db(),bearer,workId,editionId,input,requestId));
  }
  appendTitle(bearer:string,id:string,input:unknown,requestId:string){
    return this.authorized(()=>
      appendVerifiedAdminWorkTitle(this.db(),bearer,id,input,requestId));
  }
  appendAuthor(bearer:string,id:string,input:unknown,requestId:string){
    return this.authorized(()=>
      appendVerifiedAdminWorkAuthor(this.db(),bearer,id,input,requestId));
  }
  removeTitle(bearer:string,workId:string,titleId:string,input:unknown,requestId:string){
    return this.authorized(()=>
      removeVerifiedAdminWorkTitle(this.db(),bearer,workId,titleId,input,requestId));
  }
  removeAuthor(bearer:string,workId:string,authorId:string,input:unknown,requestId:string){
    return this.authorized(()=>
      removeVerifiedAdminWorkAuthor(this.db(),bearer,workId,authorId,input,requestId));
  }
  listMatchReviews(bearer:string,workId:string,input:unknown){
    return this.authorized(()=>
      listVerifiedAdminWorkMatchReviews(this.db(),bearer,workId,input));
  }
  proposeMatchReview(bearer:string,workId:string,input:unknown,requestId:string){
    return this.authorized(()=>
      proposeVerifiedAdminWorkMatchReview(this.db(),bearer,workId,input,requestId));
  }
  decideMatchReview(bearer:string,workId:string,reviewId:string,input:unknown,requestId:string){
    return this.authorized(()=>
      decideVerifiedAdminWorkMatchReview(this.db(),bearer,workId,reviewId,input,requestId));
  }
  listImportCandidateReviews(bearer:string,id:string,query:unknown){
    return this.authorized(()=>listVerifiedAdminImportCandidateReviews(this.db(),bearer,id,query));
  }
  proposeImportCandidateReview(bearer:string,id:string,input:unknown,trace:string){
    return this.authorized(()=>proposeVerifiedAdminImportCandidateReview(this.db(),bearer,id,input,trace));
  }
  decideImportCandidateReview(bearer:string,id:string,reviewId:string,input:unknown,trace:string){
    return this.authorized(()=>decideVerifiedAdminImportCandidateReview(this.db(),bearer,id,reviewId,input,trace));
  }
  patchTitle(bearer:string,workId:string,titleId:string,input:unknown,trace:string){
    return this.authorized(()=>
      patchVerifiedAdminWorkTitleMetadata(this.db(),bearer,workId,titleId,input,trace));
  }
  patchAuthorLink(bearer:string,workId:string,authorId:string,input:unknown,trace:string){
    return this.authorized(()=>
      patchVerifiedAdminWorkAuthorMetadata(this.db(),bearer,workId,authorId,input,trace));
  }
  removeEmptyEdition(bearer:string,workId:string,editionId:string,input:unknown,trace:string){
    return this.authorized(()=>
      removeVerifiedAdminEmptyDraftEdition(this.db(),bearer,workId,editionId,input,trace));
  }
  async onModuleDestroy():Promise<void>{await this.connection?.pool.end();}
}

const queryDocs=[
  {name:'q',required:true,type:String,maxLength:120},
  {name:'limit',required:false,type:Number,minimum:1,maximum:50},
  {name:'cursor',required:false,type:String,format:'uuid'},
];
const pageProps={
  nextCursor:{type:'string',format:'uuid',nullable:true},
};
const workPageApi={
  type:'object',additionalProperties:false,required:['items','nextCursor'],
  properties:{
    items:{type:'array',maxItems:50,items:{
      type:'object',additionalProperties:false,
      required:['id','originalTitle','originalLanguage','publicationStatus'],
      properties:{
        id:{type:'string',format:'uuid'},
        originalTitle:{type:'string'},
        originalLanguage:{type:'string',enum:['tr','en']},
        publicationStatus:{type:'string'},
      },
    }},
    ...pageProps,
  },
};
const authorPageApi={
  type:'object',additionalProperties:false,required:['items','nextCursor'],
  properties:{
    items:{type:'array',maxItems:50,items:{
      type:'object',additionalProperties:false,
      required:['id','canonicalName','sortName'],
      properties:{
        id:{type:'string',format:'uuid'},
        canonicalName:{type:'string'},
        sortName:{type:'string'},
      },
    }},
    ...pageProps,
  },
};


// A tightly projected OpenAPI schema. Never serialize entire DB rows or
// private reader/content, provenance, source artifacts, rights or user data.
const detailUuidApi={type:'string',format:'uuid'};
const revisionPositionApi={
  type:'object',additionalProperties:false,
  required:['chapterId','ordinal','kind','textSha256','includeNormal','includeRsvp','includeAudio'],
  properties:{
    chapterId:detailUuidApi,
    ordinal:{type:'integer',minimum:0},
    kind:{type:'string',enum:[
      'paragraph','heading','footnote','page_number','running_header',
      'publisher_note','preface','endnote','poetry','quote','list','image_ref',
    ]},
    textSha256:{type:'string',pattern:'^[0-9a-f]{64}$'},
    includeNormal:{type:'boolean'},includeRsvp:{type:'boolean'},includeAudio:{type:'boolean'},
  },
};
const rightsLedgerResultApi={
  type:'object',additionalProperties:false,
  required:['workId','items','nextCursor','isMetadataOnly'],
  properties:{
    workId:{type:'string',format:'uuid'},
    items:{type:'array',maxItems:50,items:{
      type:'object',additionalProperties:false,
      required:['id','editionId','revisionId','reviewStatus',
        'territories','claims','expiresAt'],
      properties:{
        id:{type:'string',format:'uuid'},
        editionId:{type:'string',format:'uuid',nullable:true},
        revisionId:{type:'string',format:'uuid',nullable:true},
        reviewStatus:{type:'string',enum:['pending','approved','rejected','withdrawn']},
        territories:{type:'array',maxItems:250,items:{type:'string',pattern:'^[A-Z]{2}$'}},
        claims:{type:'object',additionalProperties:false,
          required:['display','translation','audio','sharing'],
          properties:{
            display:{type:'boolean'},translation:{type:'boolean'},
            audio:{type:'boolean'},sharing:{type:'boolean'},
          },
        },
        expiresAt:{type:'string',format:'date-time',nullable:true},
      },
    }},
    nextCursor:{type:'string',format:'uuid',nullable:true},
    isMetadataOnly:{type:'boolean',enum:[true]},
  },
};
const revisionListResultApi={
  type:'object',additionalProperties:false,
  required:['editionId','items','nextCursor','isMetadataOnly'],
  properties:{
    editionId:{type:'string',format:'uuid'},
    items:{type:'array',maxItems:50,items:{
      type:'object',additionalProperties:false,
      required:['id','parentRevisionId','language','status'],
      properties:{
        id:{type:'string',format:'uuid'},
        parentRevisionId:{type:'string',format:'uuid',nullable:true},
        language:{type:'string',enum:['tr','en']},
        status:{type:'string',minLength:1,maxLength:24},
      },
    }},
    nextCursor:{type:'string',format:'uuid',nullable:true},
    isMetadataOnly:{type:'boolean',enum:[true]},
  },
};
const revisionDiffResultApi={
  type:'object',additionalProperties:false,
  required:['editionId','fromRevisionId','toRevisionId','summary','chapterChanges',
    'items','nextCursor','isMetadataOnly'],
  properties:{
    editionId:detailUuidApi,fromRevisionId:detailUuidApi,toRevisionId:detailUuidApi,
    summary:{type:'object',additionalProperties:false,
      required:['added','removed','text_changed','metadata_changed','moved','unchanged'],
      properties:Object.fromEntries(
        ['added','removed','text_changed','metadata_changed','moved','unchanged']
          .map(key=>[key,{type:'integer',minimum:0}])),
    },
    chapterChanges:{type:'array',maxItems:10000,items:{
      type:'object',additionalProperties:false,required:['chapterId','kind'],
      properties:{
        chapterId:detailUuidApi,kind:{type:'string',enum:['added','removed','renamed','moved']},
      },
    }},
    items:{type:'array',maxItems:100,items:{
      type:'object',additionalProperties:false,required:['blockId','kind','before','after'],
      properties:{
        blockId:detailUuidApi,
        kind:{type:'string',enum:['added','removed','text_changed','metadata_changed','moved']},
        before:{...revisionPositionApi,nullable:true},
        after:{...revisionPositionApi,nullable:true},
      },
    }},
    nextCursor:{...detailUuidApi,nullable:true},
    isMetadataOnly:{type:'boolean',enum:[true]},
  },
};

const workDetailApi={
  type:'object',additionalProperties:false,
  required:['work','authors','titles','editions'],
  properties:{
    work:{type:'object',additionalProperties:false,
      required:['id','originalTitle','originalLanguage','firstPublicationYear','publicationStatus','metadataVersion'],
      properties:{
        id:detailUuidApi,originalTitle:{type:'string'},
        originalLanguage:{type:'string',enum:['tr','en']},
        firstPublicationYear:{type:'integer',nullable:true},
        publicationStatus:{type:'string'},
        metadataVersion:{type:'integer',minimum:0},
      },
    },
    authors:{type:'array',maxItems:250,items:{
      type:'object',additionalProperties:false,required:['id','name','role','sortOrder'],
      properties:{
        id:detailUuidApi,name:{type:'string'},
        role:{type:'string',enum:['author','co-author','editor']},
        sortOrder:{type:'integer',minimum:0},
      },
    }},
    titles:{type:'array',maxItems:250,items:{
      type:'object',additionalProperties:false,
      required:['id','language','title','kind'],
      properties:{
        id:detailUuidApi,language:{type:'string',enum:['tr','en']},
        title:{type:'string'},
        kind:{type:'string',enum:['original','translation','alternate']},
      },
    }},
    editions:{type:'array',maxItems:250,items:{
      type:'object',additionalProperties:false,
      required:['id','language','label','publisher','status','identifiers','contributors'],
      properties:{
        id:detailUuidApi,language:{type:'string',enum:['tr','en']},
        label:{type:'string'},publisher:{type:'string',nullable:true},
        status:{type:'string'},
        identifiers:{type:'array',maxItems:250,items:{
          type:'object',additionalProperties:false,required:['kind','value'],
          properties:{
            kind:{type:'string',enum:['isbn-10','isbn-13','other']},
            value:{type:'string'},
          },
        }},
        contributors:{type:'array',maxItems:250,items:{
          type:'object',additionalProperties:false,
          required:['authorId','role','sortOrder'],
          properties:{
            authorId:detailUuidApi,
            role:{type:'string',enum:['author','translator','editor','illustrator']},
            sortOrder:{type:'integer',minimum:0},
          },
        }},
      },
    }},
  },
};
const authorDetailApi={
  type:'object',additionalProperties:false,required:['author','aliases','externalIds'],
  properties:{
    author:{type:'object',additionalProperties:false,
      required:['id','canonicalName','sortName','metadataVersion'],
      properties:{
        id:detailUuidApi,canonicalName:{type:'string'},sortName:{type:'string'},
        metadataVersion:{type:'integer',minimum:0},
      },
    },
    aliases:{type:'array',maxItems:500,items:{
      type:'object',additionalProperties:false,required:['id','name','locale'],
      properties:{
        id:detailUuidApi,name:{type:'string'},
        locale:{type:'string',nullable:true},
      },
    }},
    externalIds:{type:'array',maxItems:500,items:{
      type:'object',additionalProperties:false,required:['source','externalId'],
      properties:{
        source:{type:'string'},externalId:{type:'string'},
      },
    }},
  },
};

const authorInputApi={
  type:'object',additionalProperties:false,required:['canonicalName'],
  properties:{
    canonicalName:{type:'string',minLength:1,maxLength:240},
    sortName:{type:'string',minLength:1,maxLength:240},
    aliases:{type:'array',maxItems:30,items:{
      type:'object',additionalProperties:false,required:['name'],
      properties:{
        name:{type:'string',minLength:1,maxLength:240},
        locale:{type:'string',minLength:2,maxLength:12},
      },
    }},
    externalIds:{type:'array',maxItems:30,items:{
      type:'object',additionalProperties:false,required:['source','externalId'],
      properties:{
        source:{type:'string',minLength:1,maxLength:80},
        externalId:{type:'string',minLength:1,maxLength:400},
      },
    }},
  },
};
const contributorId={type:'string',format:'uuid'};
const workInputApi={
  type:'object',additionalProperties:false,
  required:['originalTitle','originalLanguage','authors'],
  properties:{
    originalTitle:{type:'string',minLength:1,maxLength:600},
    originalLanguage:{type:'string',enum:['tr','en']},
    firstPublicationYear:{type:'integer',minimum:-4000,maximum:2500,nullable:true},
    authors:{type:'array',minItems:1,maxItems:50,items:{
      type:'object',additionalProperties:false,required:['authorId'],
      properties:{
        authorId:contributorId,
        contribution:{type:'string',enum:['author','co-author','editor'],default:'author'},
        sortOrder:{type:'integer',minimum:0,maximum:10000,default:0},
      },
    }},
    titles:{type:'array',maxItems:40,items:{
      type:'object',additionalProperties:false,
      required:['language','title','kind'],
      properties:{
        language:{type:'string',enum:['tr','en']},
        title:{type:'string',minLength:1,maxLength:600},
        kind:{type:'string',enum:['original','translation','alternate']},
      },
    }},
    editions:{type:'array',maxItems:50,items:{
      type:'object',additionalProperties:false,required:['language','label'],
      properties:{
        language:{type:'string',enum:['tr','en']},
        label:{type:'string',minLength:1,maxLength:400},
        publisher:{type:'string',maxLength:240},
        identifiers:{type:'array',maxItems:30,items:{
          type:'object',additionalProperties:false,required:['kind','value'],
          properties:{
            kind:{type:'string',enum:['isbn-10','isbn-13','other']},
            value:{type:'string',minLength:1,maxLength:150},
          },
        }},
        contributors:{type:'array',maxItems:50,items:{
          type:'object',additionalProperties:false,required:['authorId','role'],
          properties:{
            authorId:contributorId,
            role:{type:'string',enum:['author','translator','editor','illustrator']},
            sortOrder:{type:'integer',minimum:0,default:0},
          },
        }},
      },
    }},
  },
};
const authorMetadataPatchApi={
  type:'object',additionalProperties:false,required:['expectedVersion'],
  anyOf:[
    {required:['canonicalName']},{required:['sortName']},
    {required:['aliases']},{required:['externalIds']},
  ],
  properties:{
    expectedVersion:{type:'integer',minimum:0,maximum:2147483646},
    canonicalName:{type:'string',minLength:1,maxLength:240},
    sortName:{type:'string',minLength:1,maxLength:240},
    aliases:authorInputApi.properties.aliases,
    externalIds:authorInputApi.properties.externalIds,
  },
};
const workMetadataPatchApi={
  type:'object',additionalProperties:false,required:['expectedVersion'],
  anyOf:[{required:['originalTitle']},{required:['firstPublicationYear']}],
  properties:{
    expectedVersion:{type:'integer',minimum:0,maximum:2147483646},
    originalTitle:{type:'string',minLength:1,maxLength:600},
    firstPublicationYear:{type:'integer',minimum:-4000,maximum:2500,nullable:true},
  },
};
const updatedAuthorApi={
  type:'object',additionalProperties:false,required:['id','metadataVersion'],
  properties:{id:detailUuidApi,metadataVersion:{type:'integer',minimum:0}},
};
const updatedWorkApi={
  type:'object',additionalProperties:false,
  required:['id','metadataVersion','publicationStatus'],
  properties:{
    id:detailUuidApi,
    metadataVersion:{type:'integer',minimum:0},
    publicationStatus:{type:'string',enum:['draft']},
  },
};


const metadataVersionApi={type:'integer',minimum:0};
const appendEditionBodyApi={
  type:'object',additionalProperties:false,
  required:['expectedVersion','language','label'],
  properties:{
    expectedVersion:{type:'integer',minimum:0,maximum:2147483646},
    language:{type:'string',enum:['tr','en']},
    label:{type:'string',minLength:1,maxLength:400},
    publisher:{type:'string',maxLength:240},
    identifiers:{type:'array',maxItems:30,items:{
      type:'object',additionalProperties:false,required:['kind','value'],
      properties:{
        kind:{type:'string',enum:['isbn-10','isbn-13','other']},
        value:{type:'string',minLength:1,maxLength:150},
      },
    }},
    contributors:{type:'array',maxItems:50,items:{
      type:'object',additionalProperties:false,required:['authorId','role'],
      properties:{
        authorId:detailUuidApi,
        role:{type:'string',enum:['author','translator','editor','illustrator']},
        sortOrder:{type:'integer',minimum:0,maximum:10000,default:0},
      },
    }},
  },
};
const patchEditionBodyApi={
  type:'object',additionalProperties:false,required:['expectedVersion'],
  anyOf:[
    {required:['label']},{required:['publisher']},
    {required:['identifiers']},{required:['contributors']},
  ],
  properties:{
    expectedVersion:{type:'integer',minimum:0,maximum:2147483646},
    label:{type:'string',minLength:1,maxLength:400},
    publisher:{type:'string',maxLength:240,nullable:true},
    identifiers:appendEditionBodyApi.properties.identifiers,
    contributors:appendEditionBodyApi.properties.contributors,
  },
};
const appendTitleBodyApi={
  type:'object',additionalProperties:false,
  required:['expectedVersion','language','title','kind'],
  properties:{
    expectedVersion:{type:'integer',minimum:0,maximum:2147483646},
    language:{type:'string',enum:['tr','en']},
    title:{type:'string',minLength:1,maxLength:600},
    kind:{type:'string',enum:['translation','alternate']},
  },
};
const appendAuthorBodyApi={
  type:'object',additionalProperties:false,
  required:['expectedVersion','authorId'],
  properties:{
    expectedVersion:{type:'integer',minimum:0,maximum:2147483646},
    authorId:detailUuidApi,
    contribution:{type:'string',enum:['author','co-author','editor'],default:'author'},
    sortOrder:{type:'integer',minimum:0,maximum:10000,default:0},
  },
};
const patchOptionalTitleBodyApi={
  type:'object',additionalProperties:false,required:['expectedVersion'],
  anyOf:[{required:['title']},{required:['language']},{required:['kind']}],
  properties:{
    expectedVersion:{type:'integer',minimum:0,maximum:2147483646},
    title:{type:'string',minLength:1,maxLength:600},
    language:{type:'string',enum:['tr','en']},
    kind:{type:'string',enum:['alternate','translation']},
  },
};
const patchWorkAuthorBodyApi={
  type:'object',additionalProperties:false,required:['expectedVersion'],
  anyOf:[{required:['contribution']},{required:['sortOrder']}],
  properties:{
    expectedVersion:{type:'integer',minimum:0,maximum:2147483646},
    contribution:{type:'string',enum:['author','co-author','editor']},
    sortOrder:{type:'integer',minimum:0,maximum:10000},
  },
};
const removeEmptyEditionResultApi={
  type:'object',additionalProperties:false,
  required:['id','workId','metadataVersion','removed'],
  properties:{
    id:detailUuidApi,workId:detailUuidApi,
    metadataVersion:{type:'integer',minimum:0},
    removed:{type:'boolean',enum:[true]},
  },
};
const matchReviewProposeApi={
  type:'object',additionalProperties:false,required:['candidateWorkId'],
  properties:{candidateWorkId:detailUuidApi},
};
const matchReviewDecisionApi={
  type:'object',additionalProperties:false,
  required:['expectedVersion','decision','rationale'],
  properties:{
    expectedVersion:{type:'integer',minimum:0,maximum:2147483646},
    decision:{type:'string',enum:['distinct','deferred']},
    rationale:{type:'string',minLength:24,maxLength:1200},
  },
};
const matchReviewResultApi={
  type:'object',additionalProperties:false,
  required:['id','workId','candidateWorkId','status','reviewVersion','changed'],
  properties:{
    id:detailUuidApi,workId:detailUuidApi,candidateWorkId:detailUuidApi,
    status:{type:'string',enum:['pending','distinct','deferred']},
    reviewVersion:{type:'integer',minimum:0},changed:{type:'boolean'},
  },
};
const matchReviewPageApi={
  type:'object',additionalProperties:false,required:['items','nextCursor'],
  properties:{
    items:{type:'array',maxItems:20,items:{
      type:'object',additionalProperties:false,
      required:['id','workId','candidateWorkId','peerWorkId','peerTitle',
        'status','evidenceKind','reviewVersion','snapshotCurrent'],
      properties:{
        id:detailUuidApi,workId:detailUuidApi,candidateWorkId:detailUuidApi,
        peerWorkId:detailUuidApi,peerTitle:{type:'string',minLength:1,maxLength:600},
        status:{type:'string',enum:['pending','distinct','deferred']},
        evidenceKind:{type:'string',enum:['shared_source_sha256','same_title','manual']},
        reviewVersion:{type:'integer',minimum:0},snapshotCurrent:{type:'boolean'},
      },
    }},
    nextCursor:{type:'string',format:'uuid',nullable:true},
  },
};
const importCandidateProposeApi={
  type:'object',additionalProperties:false,
  required:['packageId','manifestChecksum','incomingWorkId','incomingTitle','incomingLanguage'],
  properties:{
    packageId:detailUuidApi,manifestChecksum:{type:'string',pattern:'^[a-f0-9]{64}$'},
    incomingWorkId:detailUuidApi,incomingTitle:{type:'string',minLength:1,maxLength:600},
    incomingLanguage:{type:'string',enum:['tr','en']},
    sourceSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
  },
};
const importCandidateResultApi={
  type:'object',additionalProperties:false,
  required:['id','candidateWorkId','packageId','incomingWorkId',
    'status','reviewVersion','changed','provenanceVerified'],
  properties:{
    id:detailUuidApi,candidateWorkId:detailUuidApi,packageId:detailUuidApi,
    incomingWorkId:detailUuidApi,
    status:{type:'string',enum:['pending','distinct','deferred']},
    reviewVersion:{type:'integer',minimum:0},changed:{type:'boolean'},
    provenanceVerified:{type:'boolean',enum:[false]},
  },
};
const importCandidatePageApi={
  type:'object',additionalProperties:false,required:['items','nextCursor'],
  properties:{
    items:{type:'array',maxItems:20,items:{
      type:'object',additionalProperties:false,
      required:['id','candidateWorkId','packageId','incomingWorkId','incomingTitle',
        'incomingLanguage','status','evidenceKind','reviewVersion','snapshotCurrent','provenanceVerified'],
      properties:{
        id:detailUuidApi,candidateWorkId:detailUuidApi,
        packageId:detailUuidApi,incomingWorkId:detailUuidApi,
        incomingTitle:{type:'string',minLength:1,maxLength:600},
        incomingLanguage:{type:'string',enum:['tr','en']},
        status:{type:'string',enum:['pending','distinct','deferred']},
        evidenceKind:{type:'string',enum:['claimed_source_sha256','claimed_title']},
        reviewVersion:{type:'integer',minimum:0},
        snapshotCurrent:{type:'boolean'},provenanceVerified:{type:'boolean',enum:[false]},
      },
    }},
    nextCursor:{type:'string',format:'uuid',nullable:true},
  },
};
const removeRelationBodyApi={
  type:'object',additionalProperties:false,required:['expectedVersion'],
  properties:{expectedVersion:{type:'integer',minimum:0,maximum:2147483646}},
};
const appendEditionResultApi={
  type:'object',additionalProperties:false,
  required:['id','workId','metadataVersion','status'],
  properties:{
    id:detailUuidApi,workId:detailUuidApi,
    metadataVersion:metadataVersionApi,status:{type:'string',enum:['draft']},
  },
};
const appendTitleResultApi={
  type:'object',additionalProperties:false,
  required:['id','workId','metadataVersion'],
  properties:{
    id:detailUuidApi,workId:detailUuidApi,
    metadataVersion:metadataVersionApi,
  },
};
const appendAuthorResultApi={
  type:'object',additionalProperties:false,
  required:['workId','authorId','metadataVersion'],
  properties:{
    workId:detailUuidApi,authorId:detailUuidApi,metadataVersion:metadataVersionApi,
  },
};

const authorCreatedApi={
  type:'object',additionalProperties:false,required:['id'],
  properties:{id:{type:'string',format:'uuid'}},
};
const workCreatedApi={
  type:'object',additionalProperties:false,required:['id','publicationStatus'],
  properties:{
    id:{type:'string',format:'uuid'},
    publicationStatus:{type:'string',enum:['draft']},
  },
};

@ApiTags('admin-catalog')
@ApiBearerAuth('folioSession')
@ApiSecurity('folioWebSession')
@Controller('v1/admin/catalog')
@UseGuards(AdminCatalogOptInGuard,VerifiedSelfSessionGuard)
export class AdminCatalogController {
  constructor(@Inject(AdminCatalogDb) private readonly store:AdminCatalogDb){}

  private parameters(raw:Record<string,unknown>){
    const parsed=adminCatalogSearchQuerySchema.safeParse(raw);
    if(!parsed.success)throw new BadRequestException('Invalid catalog search parameters');
    return {
      query:parsed.data.q,limit:parsed.data.limit,
      ...(parsed.data.cursor===undefined?{}:{cursor:parsed.data.cursor}),
    };
  }
  /**
   * The session guard verifies DB ownership. Re-extract only the credential
   * it verified, then the DB operation revalidates it WITH role/MFA locks.
   * No caller-provided role, user ID, time or MFA claim is considered.
   */
  private async bearer(request:CatalogRequest):Promise<string>{
    if(!request.auth?.userId||!request.auth.sessionId){
      throw new UnauthorizedException('Verified session required');
    }
    if(request.headers?.cookie!==undefined){
      if(process.env.FOLIO_WEB_AUTH_MODE!=='direct-tls-only'){
        throw new UnauthorizedException('Verified web session required');
      }
      return verifiedWebCookieBearer(
        request,(token:string)=>this.store.verify(token),{
          origin:process.env.FOLIO_WEB_AUTH_ORIGIN,
          csrfKeyHex:process.env.FOLIO_WEB_CSRF_KEY_HEX,
        },request.method??'GET',
      );
    }
    if(request.headers?.origin!==undefined||
      request.headers?.['sec-fetch-site']!==undefined){
      throw new UnauthorizedException('Browser bearer transport forbidden');
    }
    const auth=request.headers?.authorization;
    if(typeof auth!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)){
      throw new UnauthorizedException('Verified native session required');
    }
    return auth.slice(7);
  }

  @Get('works')
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Opt-in direct-TLS, same-device MFA/RBAC canonical work metadata search (not public catalog)'})
  @ApiQuery(queryDocs[0]!)
  @ApiQuery(queryDocs[1]!)
  @ApiQuery(queryDocs[2]!)
  @ApiOkResponse({schema:workPageApi})
  async works(@Req() request:CatalogRequest,@Query() raw:Record<string,unknown>){
    const input=this.parameters(raw);
    const bearer=await this.bearer(request);
    return adminCatalogWorkPageSchema.parse(await this.store.works(bearer,input));
  }

  @Get('authors')
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Opt-in direct-TLS, same-device MFA/RBAC canonical author metadata search (no user search)'})
  @ApiQuery(queryDocs[0]!)
  @ApiQuery(queryDocs[1]!)
  @ApiQuery(queryDocs[2]!)
  @ApiOkResponse({schema:authorPageApi})
  async authors(@Req() request:CatalogRequest,@Query() raw:Record<string,unknown>){
    const input=this.parameters(raw);
    const bearer=await this.bearer(request);
    return adminCatalogAuthorPageSchema.parse(await this.store.authors(bearer,input));
  }

  /**
   * Permission is revalidated inside the same repeatable-read transaction as
   * all relationship SELECTs. Unknown UUIDs are distinguishable only after
   * current catalog:read, account, device and MFA checks have passed.
   */
  @Get('works/:workId/rights')
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Verified rights:read MFA/RBAC metadata-only rights claims; not publication'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiQuery({name:'cursor',type:String,format:'uuid',required:false})
  @ApiQuery({name:'limit',type:Number,required:false,minimum:1,maximum:50})
  @ApiOkResponse({schema:rightsLedgerResultApi})
  async rightsLedger(@Req() request:CatalogRequest,
    @Param('workId') rawWorkId:string,
    @Query() query:Record<string,unknown>){
    const workId=adminCatalogIdSchema.safeParse(rawWorkId);
    const parsed=adminCatalogRightsLedgerQuerySchema.safeParse(query);
    if(!workId.success||!parsed.success){
      throw new BadRequestException('Invalid canonical rights ledger parameters');
    }
    const bearer=await this.bearer(request);
    const result=await this.store.rightsLedger(bearer,{
      workId:workId.data,...parsed.data,
    });
    if(!result)throw new NotFoundException('Canonical rights scope not found');
    return adminCatalogRightsLedgerSchema.parse(result);
  }

  @Get('works/:workId/editions/:editionId/revisions')
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Verified same-device MFA/RBAC edition revision UUID list; no source bytes'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiParam({name:'editionId',type:String,format:'uuid'})
  @ApiQuery({name:'cursor',type:String,format:'uuid',required:false})
  @ApiQuery({name:'limit',type:Number,required:false,minimum:1,maximum:50})
  @ApiOkResponse({schema:revisionListResultApi})
  async revisionList(@Req() request:CatalogRequest,
    @Param('workId') rawWorkId:string,
    @Param('editionId') rawEditionId:string,
    @Query() query:Record<string,unknown>){
    const workId=adminCatalogIdSchema.safeParse(rawWorkId);
    const editionId=adminCatalogIdSchema.safeParse(rawEditionId);
    const parsed=adminCatalogRevisionListQuerySchema.safeParse(query);
    if(!workId.success||!editionId.success||!parsed.success){
      throw new BadRequestException('Invalid canonical revision list input');
    }
    const bearer=await this.bearer(request);
    const result=await this.store.revisionList(bearer,{
      workId:workId.data,editionId:editionId.data,...parsed.data,
    });
    if(!result)throw new NotFoundException('Canonical edition not found');
    return adminCatalogRevisionListSchema.parse(result);
  }

  @Get('works/:workId/editions/:editionId/revisions/:toRevisionId/diff')
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Verified MFA/RBAC catalog:read canonical immutable metadata diff; no raw source text'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiParam({name:'editionId',type:String,format:'uuid'})
  @ApiParam({name:'toRevisionId',type:String,format:'uuid'})
  @ApiQuery({name:'fromRevisionId',type:String,format:'uuid',required:true})
  @ApiQuery({name:'cursor',type:String,format:'uuid',required:false})
  @ApiQuery({name:'limit',type:Number,required:false,minimum:1,maximum:100})
  @ApiOkResponse({schema:revisionDiffResultApi})
  async revisionDiff(@Req() request:CatalogRequest,
    @Param('workId') rawWorkId:string,
    @Param('editionId') rawEditionId:string,
    @Param('toRevisionId') rawToRevisionId:string,
    @Query() query:Record<string,unknown>){
    const workId=adminCatalogIdSchema.safeParse(rawWorkId);
    const editionId=adminCatalogIdSchema.safeParse(rawEditionId);
    const toRevisionId=adminCatalogIdSchema.safeParse(rawToRevisionId);
    const parsed=adminCatalogRevisionDiffQuerySchema.safeParse(query);
    if(!workId.success||!editionId.success||!toRevisionId.success||
      !parsed.success){
      throw new BadRequestException('Invalid canonical revision diff input');
    }
    const bearer=await this.bearer(request);
    const result=await this.store.revisionDiff(bearer,{
      workId:workId.data,editionId:editionId.data,
      toRevisionId:toRevisionId.data,fromRevisionId:parsed.data.fromRevisionId,
      limit:parsed.data.limit,
      ...(parsed.data.cursor?{cursor:parsed.data.cursor}:{}),
    });
    if(!result)throw new NotFoundException('Canonical revision pair not found');
    return adminCatalogRevisionDiffSchema.parse(result);
  }

  @Get('works/:workId')
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA-verified canonical work relational metadata from a single PostgreSQL repeatable-read snapshot (admin only)'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiOkResponse({schema:workDetailApi})
  async workDetail(@Req() request:CatalogRequest,
    @Query() query:Record<string,unknown>,@Param('workId') rawId:string){
    this.rejectWriteQuery(query);
    const parsed=adminCatalogIdSchema.safeParse(rawId);
    if(!parsed.success)throw new BadRequestException('Invalid canonical work ID');
    const token=await this.bearer(request);
    const details=await this.store.workDetail(token,parsed.data);
    if(!details)throw new NotFoundException('Canonical work not found');
    return adminCatalogWorkDetailSchema.parse(details);
  }

  @Get('authors/:authorId')
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA-verified canonical author/alias/source identifiers from one PostgreSQL repeatable-read snapshot (admin only)'})
  @ApiParam({name:'authorId',type:String,format:'uuid'})
  @ApiOkResponse({schema:authorDetailApi})
  async authorDetail(@Req() request:CatalogRequest,
    @Query() query:Record<string,unknown>,@Param('authorId') rawId:string){
    this.rejectWriteQuery(query);
    const parsed=adminCatalogIdSchema.safeParse(rawId);
    if(!parsed.success)throw new BadRequestException('Invalid canonical author ID');
    const token=await this.bearer(request);
    const details=await this.store.authorDetail(token,parsed.data);
    if(!details)throw new NotFoundException('Canonical author not found');
    return adminCatalogAuthorDetailSchema.parse(details);
  }

  private rejectWriteQuery(query:Record<string,unknown>):void{
    if(Object.keys(query).length)throw new BadRequestException('Unexpected query parameters');
  }
  private trace(request:CatalogRequest):string{
    if(!request.requestId){
      throw new ServiceUnavailableException('Server request tracing unavailable');
    }
    return request.requestId;
  }

  @Patch('authors/:authorId')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA-verified catalog:edit; optimistic-lock canonical author name/aliases/source IDs and audited before/after'})
  @ApiParam({name:'authorId',type:String,format:'uuid'})
  @ApiBody({schema:authorMetadataPatchApi})
  @ApiOkResponse({schema:updatedAuthorApi})
  async patchAuthor(@Req() request:CatalogRequest,
    @Query() query:Record<string,unknown>,
    @Param('authorId') rawId:string,@Body() raw:unknown){
    this.rejectWriteQuery(query);
    const id=adminCatalogIdSchema.safeParse(rawId);
    const input=canonicalAuthorMetadataPatchSchema.safeParse(raw);
    if(!id.success||!input.success){
      throw new BadRequestException('Invalid canonical author metadata edit');
    }
    const token=await this.bearer(request);
    const edited=await this.store.patchAuthor(token,id.data,input.data,this.trace(request));
    if(!edited)throw new NotFoundException('Canonical author not found');
    return canonicalAuthorMetadataUpdatedSchema.parse(edited);
  }

  @Patch('works/:workId')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA-verified catalog:edit; optimistic-lock DRAFT original title/year with original-title synchronization and audit'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiBody({schema:workMetadataPatchApi})
  @ApiOkResponse({schema:updatedWorkApi})
  async patchWork(@Req() request:CatalogRequest,
    @Query() query:Record<string,unknown>,
    @Param('workId') rawId:string,@Body() raw:unknown){
    this.rejectWriteQuery(query);
    const id=adminCatalogIdSchema.safeParse(rawId);
    const input=canonicalWorkMetadataPatchSchema.safeParse(raw);
    if(!id.success||!input.success){
      throw new BadRequestException('Invalid canonical work metadata edit');
    }
    const token=await this.bearer(request);
    const edited=await this.store.patchWork(token,id.data,input.data,this.trace(request));
    if(!edited)throw new NotFoundException('Canonical work not found');
    return canonicalWorkMetadataUpdatedSchema.parse(edited);
  }

  @Post('works/:workId/editions')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA/RBAC catalog:edit; append DRAFT edition, ISBN and contributors with work revision and trusted audit'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiBody({schema:appendEditionBodyApi})
  @ApiCreatedResponse({schema:appendEditionResultApi})
  async appendEdition(@Req() request:CatalogRequest,
    @Query() query:Record<string,unknown>,
    @Param('workId') rawId:string,@Body() raw:unknown){
    this.rejectWriteQuery(query);
    const id=adminCatalogIdSchema.safeParse(rawId);
    const parsed=adminCatalogEditionAppendSchema.safeParse(raw);
    if(!id.success||!parsed.success){
      throw new BadRequestException('Invalid canonical edition input');
    }
    const token=await this.bearer(request);
    const created=await this.store.appendEdition(token,id.data,parsed.data,this.trace(request));
    if(!created)throw new NotFoundException('Canonical work not found');
    return adminCatalogEditionAppendedSchema.parse(created);
  }

  @Patch('works/:workId/editions/:editionId')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA/RBAC catalog:edit; versioned DRAFT edition metadata revision with trusted audit; rights/content immutable'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiParam({name:'editionId',type:String,format:'uuid'})
  @ApiBody({schema:patchEditionBodyApi})
  @ApiOkResponse({schema:appendEditionResultApi})
  async patchEdition(@Req() request:CatalogRequest,
    @Query() query:Record<string,unknown>,
    @Param('workId') rawWorkId:string,@Param('editionId') rawEditionId:string,
    @Body() raw:unknown){
    this.rejectWriteQuery(query);
    const workId=adminCatalogIdSchema.safeParse(rawWorkId);
    const editionId=adminCatalogIdSchema.safeParse(rawEditionId);
    const parsed=adminCatalogEditionMetadataPatchSchema.safeParse(raw);
    if(!workId.success||!editionId.success||!parsed.success){
      throw new BadRequestException('Invalid canonical edition metadata edit');
    }
    const token=await this.bearer(request);
    const updated=await this.store.patchEdition(
      token,workId.data,editionId.data,parsed.data,this.trace(request));
    if(!updated)throw new NotFoundException('Canonical draft edition not found');
    return adminCatalogEditionMetadataUpdatedSchema.parse(updated);
  }

  @Post('works/:workId/titles')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA/RBAC catalog:edit; append alternate/translated TITLE metadata only, not text or rights'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiBody({schema:appendTitleBodyApi})
  @ApiCreatedResponse({schema:appendTitleResultApi})
  async appendTitle(@Req() request:CatalogRequest,
    @Query() query:Record<string,unknown>,
    @Param('workId') rawId:string,@Body() raw:unknown){
    this.rejectWriteQuery(query);
    const id=adminCatalogIdSchema.safeParse(rawId);
    const parsed=adminCatalogTitleAppendSchema.safeParse(raw);
    if(!id.success||!parsed.success){
      throw new BadRequestException('Invalid canonical alternate title input');
    }
    const token=await this.bearer(request);
    const created=await this.store.appendTitle(token,id.data,parsed.data,this.trace(request));
    if(!created)throw new NotFoundException('Canonical work not found');
    return adminCatalogTitleAppendedSchema.parse(created);
  }

  @Post('works/:workId/authors')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA/RBAC catalog:edit; append a verified canonical coauthor/link with work revision and audit'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiBody({schema:appendAuthorBodyApi})
  @ApiCreatedResponse({schema:appendAuthorResultApi})
  async appendAuthor(@Req() request:CatalogRequest,
    @Query() query:Record<string,unknown>,
    @Param('workId') rawId:string,@Body() raw:unknown){
    this.rejectWriteQuery(query);
    const id=adminCatalogIdSchema.safeParse(rawId);
    const parsed=adminCatalogWorkAuthorAppendSchema.safeParse(raw);
    if(!id.success||!parsed.success){
      throw new BadRequestException('Invalid canonical author relation');
    }
    const token=await this.bearer(request);
    const created=await this.store.appendAuthor(token,id.data,parsed.data,this.trace(request));
    if(!created)throw new NotFoundException('Canonical work not found');
    return adminCatalogWorkAuthorAppendedSchema.parse(created);
  }

  @Delete('works/:workId/titles/:titleId')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA/RBAC catalog:edit; unlink DRAFT alternate/translation title only; ORIGINAL forbidden; audited'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiParam({name:'titleId',type:String,format:'uuid'})
  @ApiBody({schema:removeRelationBodyApi})
  @ApiOkResponse({schema:appendTitleResultApi})
  async removeTitle(@Req() request:CatalogRequest,
    @Query() query:Record<string,unknown>,
    @Param('workId') rawWorkId:string,@Param('titleId') rawTitleId:string,
    @Body() raw:unknown){
    this.rejectWriteQuery(query);
    const workId=adminCatalogIdSchema.safeParse(rawWorkId);
    const titleId=adminCatalogIdSchema.safeParse(rawTitleId);
    const parsed=adminCatalogRelationRemoveSchema.safeParse(raw);
    if(!workId.success||!titleId.success||!parsed.success){
      throw new BadRequestException('Invalid draft title relation removal');
    }
    const token=await this.bearer(request);
    const removed=await this.store.removeTitle(
      token,workId.data,titleId.data,parsed.data,this.trace(request));
    if(!removed)throw new NotFoundException('Draft title relation not found');
    return adminCatalogTitleAppendedSchema.parse(removed);
  }

  @Delete('works/:workId/authors/:authorId')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA/RBAC catalog:edit; unlink DRAFT work-author relation, retaining one true author; audited'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiParam({name:'authorId',type:String,format:'uuid'})
  @ApiBody({schema:removeRelationBodyApi})
  @ApiOkResponse({schema:appendAuthorResultApi})
  async removeAuthor(@Req() request:CatalogRequest,
    @Query() query:Record<string,unknown>,
    @Param('workId') rawWorkId:string,@Param('authorId') rawAuthorId:string,
    @Body() raw:unknown){
    this.rejectWriteQuery(query);
    const workId=adminCatalogIdSchema.safeParse(rawWorkId);
    const authorId=adminCatalogIdSchema.safeParse(rawAuthorId);
    const parsed=adminCatalogRelationRemoveSchema.safeParse(raw);
    if(!workId.success||!authorId.success||!parsed.success){
      throw new BadRequestException('Invalid draft author relation removal');
    }
    const token=await this.bearer(request);
    const removed=await this.store.removeAuthor(
      token,workId.data,authorId.data,parsed.data,this.trace(request));
    if(!removed)throw new NotFoundException('Draft work-author relation not found');
    return adminCatalogWorkAuthorAppendedSchema.parse(removed);
  }

  @Patch('works/:workId/titles/:titleId')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA/RBAC catalog:edit; versioned OPTIONAL title metadata update, original forbidden, audited'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiParam({name:'titleId',type:String,format:'uuid'})
  @ApiBody({schema:patchOptionalTitleBodyApi})
  @ApiOkResponse({schema:appendTitleResultApi})
  async patchTitle(@Req() request:CatalogRequest,
    @Query() query:Record<string,unknown>,
    @Param('workId') rawWorkId:string,@Param('titleId') rawTitleId:string,
    @Body() raw:unknown){
    this.rejectWriteQuery(query);
    const workId=adminCatalogIdSchema.safeParse(rawWorkId),
      titleId=adminCatalogIdSchema.safeParse(rawTitleId),
      input=adminCatalogTitleMetadataPatchSchema.safeParse(raw);
    if(!workId.success||!titleId.success||!input.success){
      throw new BadRequestException('Invalid optional title metadata patch');
    }
    const token=await this.bearer(request);
    const result=await this.store.patchTitle(
      token,workId.data,titleId.data,input.data,this.trace(request));
    if(!result)throw new NotFoundException('Optional title not found');
    return adminCatalogTitleAppendedSchema.parse(result);
  }

  @Patch('works/:workId/authors/:authorId')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA/RBAC catalog:edit; reorder/change DRAFT author role, last true author protected'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiParam({name:'authorId',type:String,format:'uuid'})
  @ApiBody({schema:patchWorkAuthorBodyApi})
  @ApiOkResponse({schema:appendAuthorResultApi})
  async patchAuthorLink(@Req() request:CatalogRequest,
    @Query() query:Record<string,unknown>,
    @Param('workId') rawWorkId:string,@Param('authorId') rawAuthorId:string,
    @Body() raw:unknown){
    this.rejectWriteQuery(query);
    const workId=adminCatalogIdSchema.safeParse(rawWorkId),
      authorId=adminCatalogIdSchema.safeParse(rawAuthorId),
      input=adminCatalogWorkAuthorMetadataPatchSchema.safeParse(raw);
    if(!workId.success||!authorId.success||!input.success){
      throw new BadRequestException('Invalid author relation patch');
    }
    const token=await this.bearer(request);
    const result=await this.store.patchAuthorLink(
      token,workId.data,authorId.data,input.data,this.trace(request));
    if(!result)throw new NotFoundException('Author relation not found');
    return adminCatalogWorkAuthorAppendedSchema.parse(result);
  }

  @Delete('works/:workId/editions/:editionId')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA/RBAC catalog:edit; remove EMPTY DRAFT edition only, never revisions or rights, audited'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiParam({name:'editionId',type:String,format:'uuid'})
  @ApiBody({schema:removeRelationBodyApi})
  @ApiOkResponse({schema:removeEmptyEditionResultApi})
  async removeEmptyEdition(@Req() request:CatalogRequest,
    @Query() query:Record<string,unknown>,
    @Param('workId') rawWorkId:string,@Param('editionId') rawEditionId:string,
    @Body() raw:unknown){
    this.rejectWriteQuery(query);
    const workId=adminCatalogIdSchema.safeParse(rawWorkId),
      editionId=adminCatalogIdSchema.safeParse(rawEditionId),
      input=adminCatalogRelationRemoveSchema.safeParse(raw);
    if(!workId.success||!editionId.success||!input.success){
      throw new BadRequestException('Invalid empty draft edition removal');
    }
    const token=await this.bearer(request);
    const result=await this.store.removeEmptyEdition(
      token,workId.data,editionId.data,input.data,this.trace(request));
    if(!result)throw new NotFoundException('Draft edition not found');
    return adminCatalogEditionRemovedSchema.parse(result);
  }

  @Get('works/:workId/match-reviews')
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Verified MFA catalog:read; paginated work identity review evidence only, no private text'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiQuery({name:'cursor',required:false,type:String,format:'uuid'})
  @ApiOkResponse({schema:matchReviewPageApi})
  async listMatchReviews(@Req() request:CatalogRequest,
    @Param('workId') rawWorkId:string,@Query() raw:Record<string,unknown>){
    const workId=adminCatalogIdSchema.safeParse(rawWorkId);
    const query=adminWorkMatchQuerySchema.safeParse(raw);
    if(!workId.success||!query.success){
      throw new BadRequestException('Invalid match review page parameters');
    }
    const token=await this.bearer(request);
    const page=await this.store.listMatchReviews(token,workId.data,query.data);
    if(!page)throw new NotFoundException('Canonical review work not found');
    return adminWorkMatchPageSchema.parse(page);
  }

  @Post('works/:workId/match-reviews')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA catalog:edit; propose an audited DRAFT-work identity comparison; NO automatic merge'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiBody({schema:matchReviewProposeApi})
  @ApiCreatedResponse({schema:matchReviewResultApi})
  async proposeMatchReview(@Req() request:CatalogRequest,
    @Param('workId') rawWorkId:string,@Query() rawQuery:Record<string,unknown>,
    @Body() raw:unknown){
    this.rejectWriteQuery(rawQuery);
    const workId=adminCatalogIdSchema.safeParse(rawWorkId),
      input=adminWorkMatchProposeSchema.safeParse(raw);
    if(!workId.success||!input.success||workId.data===input.data?.candidateWorkId){
      throw new BadRequestException('Invalid canonical match candidate');
    }
    const token=await this.bearer(request);
    const result=await this.store.proposeMatchReview(
      token,workId.data,input.data,this.trace(request));
    if(!result)throw new NotFoundException('Canonical work candidate not found');
    return adminWorkMatchResultSchema.parse(result);
  }

  @Patch('works/:workId/match-reviews/:reviewId')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Different MFA-verified catalog editor records distinct/deferred evidence ONLY; no merge/publish/import bypass'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiParam({name:'reviewId',type:String,format:'uuid'})
  @ApiBody({schema:matchReviewDecisionApi})
  @ApiOkResponse({schema:matchReviewResultApi})
  async decideMatchReview(@Req() request:CatalogRequest,
    @Param('workId') rawWorkId:string,@Param('reviewId') rawReviewId:string,
    @Query() rawQuery:Record<string,unknown>,@Body() raw:unknown){
    this.rejectWriteQuery(rawQuery);
    const workId=adminCatalogIdSchema.safeParse(rawWorkId),
      reviewId=adminCatalogIdSchema.safeParse(rawReviewId),
      input=adminWorkMatchDecisionSchema.safeParse(raw);
    if(!workId.success||!reviewId.success||!input.success){
      throw new BadRequestException('Invalid independent match review decision');
    }
    const token=await this.bearer(request);
    const result=await this.store.decideMatchReview(
      token,workId.data,reviewId.data,input.data,this.trace(request));
    if(!result)throw new NotFoundException('Canonical match review not found');
    return adminWorkMatchResultSchema.parse(result);
  }

  @Get('works/:workId/import-reviews')
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA catalog:read; unverified incoming package candidate claims; bounded metadata only'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiQuery({name:'cursor',required:false,type:String,format:'uuid'})
  @ApiOkResponse({schema:importCandidatePageApi})
  async listImportCandidateReviews(@Req() request:CatalogRequest,
    @Param('workId') rawId:string,@Query() raw:Record<string,unknown>){
    const workId=adminCatalogIdSchema.safeParse(rawId),
      query=adminWorkMatchQuerySchema.safeParse(raw);
    if(!workId.success||!query.success){
      throw new BadRequestException('Invalid incoming review page');
    }
    const token=await this.bearer(request);
    const data=await this.store.listImportCandidateReviews(token,workId.data,query.data);
    if(!data)throw new NotFoundException('Catalog candidate work not found');
    return adminImportCandidatePageSchema.parse(data);
  }

  @Post('works/:workId/import-reviews')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'MFA catalog:edit; unverified package identity CLAIM only; never apply/merge/publish'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiBody({schema:importCandidateProposeApi})
  @ApiCreatedResponse({schema:importCandidateResultApi})
  async proposeImportCandidateReview(@Req() request:CatalogRequest,
    @Param('workId') rawId:string,@Query() query:Record<string,unknown>,@Body() raw:unknown){
    this.rejectWriteQuery(query);
    const workId=adminCatalogIdSchema.safeParse(rawId),
      input=adminImportCandidateProposeSchema.safeParse(raw);
    if(!workId.success||!input.success||workId.data===input.data?.incomingWorkId){
      throw new BadRequestException('Invalid incoming package work claim');
    }
    const token=await this.bearer(request);
    const result=await this.store.proposeImportCandidateReview(
      token,workId.data,input.data,this.trace(request));
    if(!result)throw new NotFoundException('Catalog candidate not found');
    return adminImportCandidateResultSchema.parse(result);
  }

  @Patch('works/:workId/import-reviews/:reviewId')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Different MFA editor records distinct/deferred incoming claim only; no import approval'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiParam({name:'reviewId',type:String,format:'uuid'})
  @ApiBody({schema:matchReviewDecisionApi})
  @ApiOkResponse({schema:importCandidateResultApi})
  async decideImportCandidateReview(@Req() request:CatalogRequest,
    @Param('workId') rawId:string,@Param('reviewId') rawReviewId:string,
    @Query() query:Record<string,unknown>,@Body() raw:unknown){
    this.rejectWriteQuery(query);
    const workId=adminCatalogIdSchema.safeParse(rawId),
      reviewId=adminCatalogIdSchema.safeParse(rawReviewId),
      input=adminWorkMatchDecisionSchema.safeParse(raw);
    if(!workId.success||!reviewId.success||!input.success){
      throw new BadRequestException('Invalid incoming review decision');
    }
    const token=await this.bearer(request);
    const result=await this.store.decideImportCandidateReview(
      token,workId.data,reviewId.data,input.data,this.trace(request));
    if(!result)throw new NotFoundException('Incoming review not found');
    return adminImportCandidateResultSchema.parse(result);
  }

  @Post('authors')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Explicitly opted-in TLS + verified catalog:edit MFA; create an audited unpublished canonical author'})
  @ApiBody({schema:authorInputApi})
  @ApiCreatedResponse({schema:authorCreatedApi})
  async createAuthor(@Req() request:CatalogRequest,
    @Query() query:Record<string,unknown>,@Body() raw:unknown){
    this.rejectWriteQuery(query);
    const body=authorCreateSchema.safeParse(raw);
    if(!body.success)throw new BadRequestException('Invalid canonical author input');
    const trace=this.trace(request);
    const token=await this.bearer(request);
    const created=await this.store.createAuthor(token,body.data,trace);
    return adminCatalogAuthorCreatedSchema.parse({id:created.id});
  }

  @Post('works')
  @UseGuards(AdminCatalogWriteGuard)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Explicitly opted-in TLS + verified catalog:edit MFA; create audited DRAFT work with authors and editions'})
  @ApiBody({schema:workInputApi})
  @ApiCreatedResponse({schema:workCreatedApi})
  async createWork(@Req() request:CatalogRequest,
    @Query() query:Record<string,unknown>,@Body() raw:unknown){
    this.rejectWriteQuery(query);
    const body=workCreateSchema.safeParse(raw);
    if(!body.success)throw new BadRequestException('Invalid canonical work input');
    const trace=this.trace(request);
    const token=await this.bearer(request);
    const created=await this.store.createWork(token,body.data,trace);
    return adminCatalogWorkCreatedSchema.parse({
      id:created.id,publicationStatus:created.publicationStatus,
    });
  }
}

@Module({
  controllers:[AdminCatalogController],
  providers:[
    AdminCatalogOptInGuard,AdminCatalogWriteGuard,AdminCatalogDb,VerifiedSelfSessionGuard,
    {provide:VERIFIED_SESSION_LOOKUP,
      useFactory:(store:AdminCatalogDb):BearerSessionLookup=>
        (bearer:string)=>store.verify(bearer),
      inject:[AdminCatalogDb],
    },
  ],
})
export class AdminCatalogModule {}
