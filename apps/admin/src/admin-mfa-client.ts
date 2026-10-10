/**
 * Same-origin browser transport for the default-OFF admin MFA HTTPS server.
 *
 * NEVER persist a password, bearer, CSRF token, authenticator secret or code
 * in Web Storage, URLs, cookies accessible to JS, analytics or console logs.
 * The server owns the __Host- session cookie and authorization decisions.
 */
export type AdminMfaClientErrorKind=
  'secure-https'|'unauthorized'|'forbidden'|'disabled'|'unavailable'|
  'invalid'|'network'|'unexpected';
export class AdminMfaClientError extends Error {
  constructor(public readonly kind:AdminMfaClientErrorKind){
    super(kind);
    this.name='AdminMfaClientError';
  }
}
export type TotpEnrollment={secretBase32:string;expiresAt:string};
export type TotpProof={verified:true;expiresAt:string};
const BASE32=/^[A-Z2-7]{32}$/;
const CSRF=/^[A-Za-z0-9_-]{43}$/;
const OTP=/^\d{6}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function isValidTotpCode(value:string):boolean {
  return typeof value==='string'&&OTP.test(value);
}
function time(value:unknown):value is string{
  return typeof value==='string'&&ISO.test(value)&&!Number.isNaN(Date.parse(value));
}
export function parseTotpEnrollment(data:unknown):TotpEnrollment{
  if(!data||typeof data!=='object'||Array.isArray(data))throw new AdminMfaClientError('unexpected');
  const x=data as Record<string,unknown>;
  if(typeof x.secretBase32!=='string'||!BASE32.test(x.secretBase32)||!time(x.expiresAt)||
    Object.keys(x).some(key=>key!=='secretBase32'&&key!=='expiresAt')){
    throw new AdminMfaClientError('unexpected');
  }
  return {secretBase32:x.secretBase32,expiresAt:x.expiresAt};
}
export function parseTotpProof(data:unknown):TotpProof{
  if(!data||typeof data!=='object'||Array.isArray(data))throw new AdminMfaClientError('unexpected');
  const x=data as Record<string,unknown>;
  if(x.verified!==true||!time(x.expiresAt)||
    Object.keys(x).some(key=>key!=='verified'&&key!=='expiresAt')){
    throw new AdminMfaClientError('unexpected');
  }
  return {verified:true,expiresAt:x.expiresAt};
}
export function isSafeAdminMfaOrigin(protocol:string):boolean{
  return protocol==='https:';
}
function requireDirectHttpsPage():void{
  if(typeof window==='undefined'||!isSafeAdminMfaOrigin(window.location.protocol)){
    throw new AdminMfaClientError('secure-https');
  }
}
function requireToken(csrf:string):string{
  if(!CSRF.test(csrf))throw new AdminMfaClientError('invalid');
  return csrf;
}
async function request(
  path:string,method:'GET'|'POST',body?:unknown,csrf?:string,
):Promise<Response>{
  requireDirectHttpsPage();
  if(!path.startsWith('/v1/')||path.includes('//')){
    throw new AdminMfaClientError('unexpected');
  }
  const headers:Record<string,string>={'Accept':'application/json'};
  if(csrf!==undefined)headers['x-folio-csrf']=requireToken(csrf);
  if(body!==undefined)headers['Content-Type']='application/json';
  let response:Response;
  try{
    response=await fetch(path,{
      method,mode:'same-origin',credentials:'same-origin',
      redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',
      headers,...(body===undefined?{}:{body:JSON.stringify(body)}),
    });
  }catch{
    throw new AdminMfaClientError('network');
  }
  if(response.status===401)throw new AdminMfaClientError('unauthorized');
  if(response.status===403)throw new AdminMfaClientError('forbidden');
  if(response.status===404)throw new AdminMfaClientError('disabled');
  if(response.status===503)throw new AdminMfaClientError('unavailable');
  if(response.status===400||response.status===409)throw new AdminMfaClientError('invalid');
  if(!response.ok)throw new AdminMfaClientError('unexpected');
  return response;
}
async function objectBody(response:Response):Promise<unknown>{
  if(response.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json'){
    throw new AdminMfaClientError('unexpected');
  }
  try{return await response.json() as unknown;}
  catch{throw new AdminMfaClientError('unexpected');}
}

/** Login creates a server-owned HttpOnly Secure SameSite=Strict cookie.
 * Never copy its value into any JavaScript data structure. */
export async function loginAdminWeb(email:string,password:string):Promise<void>{
  if(typeof email!=='string'||email.length<3||email.length>254||
    typeof password!=='string'||password.length<12||password.length>128){
    throw new AdminMfaClientError('invalid');
  }
  const response=await request('/v1/auth/web/login','POST',{email,password});
  if(response.status!==204)throw new AdminMfaClientError('unexpected');
}
/** CSRF is ephemeral JS state, NOT a fallback authentication credential. */
export async function bootstrapAdminWebCsrf():Promise<string>{
  const response=await request('/v1/auth/web/csrf','GET');
  if(response.status!==204)throw new AdminMfaClientError('unexpected');
  const csrf=response.headers.get('x-folio-csrf');
  if(!csrf||!CSRF.test(csrf))throw new AdminMfaClientError('unexpected');
  return csrf;
}
export async function logoutAdminWeb(csrf:string):Promise<void>{
  const response=await request('/v1/auth/web/logout','POST',undefined,csrf);
  if(response.status!==204)throw new AdminMfaClientError('unexpected');
}
export async function beginAdminWebTotp(csrf:string):Promise<TotpEnrollment>{
  const response=await request('/v1/admin/mfa/totp/enroll','POST',{},csrf);
  if(response.status!==200)throw new AdminMfaClientError('unexpected');
  return parseTotpEnrollment(await objectBody(response));
}
/** Confirm a pending factor but do NOT assume the session is MFA-verified. */
export async function confirmAdminWebTotp(csrf:string,code:string):Promise<void>{
  if(!isValidTotpCode(code))throw new AdminMfaClientError('invalid');
  const response=await request('/v1/admin/mfa/totp/confirm','POST',{code},csrf);
  if(response.status!==204)throw new AdminMfaClientError('unexpected');
}
/** A DIFFERENT unused code is needed after enrollment confirmation.
 * Success is a proof attached by PostgreSQL to the current cookie session. */
export async function verifyAdminWebTotp(csrf:string,code:string):Promise<TotpProof>{
  if(!isValidTotpCode(code))throw new AdminMfaClientError('invalid');
  const response=await request('/v1/admin/mfa/totp/verify','POST',{code},csrf);
  if(response.status!==200)throw new AdminMfaClientError('unexpected');
  return parseTotpProof(await objectBody(response));
}
