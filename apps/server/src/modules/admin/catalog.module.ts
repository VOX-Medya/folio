import {
  BadRequestException,Body,CanActivate,ConflictException,Controller,
  ExecutionContext,ForbiddenException,Get,Header,Inject,Injectable,Module,
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
  searchVerifiedAdminAuthors,searchVerifiedAdminWorks,
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
  adminCatalogTitleAppendedSchema,adminCatalogWorkAuthorAppendedSchema,
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
      if(error instanceof Error&&[
        'Canonical metadata version conflict',
        'Published canonical work is immutable via draft editor',
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
  appendTitle(bearer:string,id:string,input:unknown,requestId:string){
    return this.authorized(()=>
      appendVerifiedAdminWorkTitle(this.db(),bearer,id,input,requestId));
  }
  appendAuthor(bearer:string,id:string,input:unknown,requestId:string){
    return this.authorized(()=>
      appendVerifiedAdminWorkAuthor(this.db(),bearer,id,input,requestId));
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
