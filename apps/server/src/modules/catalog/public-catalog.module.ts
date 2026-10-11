import {
  BadRequestException,Controller,Get,Header,Inject,Injectable,Module,
  NotFoundException,OnModuleDestroy,Param,Query,Req,ServiceUnavailableException,
} from '@nestjs/common';
import {ApiOkResponse,ApiOperation,ApiParam,ApiQuery,ApiTags} from '@nestjs/swagger';
import {createFolioDb,getPublishedBookDetail,getPublishedReaderText,searchPublishedCatalog} from '@folio/db';
import {publishedBookDetailSchema,publishedReaderTextSchema,publishedCatalogSearchQuerySchema,publishedCatalogSearchPageSchema} from '@folio/contracts';
import type {PublishedBookDetail,PublishedReaderText,PublishedCatalogSearchPage} from '@folio/contracts';

@Injectable()
class PublishedCatalogDb implements OnModuleDestroy {
  private readonly connection=process.env.DATABASE_URL?createFolioDb(process.env.DATABASE_URL):null;
  async detail(workId:string,territory:string):Promise<PublishedBookDetail|null>{
    if(!this.connection)throw new ServiceUnavailableException('Catalog database unavailable');
    try{return await getPublishedBookDetail(this.connection.db,workId,territory);}
    catch{throw new ServiceUnavailableException('Catalog database unavailable');}
  }
  async search(query:unknown,territory:string):Promise<PublishedCatalogSearchPage>{
    if(!this.connection)throw new ServiceUnavailableException('Catalog database unavailable');
    try{return await searchPublishedCatalog(this.connection.db,query,territory);}
    catch{throw new ServiceUnavailableException('Catalog database unavailable');}
  }
  async reader(revisionId:string,territory:string):Promise<PublishedReaderText|null>{
    if(!this.connection)throw new ServiceUnavailableException('Catalog database unavailable');
    try{return await getPublishedReaderText(this.connection.db,revisionId,territory);}
    catch{throw new ServiceUnavailableException('Reader database unavailable');}
  }
  async onModuleDestroy(){await this.connection?.pool.end();}
}

/** Public route returns metadata only; no anonymous source-body or private-user path. */
@ApiTags('public-catalog')
@Controller('v1/catalog')
export class PublishedCatalogController {
  constructor(@Inject(PublishedCatalogDb) private readonly catalog:PublishedCatalogDb){}
  @Get('works/:workId')
  @Header('Cache-Control','no-store')
  @ApiOperation({summary:'Published catalog book metadata in the trusted server territory'})
  @ApiParam({name:'workId',type:'string',format:'uuid'})
  @ApiOkResponse({schema:{
    type:'object',additionalProperties:false,required:['id','title','originalLanguage','authors','editions'],
    properties:{
      id:{type:'string',format:'uuid'},title:{type:'string'},
      originalLanguage:{type:'string',enum:['tr','en']},
      authors:{type:'array',items:{type:'object',additionalProperties:false,
        required:['id','name'],properties:{id:{type:'string',format:'uuid'},name:{type:'string'}}}},
      editions:{type:'array',items:{type:'object',additionalProperties:false,
        required:['id','language','label','revisionId','audioAvailable'],properties:{
          id:{type:'string',format:'uuid'},language:{type:'string',enum:['tr','en']},
          label:{type:'string'},revisionId:{type:'string',format:'uuid'},
          audioAvailable:{type:'boolean'},
        }}},
    },
  }})
  async detail(
    @Param('workId') rawId:string,@Query() rawQuery:Record<string,unknown>,
    @Req() request:{socket?:{encrypted?:boolean}},
  ):Promise<PublishedBookDetail>{
    // Never trust x-forwarded-country / Accept-Language / query as a legal territory.
    if(request.socket?.encrypted!==true)throw new ServiceUnavailableException('Secure catalog required');
    const territory=process.env.FOLIO_PUBLIC_CATALOG_TERRITORY;
    if(!territory||!/^[A-Z]{2}$/.test(territory)){
      throw new NotFoundException('Public catalog is not enabled');
    }
    if(!publishedBookDetailSchema.shape.id.safeParse(rawId).success||
      !rawQuery||Object.keys(rawQuery).length>0){
      throw new BadRequestException('Invalid book link');
    }
    const detail=await this.catalog.detail(rawId,territory);
    if(!detail)throw new NotFoundException('Published book not found');
    return publishedBookDetailSchema.parse(detail);
  }

