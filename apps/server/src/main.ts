import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  ArgumentsHost, BadRequestException, CanActivate, Catch, Controller, ExceptionFilter, ExecutionContext,
  ForbiddenException, Get, HttpException, HttpStatus, Injectable, MiddlewareConsumer, Module,
  NestModule, NestMiddleware, Query, UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiQuery, ApiTags, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  capabilityPageSchema, cursorQuerySchema, healthResponseSchema,
  paginateCapabilities,
} from '@folio/contracts';
import type { Capability, CapabilityPage, HealthResponse } from '@folio/contracts';

interface FolioRequest {
  requestId?: string;
  auth?: { userId: string };
  params?: { userId?: string };
}
interface FolioResponse {
  setHeader(name: string, value: string): void;
  status(code: number): { json(value: unknown): void };
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: FolioRequest, res: FolioResponse, next: () => void): void {
    const requestId = randomUUID();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<FolioRequest>();
    const response = ctx.getResponse<FolioResponse>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = exception instanceof HttpException ? exception.message : 'Unexpected server error';
    const codes: Record<number, string> = {
      400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT',
    };
    response.status(status).json({error: {
      code: codes[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : `HTTP_${status}`),
      message,
      requestId: request.requestId ?? randomUUID(),
    }});
  }
}

/** Auth must provide a trusted principal. Never trust client-provided user IDs. */
@Injectable()
export class UserOwnershipGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FolioRequest>();
    if (!request.auth?.userId) throw new UnauthorizedException('Authentication required');
    if (request.auth.userId !== request.params?.userId) throw new ForbiddenException('Resource is not owned by user');
    return true;
  }
}

@ApiTags('system')
@Controller('v1')
export class HealthController {
  @Get('health')
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

@Module({ controllers: [HealthController, CapabilitiesController] })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(app, new DocumentBuilder()
    .setTitle('Folio API').setDescription('Folio versioned REST API. Capabilities reflect the actual lab status.')
    .setVersion('1').build());
}
export async function createFolioApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  SwaggerModule.setup('openapi', app, createOpenApiDocument(app));
  return app;
}

async function bootstrap(): Promise<void> {
  const app = await createFolioApp();
  await app.listen(Number(process.env.PORT ?? 3100), '127.0.0.1');
}
if (require.main === module) { void bootstrap(); }
