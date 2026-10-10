import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiOperation, ApiTags, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

@ApiTags('system')
@Controller('v1')
export class HealthController {
  @Get('health')
  @ApiOperation({ summary: 'Health probe' })
  health(): { status: string } { return { status: 'ok' }; }
}

@Module({controllers: [HealthController]})
export class AppModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Folio API').setVersion('1').build());
  SwaggerModule.setup('openapi', app, document);
  await app.listen(Number(process.env.PORT ?? 3100), '127.0.0.1');
}
if (require.main === module) { void bootstrap(); }
