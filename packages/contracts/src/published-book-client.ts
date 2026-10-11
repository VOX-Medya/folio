import {publishedBookDetailSchema} from './index.js';
import type {PublishedBookDetail} from './index.js';

export class PublishedBookHttpError extends Error {
  constructor(readonly status:number){
    super('Published book not available');
    this.name='PublishedBookHttpError';
  }
}

/** No cookies, bearer, redirects or client-supplied territory. Public metadata only. */
export async function fetchPublishedBookDetail(
  baseUrl:string,rawWorkId:unknown,
  options?:{signal?:AbortSignal;fetcher?:typeof fetch},
):Promise<PublishedBookDetail>{
  const workId=publishedBookDetailSchema.shape.id.parse(rawWorkId);
  let url:URL;
  try{url=new URL(baseUrl);}
  catch{throw new Error('A configured HTTPS catalog origin is required');}
  if(url.protocol!=='https:'||url.username||url.password||
    url.pathname!=='/'||url.search||url.hash||url.origin!==baseUrl||
    (typeof window!=='undefined'&&window.location.origin!==url.origin)){
    throw new Error('A same-origin HTTPS catalog is required');
  }
  const response=await (options?.fetcher??fetch)(
    url.origin+'/v1/catalog/works/'+encodeURIComponent(workId),{
      method:'GET',credentials:'omit',cache:'no-store',redirect:'error',
      referrerPolicy:'no-referrer',headers:{accept:'application/json'},
      ...(options?.signal?{signal:options.signal}:{}),
    });
  if(!response.ok)throw new PublishedBookHttpError(response.status);
  if(response.status!==200)throw new PublishedBookHttpError(response.status);
  let json:unknown;
  try{json=await response.json();}
  catch{throw new PublishedBookHttpError(200);}
  const parsed=publishedBookDetailSchema.safeParse(json);
  if(!parsed.success)throw new PublishedBookHttpError(200);
  if(parsed.data.id!==workId)throw new PublishedBookHttpError(200);
  return parsed.data;
}
