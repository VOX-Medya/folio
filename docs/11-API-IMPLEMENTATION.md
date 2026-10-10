# Folio V1 API implementation baseline (#9)

## Runtime and intended ownership
The API is a NestJS modular monolith, currently exposing only `/v1/health` and `/v1/system/capabilities`. OpenAPI docs at `/openapi`, JSON at `/openapi-json`, snapshot at `docs/api/openapi.v1.json`. The capability endpoint deliberately returns `available: false` until each product API is actually implemented. There are no mock users or catalog records.

- Every request receives a server-generated `x-request-id`, independent of untrusted incoming headers; the response error includes the same UUID.
- `@folio/contracts` contains cross-platform Zod validation and cursor/page/error schemas. The typed `fetchCapabilities` client can run on web/native/admin without Node-only Buffer use.
- Cursor pagination enforces bounded result size (1-50), a strict query shape and a canonical opaque cursor. Invalid and unknown cursors result in HTTP 400.
- An owner resource guard accepts a user context only when it is provided by trusted auth middleware. It denies absent or mismatched principal IDs; client-supplied IDs alone cannot authenticate a user. Real session attachment will be implemented with #30.
- Liveness `/v1/health` checks the process only; DB and queue readiness endpoints will be added as #10 integrates them. 200 liveness is not an assertion that Postgres is healthy.
- Contracts and error formats are tested over a real loopback HTTP listener. OpenAPI drift is blocked by `pnpm --filter @folio/server openapi:check` during `pnpm check`. Snapshot updates use `pnpm --filter @folio/server openapi:write`, followed by review and test.

## Future module boundaries
Auth/permissions, catalog/rights, reading/progress, social/invites, storage, import/export, audit and jobs share **one API** and **one DB**. No independent microservices, Redis, scraping, AI translation/TTS, or active provider integration is required for V1.

This baseline does not claim full RBAC, authentication, persistence, request throttling, content sanitization, or production readiness; those are tracked under V1 tasks #10, #12-#30, #45-#48. All private resources remain unavailable until proper authorization is implemented.

## Moduler HTTP sinirlari (#9, 10 Ekim 2026)
`apps/server/src/main.ts` sadece Nest uygulama bootstrap, `AppModule`, global request-id middleware, exception filter ve OpenAPI kurulumunu bir araya getirir. `modules/system/system.module.ts` saglik, DB readiness ve mevcut ozellik durumu API endpointlerini tasir. `common/http.ts` fail-closed kullanici kaynak sahipligi guard'i, normalized hata cevabi ve sunucunun urettigi request-id katmanini tanimlar. Yeni katalog, kullanici, reader veya admin endpointleri bagimsiz Nest modullerine, ilgili yetki kontrolleri tamamlandiginda eklenecektir. Bos ozellik modulleri ya da sahte calisan API'ler eklenmedi.

`owner-http.spec.ts`, SADECE TEST modulu icinde `@UseGuards(UserOwnershipGuard)` ile gercek ephemeral HTTP endpoint kurar. Gercek header icindeki `x-user-id` ya da `x-request-id` guvenilir auth olamaz: kimliksiz 401, baska principal 403, test katmani tarafindan onayli ayni principal 200; her reddin response `x-request-id` ile hata UUID'si birebirdir. Bu endpoint production AppModule icinde tanimli degildir. `http.spec.ts` ayrica paylasilan `fetchCapabilities()` istemcisinin gercek NestJS endpointinden donen Zod verisiyle ayni sonucu aldigini dogrular. OpenAPI snapshot degismedi.

Bu #9 icin mimari ve HTTP test iyilestirmesidir. Gercek admin oturumu/MFA (#30/#43), DB audit olaylarina istege ozgu request-id baglama ve butun kaynak rotalarinda hak/ownership enforcement sonraki islerin kabul kosuludur. Yetkisiz private endpoint eklenmedigi icin #9 su asamada otomatik tamamlandi sayilmaz.