  @Get('search')
  @Header('Cache-Control','no-store')
  @ApiOperation({summary:'Search published books by title or author only, in server-approved territory'})
  @ApiQuery({name:'q',type:String,required:true})
  @ApiQuery({name:'limit',type:Number,required:false,minimum:1,maximum:20})
  @ApiOkResponse({schema:{type:'object',required:['items'],additionalProperties:false,
    properties:{items:{type:'array',maxItems:20,items:{
      type:'object',additionalProperties:false,
      required:['id','title','authors','editionId','revisionId','audioAvailable'],
      properties:{
        id:{type:'string',format:'uuid'},title:{type:'string'},
        authors:{type:'array',items:{type:'string'}},
        editionId:{type:'string',format:'uuid'},
        revisionId:{type:'string',format:'uuid'},
        audioAvailable:{type:'boolean'},
      },
    }}},
  }})
  async search(@Query() rawQuery:Record<string,unknown>,
    @Req() request:{socket?:{encrypted?:boolean}}):Promise<PublishedCatalogSearchPage>{
    if(request.socket?.encrypted!==true)throw new ServiceUnavailableException('Secure catalog required');
    const territory=process.env.FOLIO_PUBLIC_CATALOG_TERRITORY;
    if(!territory||!/^[A-Z]{2}$/.test(territory)){
      throw new NotFoundException('Public catalog is not enabled');
    }
    const query=publishedCatalogSearchQuerySchema.safeParse(rawQuery);
    if(!query.success)throw new BadRequestException('Invalid book search');
    const result=await this.catalog.search(query.data,territory);
    return publishedCatalogSearchPageSchema.parse(result);
  }

  @Get('reader/:revisionId')
  @Header('Cache-Control','no-store')
  @ApiOperation({summary:'Rights-checked published chapter text, never draft/source storage'})
  @ApiParam({name:'revisionId',type:'string',format:'uuid'})
  @ApiOkResponse({schema:{
    type:'object',additionalProperties:false,
    required:['workId','revisionId','title','language','chapters'],
    properties:{
      workId:{type:'string',format:'uuid'},revisionId:{type:'string',format:'uuid'},
      title:{type:'string'},language:{type:'string',enum:['tr','en']},
      chapters:{type:'array',items:{
        type:'object',additionalProperties:false,required:['id','heading','blocks'],
        properties:{
          id:{type:'string',format:'uuid'},heading:{type:'string'},
          blocks:{type:'array',items:{
            type:'object',additionalProperties:false,required:['id','kind','text'],
            properties:{
              id:{type:'string',format:'uuid'},kind:{type:'string'},text:{type:'string'},
            },
          }},
        },
      }},
    },
  }})
  async reader(@Param('revisionId') rawId:string,@Query() rawQuery:Record<string,unknown>,
    @Req() request:{socket?:{encrypted?:boolean}}):Promise<PublishedReaderText>{
    if(request.socket?.encrypted!==true)throw new ServiceUnavailableException('Secure reader required');
    const territory=process.env.FOLIO_PUBLIC_CATALOG_TERRITORY;
    if(!territory||!/^[A-Z]{2}$/.test(territory)){
      throw new NotFoundException('Public reader is not enabled');
    }
    if(!publishedReaderTextSchema.shape.revisionId.safeParse(rawId).success||
      Object.keys(rawQuery??{}).length){
      throw new BadRequestException('Invalid reader link');
    }
    const result=await this.catalog.reader(rawId,territory);
    if(!result)throw new NotFoundException('Published reader text not found');
    return publishedReaderTextSchema.parse(result);
  }
}

@Module({controllers:[PublishedCatalogController],providers:[PublishedCatalogDb]})
export class PublishedCatalogModule {}
