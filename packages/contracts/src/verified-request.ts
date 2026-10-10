import {apiErrorSchema} from './index.js';

/** A verified-account API origin. Reject untrusted URL components and cleartext transports. */
export function verifiedApiOrigin(baseUrl:string):string{
  const url=new URL(baseUrl);
  const secure=url.protocol==='https:';
  const local=url.protocol==='http:'&&
    (url.hostname==='localhost'||url.hostname==='127.0.0.1'||url.hostname==='[::1]');
  if((!secure&&!local)||url.username||url.password||
    (url.pathname!=='/'&&url.pathname!=='')||url.search||url.hash){
    throw new Error('A secure API origin is required');
  }
  return url.origin;
}

/** Token ownership is always resolved on server; never log or persist a caller's bearer. */
export function verifiedBearerHeader(raw:string):string{
  if(!/^[A-Za-z0-9_-]{43}$/.test(raw)){
    throw new Error('A verified bearer session is required');
  }
  return 'Bearer '+raw;
}

/** Preserve only safe server error code and correlation ID, not echoed response text. */
export async function readFolioError(response:Response):Promise<{
  code:string;requestId:string|null;
}>{
  let data:unknown;
  try{data=await response.json();}
  catch{data=null;}
  const parsed=apiErrorSchema.safeParse(data);
  return {
    code:parsed.success?parsed.data.error.code:'UNEXPECTED_HTTP_RESPONSE',
    requestId:parsed.success?parsed.data.error.requestId:null,
  };
}
