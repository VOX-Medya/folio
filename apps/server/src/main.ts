import 'reflect-metadata';
import {MiddlewareConsumer, Module, NestModule} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ApiExceptionFilter, RequestIdMiddleware } from './common/http.js';
import { SystemModule } from './modules/system/system.module.js';
import { AccountOnboardingModule } from './modules/account/onboarding.module.js';
import { WebAuthModule } from './modules/auth/web-auth.module.js';
import { AdminTotpModule } from './modules/auth/admin-totp.module.js';
import { AdminCatalogModule } from './modules/admin/catalog.module.js';
import { PublishedCatalogModule } from './modules/catalog/public-catalog.module.js';
import { ShelfModule } from './modules/account/shelf.module.js';
import { ReadingPositionModule } from './modules/account/reading-position.module.js';
import { OwnProfileModule } from './modules/account/own-profile.module.js';
import { FriendshipModule } from './modules/account/friendship.module.js';

export {ApiExceptionFilter, RequestIdMiddleware, UserOwnershipGuard} from './common/http.js';
export {HealthController, CapabilitiesController, ReadinessController, DbReadinessService} from './modules/system/system.module.js';

/** A single modular monolith. Product modules join only when their guarded routes exist. */
@Module({imports: [SystemModule,AccountOnboardingModule,WebAuthModule,AdminTotpModule,AdminCatalogModule,PublishedCatalogModule,ShelfModule,ReadingPositionModule,OwnProfileModule,FriendshipModule]})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(app, new DocumentBuilder()
    .setTitle('Folio API').setDescription('Folio versioned REST API. Capabilities reflect the actual lab status.')
    .setVersion('1').addBearerAuth({type:'http',scheme:'bearer',bearerFormat:'opaque'},'folioSession')
    .addSecurity('folioWebSession',{type:'apiKey',in:'cookie',name:'__Host-folio_session'}).build());
}
export async function createFolioApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  SwaggerModule.setup('openapi', app, createOpenApiDocument(app));
  return app;
}

async function bootstrap(): Promise<void> {
  const app = await createFolioApp();
  await app.listen(Number(process.env.PORT ?? 3100), process.env.HOST ?? '127.0.0.1');
}
if (require.main === module) { void bootstrap(); }
