/**
 * A deliberately small transactional email boundary. Resend delivery is
 * opt-in with an approved sender/key; no provider SDK, queue or new service.
 * A provider HTTP 2xx means accepted for delivery, not inbox delivery proof.
 */
export interface VerificationMailConfig{
  mode?:string;
  apiKey?:string;
  from?:string;
  webOrigin?:string;
}

export function requireVerificationMailConfig(env:NodeJS.ProcessEnv):VerificationMailConfig{
  if(env.FOLIO_VERIFICATION_MAIL_MODE!=='resend-https'||
    !env.FOLIO_RESEND_API_KEY||!/^re_[A-Za-z0-9_]{12,}$/.test(env.FOLIO_RESEND_API_KEY)||
    !env.FOLIO_RESEND_FROM||!/^\S+@\S+\.\S+$/.test(env.FOLIO_RESEND_FROM)||
    env.FOLIO_RESEND_FROM.length>254||
    !env.FOLIO_WEB_AUTH_ORIGIN){
    throw new Error('Verification mail delivery unavailable');
  }
  const url=new URL(env.FOLIO_WEB_AUTH_ORIGIN);
  if(url.protocol!=='https:'||url.origin!==env.FOLIO_WEB_AUTH_ORIGIN||
    url.pathname!=='/'||url.username||url.password||url.search||url.hash){
    throw new Error('Verification mail delivery unavailable');
  }
  return {
    mode:'resend-https',apiKey:env.FOLIO_RESEND_API_KEY,
    from:env.FOLIO_RESEND_FROM,webOrigin:url.origin,
  };
}

export async function dispatchVerificationMail(
  email:string,secret:string,config:VerificationMailConfig,fetcher:typeof fetch=fetch,
):Promise<void>{
  if(config.mode!=='resend-https'||!config.apiKey||!config.from||
    !config.webOrigin||!/^\S+@\S+\.\S+$/.test(email)||
    !/^[A-Za-z0-9_-]{43}$/.test(secret)){
    throw new Error('Verification mail delivery unavailable');
  }
  const response=await fetcher('https://api.resend.com/emails',{
    method:'POST',redirect:'error',cache:'no-store',
    signal:AbortSignal.timeout(8000),
    headers:{
      authorization:'Bearer '+config.apiKey,
      'content-type':'application/json',
      'user-agent':'folio-mvp/0.1',
    },
    body:JSON.stringify({
      from:config.from,to:[email],subject:'Folio | Verify your email',
      text:'Your Folio verification code (valid for 15 minutes):\n\n'+secret+
        '\n\nOpen '+config.webOrigin+'/profile and paste the code to activate your account.'+
        '\nNever share this code.',
    }),
  });
  // Do not include provider response, address, token, API key or payload in logs.
  if(!response.ok)throw new Error('Verification mail delivery unavailable');
}
