import {describe,expect,it} from 'vitest';
import {apiErrorSchema,capabilityPageSchema,healthResponseSchema} from '@folio/contracts';
import {createFolioApp} from './main.js';

/**
 * #9 architecture DoD: the real AppModule, not test-only injected controllers.
 * The protected HTTP domains are deliberately sparse until the corresponding
 * V1 issue implements them. A 404 is a security property here, not delivery.
 */
describe('V1-00 modular monolith architecture acceptance',()=>{
  it('registers only versioned domain routes with typed, documented auth choices',async()=>{
    const app=await createFolioApp();
    try{
      const server=await app.listen(0,'127.0.0.1');
      const address=server.address();
      if(!address||typeof address==='string')throw new Error('No server socket');
      const response=await fetch(
        `http://127.0.0.1:${address.port}/openapi-json`,
      );
      expect(response.status).toBe(200);
      const doc=await response.json() as {
        openapi:string;
        components:{securitySchemes:Record<string,unknown>};
        paths:Record<string,Record<string,{
          security?:ReadonlyArray<Record<string,readonly string[]>>;
        }>>;
      };
      expect(doc.openapi).toMatch(/^3\./);
      expect(Object.keys(doc.components.securitySchemes).sort()).toEqual([
        'folioSession','folioWebSession',
      ]);
      expect(doc.paths['/v1/health']?.get).toBeDefined();
      expect(doc.paths['/v1/ready']?.get).toBeDefined();
      expect(doc.paths['/v1/system/capabilities']?.get).toBeDefined();
      expect(doc.paths['/v1/me/onboarding']?.patch).toBeDefined();
      expect(doc.paths['/v1/me/sessions/{sessionId}']?.delete).toBeDefined();
      expect(doc.paths['/v1/auth/web/login']?.post).toBeDefined();
      expect(doc.paths['/v1/admin/mfa/totp/verify']?.post).toBeDefined();
      expect(doc.paths['/v1/admin/catalog/works/{workId}']?.get).toBeDefined();
      expect(doc.paths['/v1/admin/catalog/authors/{authorId}']?.get).toBeDefined();
      for(const [path,operations] of Object.entries(doc.paths)){
        expect(path).toMatch(/^\/v1\//);
        expect(path).not.toMatch(/\/users?(\/|\{|$)|\/people|\/friends\/search|_test/);
        for(const [verb,op] of Object.entries(operations)){
          expect(['get','post','put','patch','delete']).toContain(verb);
          // Every private owner/admin business operation must document
          // both verified native bearer and guarded Web-cookie transports.
          if(path.startsWith('/v1/me/')||
            path.startsWith('/v1/admin/')){
            const methods=op.security?.flatMap(scope=>Object.keys(scope))??[];
            expect(methods.sort()).toEqual(['folioSession','folioWebSession']);
          }
        }
      }
      expect(doc.paths['/v1/works']).toBeUndefined();
      expect(doc.paths['/v1/users']).toBeUndefined();
      expect(doc.paths['/v1/reader']).toBeUndefined();
    }finally{await app.close();}
  });

  it('keeps real disabled/private modules closed with uniform errors and trusted trace IDs',async()=>{
    const vars=[
      'FOLIO_ADMIN_CATALOG_HTTP_MODE','FOLIO_ADMIN_CATALOG_WRITE_MODE',
      'FOLIO_ADMIN_TOTP_HTTP_MODE','FOLIO_WEB_AUTH_MODE',
    ] as const;
    const before=Object.fromEntries(vars.map(key=>[key,process.env[key]]));
    const app=await createFolioApp();
    try{
      for(const key of vars)process.env[key]='off';
      const server=await app.listen(0,'127.0.0.1');
      const address=server.address();
      if(!address||typeof address==='string')throw new Error('No server socket');
      const base=`http://127.0.0.1:${address.port}`;
      const nonce='attacker-forged-request-id';
      const paths=[
        {path:'/v1/me/onboarding',method:'GET',expected:401},
        {path:'/v1/me/sessions',method:'GET',expected:401},
        {path:'/v1/admin/catalog/works',method:'GET',expected:404},
        {path:'/v1/admin/catalog/works',method:'POST',expected:404},
        {path:'/v1/admin/catalog/authors/00000000-0000-4000-8000-000000000001',
          method:'GET',expected:404},
        {path:'/v1/admin/mfa/totp/enroll',method:'POST',expected:404},
        {path:'/v1/auth/web/login',method:'POST',expected:404},
      ] as const;
      const seen=new Set<string>();
      for(const {path,method,expected} of paths){
        const response=await fetch(base+path,{
          method,
          headers:{'x-user-id':'spoofed','x-admin-role':'superadmin',
            'x-request-id':nonce,'x-forwarded-proto':'https',
            ...(method==='POST'?{'content-type':'application/json'}:{})},
          ...(method==='POST'?{body:'{}'}:{}),
        });
        expect(response.status).toBe(expected);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        const error=apiErrorSchema.parse(await response.json());
        expect(error.error.requestId).toBe(response.headers.get('x-request-id'));
        expect(error.error.requestId).not.toBe(nonce);
        expect(seen.has(error.error.requestId)).toBe(false);
        seen.add(error.error.requestId);
        expect(error.error.code).toBe(expected===401?'UNAUTHORIZED':'NOT_FOUND');
      }
      const alive=await fetch(base+'/v1/health');
      expect(healthResponseSchema.parse(await alive.json())).toEqual({status:'ok'});
      const capabilities=await fetch(base+'/v1/system/capabilities?limit=5');
      const list=capabilityPageSchema.parse(await capabilities.json());
      expect(list.items.length).toBeGreaterThan(0);
      expect(list.items.every(entry=>!entry.available)).toBe(true);
      expect((await fetch(base+'/v1/users?query=any')).status).toBe(404);
    }finally{
      await app.close();
      for(const key of vars){
        if(before[key]===undefined)delete process.env[key];
        else process.env[key]=before[key];
      }
    }
  });
});
