import {
  BadRequestException,CanActivate,Controller,ForbiddenException,ExecutionContext,
  Get,Header,Inject,Injectable,Module,NotFoundException,OnModuleDestroy,
  Query,Req,ServiceUnavailableException,UnauthorizedException,UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,ApiOkResponse,ApiOperation,ApiQuery,ApiSecurity,ApiTags,
} from '@nestjs/swagger';
import {
  authenticateUserSession,createFolioDb,searchVerifiedAdminAuthors,
  searchVerifiedAdminWorks,
} from '@folio/db';
import {
  adminCatalogAuthorPageSchema,adminCatalogSearchQuerySchema,
  adminCatalogWorkPageSchema,
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
      throw new ServiceUnavailableException('Administrator catalog search unavailable');
    }
  }
  works(bearer:string,input:unknown){
    return this.authorized(()=>searchVerifiedAdminWorks(this.db(),bearer,input));
  }
  authors(bearer:string,input:unknown){
    return this.authorized(()=>searchVerifiedAdminAuthors(this.db(),bearer,input));
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
}

@Module({
  controllers:[AdminCatalogController],
  providers:[
    AdminCatalogOptInGuard,AdminCatalogDb,VerifiedSelfSessionGuard,
    {provide:VERIFIED_SESSION_LOOKUP,
      useFactory:(store:AdminCatalogDb):BearerSessionLookup=>
        (bearer:string)=>store.verify(bearer),
      inject:[AdminCatalogDb],
    },
  ],
})
export class AdminCatalogModule {}
