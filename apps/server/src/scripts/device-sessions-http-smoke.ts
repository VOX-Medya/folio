import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {createFolioDb,registerPendingAccount,verifyAccountEmail,
  signInVerifiedAccount} from '@folio/db';
import {apiErrorSchema,deviceSessionInventorySchema} from '@folio/contracts';
import {createFolioApp} from '../main.js';

function check(x:unknown,message:string):asserts x{if(!x)throw new Error(message);}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit isolated Folio test URL required');
  const parsed=new URL(url);
  if(parsed.pathname!=='/folio_test'||
    !['127.0.0.1','localhost'].includes(parsed.hostname)||
    parsed.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('Only local Folio folio_test DB is permitted');
  }
  const {db,pool}=createFolioDb(url);
  const password='Synthetic-Owned-Device-HTTP-2026!';
  async function newAccount(){
    const email='synthetic-device-http-'+randomUUID()+'@example.com';
    const pending=await registerPendingAccount(db,email,password);
    await verifyAccountEmail(db,pending.verificationToken);
    return {email,userId:pending.userId};
  }
  let app:Awaited<ReturnType<typeof createFolioApp>>|undefined;
  try{
    const owner=await newAccount(),foreign=await newAccount();
    const web=await signInVerifiedAccount(db,owner.email,password,'web');
    const android=await signInVerifiedAccount(db,owner.email,password,'android');
    const tablet=await signInVerifiedAccount(db,owner.email,password,'tablet');
    const outsider=await signInVerifiedAccount(db,foreign.email,password,'other user');
    app=await createFolioApp();
    const listener=await app.listen(0,'127.0.0.1');
    const address=listener.address();
    if(!address||typeof address==='string')throw new Error('No ephemeral HTTP port');
    const root='http://127.0.0.1:'+address.port+'/v1/me/sessions';
    const headers=(bearer:string)=>({
      authorization:'Bearer '+bearer,'x-user-id':foreign.userId,
      'x-admin-role':'superadmin','x-request-id':'caller-spoof',
    });
    const read=(bearer:string)=>fetch(root,{headers:headers(bearer)});
    const revoke=(bearer:string,id:string)=>fetch(root+'/'+id,{
      method:'DELETE',headers:headers(bearer),
    });
    const unauth=await fetch(root,{headers:{'x-user-id':owner.userId,
      'x-admin-role':'superadmin'}});
    check(unauth.status===401,'Untrusted headers read device sessions');
    check(unauth.headers.get('cache-control')?.includes('no-store'),
      'Private unauthorized device metadata is cacheable');
    const ownRes=await read(web.sessionToken);
    check(ownRes.status===200,'Verified account cannot list owned devices');
    const inventory=deviceSessionInventorySchema.parse(await ownRes.json());
    check(inventory.items.length===3,'Expected exactly three owner device sessions');
    check(inventory.items.filter(x=>x.isCurrent).length===1&&
      inventory.items.find(x=>x.isCurrent)?.id===web.sessionId,
      'Current device identification incorrect');
    const printed=JSON.stringify(inventory);
    check(!printed.includes('tokenDigest')&&
      !printed.includes(web.sessionToken)&&!printed.includes(android.sessionToken)&&
      !printed.includes(owner.email),'Secret or account email leaked in inventory');
    check(ownRes.headers.get('cache-control')?.includes('no-store'),
      'Private session inventory response may be cached');
    const stranger=deviceSessionInventorySchema.parse(await (await read(
      outsider.sessionToken)).json());
    check(stranger.items.length===1&&stranger.items[0]?.id===outsider.sessionId,
      'Device inventory leaked another account');

    check((await fetch(root+'?userId='+foreign.userId,{
      headers:headers(web.sessionToken)})).status===400,
      'Query-supplied owner was accepted');
    const malformed=await revoke(web.sessionToken,'not-a-uuid');
    check(malformed.status===400,'Malformed session UUID not rejected');
    const foreignRevoke=await revoke(web.sessionToken,outsider.sessionId);
    check(foreignRevoke.status===404,'Foreign device was not masked as missing');
    const missing=apiErrorSchema.parse(await foreignRevoke.json());
    check(missing.error.code==='NOT_FOUND'&&
      missing.error.requestId===foreignRevoke.headers.get('x-request-id'),
      'Foreign-session denial broke request ID contract');
    check((await read(outsider.sessionToken)).status===200,
      'Foreign device session was revoked');

    const [first,second]=await Promise.all([
      revoke(web.sessionToken,android.sessionId),
      revoke(tablet.sessionToken,android.sessionId),
    ]);
    check(first.status===204&&second.status===204,
      'Concurrent owner revocations were not idempotent');
    check((await read(android.sessionToken)).status===401,
      'Revoked Android token still works');
    check((await read(web.sessionToken)).status===200&&
      (await read(tablet.sessionToken)).status===200,
      'Revoking Android invalidated another device');
    check((await revoke(web.sessionToken,android.sessionId)).status===204,
      'Idempotent repeated own delete failed');
    const audits=await pool.query<{
      entity_id:string;request_id:string|null;after_json:unknown;
    }>("SELECT entity_id,request_id,after_json FROM audit_events WHERE actor_id=$1::uuid AND action='auth.session.revoked'",
      [owner.userId]);
    const matching=audits.rows.filter(a=>a.entity_id===android.sessionId);
    check(matching.length===1,'Concurrent deletes created repeated audit events');
    const ids=new Set([first.headers.get('x-request-id'),second.headers.get('x-request-id')]);
    check(ids.has(matching[0]?.request_id),
      'Audit request ID did not originate from HTTP middleware');
    check(!JSON.stringify(audits.rows).includes(android.sessionToken),
      'Audit contained raw bearer token');

    const current=await revoke(web.sessionToken,web.sessionId);
    check(current.status===204,'Self logout failed');
    check((await read(web.sessionToken)).status===401,
      'Self-revocation left bearer usable');
    check((await read(tablet.sessionToken)).status===200,
      'Remaining owned device was logged out');
    check((await revoke(outsider.sessionToken,tablet.sessionId)).status===404,
      'Foreign principal could revoke remaining device');
    check((await read(tablet.sessionToken)).status===200,
      'Cross-user revoke changed remaining device');

    const spec=await fetch('http://127.0.0.1:'+address.port+'/openapi-json');
    const doc=await spec.json() as {paths:Record<string,Record<string,unknown>>};
    check(!!doc.paths['/v1/me/sessions']?.get&&
      !!doc.paths['/v1/me/sessions/{sessionId}']?.delete,
      'Owner device routes missing in OpenAPI');
    console.log('DEVICE SESSIONS HTTP PASS: verified inventory, no raw bearer/digest, spoofed owner 401/404, concurrent owner revocation idempotent, audit request-id, self logout, cross-user isolation, no-store, OpenAPI. Folio test DB only.');
  }finally{
    if(app)await app.close();
    await pool.end();
  }
}
void main().catch(err=>{console.error(err);process.exitCode=1;});
