import {publishedReaderTextSchema} from './index.js';
import type {PublishedReaderText} from './index.js';

export class PublishedReaderHttpError extends Error{
  constructor(readonly status:number){
    super('Published reader text is not available');
    this.name='PublishedReaderHttpError';
  }
}

/** Never send a cookie or user identity on the published-read endpoint. */
export async function fetchPublishedReaderText(
  baseUrl:string,rawRevisionId:unknown,
  options?:{signal?:AbortSignal;fetcher?:typeof fetch},
):Promise<PublishedReaderText>{
  const revisionId=publishedReaderTextSchema.shape.revisionId.parse(rawRevisionId);
  let url:URL;
  try{url=new URL(baseUrl);}catch{throw new Error('Configured HTTPS reader origin required');}
  if(url.protocol!=='https:'||url.username||url.password||
    url.pathname!=='/'||url.search||url.hash||url.origin!==baseUrl||
    (typeof window!=='undefined'&&window.location.origin!==url.origin)){
    throw new Error('Same-origin HTTPS reader required');
  }
  const response=await (options?.fetcher??fetch)(
    url.origin+'/v1/catalog/reader/'+encodeURIComponent(revisionId),{
      method:'GET',credentials:'omit',mode:'same-origin',
      cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',
      headers:{accept:'application/json'},
      ...(options?.signal?{signal:options.signal}:{}),
    });
  if(!response.ok||response.status!==200)throw new PublishedReaderHttpError(response.status);
  let raw:unknown;
  try{raw=await response.json();}catch{throw new PublishedReaderHttpError(200);}
  const parsed=publishedReaderTextSchema.safeParse(raw);
  if(!parsed.success||parsed.data.revisionId!==revisionId)throw new PublishedReaderHttpError(200);
  return parsed.data;
}
