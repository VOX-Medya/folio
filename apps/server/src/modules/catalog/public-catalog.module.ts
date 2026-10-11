import {
  BadRequestException,Controller,Get,Header,Inject,Injectable,Module,
  NotFoundException,OnModuleDestroy,Param,Query,Req,ServiceUnavailableException,
} from '@nestjs/common';
import {ApiOkResponse,ApiOperation,ApiParam,ApiTags} from '@nestjs/swagger';
import {createFolioDb,getPublishedBookDetail} from '@folio/db';
import {publishedBookDetailSchema} from '@folio/contracts';
import type {PublishedBookDetail} from '@folio/contracts';

@Injectable()
class PublishedCatalogDb implements OnModuleDestroy {
  private readonly connection=process.env.DATABASE_URL?createFolioDb(process.env.DATABASE_URL):null;
  async detail(workId:string,territory:string):Promise<PublishedBookDetail|null>{
    if(!this.connection)throw new ServiceUnavailableException('Catalog database unavailable');
    try{return await getPublishedBookDetail(this.connection.db,workId,territory);}
    catch{throw new ServiceUnavailableException('Catalog database unavailable');}
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
}

@Module({controllers:[PublishedCatalogController],providers:[PublishedCatalogDb]})
export class PublishedCatalogModule {}
