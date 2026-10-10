import {
  BadRequestException, Controller, Get, Header, Inject, Injectable, Module,
  OnModuleDestroy, Query, ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createFolioDb } from '@folio/db';
import {capabilityPageSchema, cursorQuerySchema, healthResponseSchema, readinessResponseSchema, paginateCapabilities} from '@folio/contracts';
import type {Capability, CapabilityPage, HealthResponse, ReadinessResponse} from '@folio/contracts';

@ApiTags('system')
@Controller('v1')
export class HealthController {
  @Get('health')
  @Header('Cache-Control','no-store')
  @ApiOperation({ summary: 'Process liveness probe (not DB readiness)' })
  health(): HealthResponse { return healthResponseSchema.parse({ status: 'ok' }); }
}

class CapabilityDto {
  @ApiProperty({ type: String, example: 'reader' }) id!: string;
  @ApiProperty({ type: Boolean, example: false }) available!: boolean;
  @ApiProperty({ type: String, example: 'Not implemented in this lab build' }) note!: string;
}
class CapabilityPageDto {
  @ApiProperty({ type: () => CapabilityDto, isArray: true }) items!: CapabilityDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}
const capabilities: readonly Capability[] = [
  {id: 'catalog', available: false, note: 'Catalog API is not deployed yet'},
  {id: 'normal-reader', available: false, note: 'Reading engine is not deployed yet'},
  {id: 'rsvp', available: false, note: 'RSVP engine is not deployed yet'},
  {id: 'audiobook', available: false, note: 'Only ready audio assets will be supported'},
  {id: 'invites', available: false, note: 'Friends require approved invitations'},
];

@ApiTags('system')
@Controller('v1/system')
export class CapabilitiesController {
  @Get('capabilities')
  @Header('Cache-Control','no-store')
  @ApiOperation({ summary: 'Truthful V1 feature availability (never implies mock APIs are active)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 50 })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiOkResponse({ type: CapabilityPageDto })
  list(@Query() rawQuery: Record<string, unknown>): CapabilityPage {
    const query = cursorQuerySchema.safeParse(rawQuery);
    if (!query.success) throw new BadRequestException('Invalid pagination parameters');
    try {
      return capabilityPageSchema.parse(paginateCapabilities(capabilities, query.data));
    } catch {
      throw new BadRequestException('Invalid pagination cursor');
    }
  }
}

@Injectable()
export class DbReadinessService implements OnModuleDestroy {
  private connection = process.env.DATABASE_URL ? createFolioDb(process.env.DATABASE_URL) : undefined;
  async readiness(): Promise<ReadinessResponse> {
    if (!this.connection) throw new ServiceUnavailableException('Database not configured');
    try { await this.connection.pool.query('SELECT 1'); }
    catch { throw new ServiceUnavailableException('Database not ready'); }
    return readinessResponseSchema.parse({status: 'ready'});
  }
  async onModuleDestroy(): Promise<void> { await this.connection?.pool.end(); }
}

@ApiTags('system')
@Controller('v1')
export class ReadinessController {
  constructor(@Inject(DbReadinessService) private readonly db: DbReadinessService) {}
  @Get('ready')
  @Header('Cache-Control','no-store')
  @ApiOperation({ summary: 'Database readiness (503 when unavailable)' })
  @ApiOkResponse({schema: {type: 'object', required: ['status'], properties: {status: {type: 'string', enum: ['ready']}}}})
  async ready(): Promise<ReadinessResponse> { return this.db.readiness(); }
}


@Module({controllers: [HealthController, CapabilitiesController, ReadinessController], providers: [DbReadinessService]})
export class SystemModule {}
