import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {eq} from 'drizzle-orm';
import {
  createFolioDb,registerPendingAccount,verifyAccountEmail,signInVerifiedAccount,schema,
} from '../src/index.js';

function check(value:unknown,message:string):asserts value {
  if(!value)throw new Error(message);
}
function denied(action:()=>unknown,message:string){
  try{action();}catch{return;}
  throw new Error(message);
}
const cli=fileURLToPath(new URL('../../../tools/folioctl.mjs',import.meta.url));
function mainEnvironment(url:string,root:string,token?:string){
  const env:NodeJS.ProcessEnv={...process.env,DATABASE_URL:url,
    FOLIO_PRIVATE_STORAGE_ROOT:root};
  delete env.FOLIO_ADMIN_BEARER;
  if(token)env.FOLIO_ADMIN_BEARER=token;
  return env;
}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit Folio-only test URL is required');
  const target=new URL(url);
  if(!['localhost','127.0.0.1'].includes(target.hostname)||
    target.port!==(process.env.FOLIO_DB_PORT??'55432')||
    target.pathname!=='/folio_test'){
    throw new Error('Single-book import smoke only runs against Folio loopback folio_test');
  }
  const {db,pool}=createFolioDb(url);
  const folder=mkdtempSync(join(tmpdir(),'folioctl-single-book-'));
  const vault=mkdtempSync(join(tmpdir(),'folioctl-private-vault-'));
  const password='Synthetic-Folioctl-Import-Password-2026!';
  const packageId=randomUUID(),source='Synthetic manual book body for '+packageId;
  const manifestPath=join(folder,'manifest.json');
  const manifest={
    schemaVersion:'1.0.0',packageId,
    book:{title:'Folio Import '+packageId,language:'en',
      authors:['Synthetic Folio Author '+packageId],editionLabel:'Verified sample'},
    files:[{path:'content/source.txt',kind:'text',
      sha256:createHash('sha256').update(source).digest('hex'),
      sizeBytes:Buffer.byteLength(source)}],
  };
  const tables=['authors','works','editions','content_revisions','content_blocks',
    'media_assets','import_batches','import_items','audit_events','rights_records'] as const;
  const counts=async()=>{
    const result:number[]=[];
    for(const table of tables){
      const response=await pool.query('select count(*)::integer as n from '+table);
      result.push(Number(response.rows[0]?.n));
    }
    return result;
  };
  const cliRun=(command:string,env:NodeJS.ProcessEnv)=>JSON.parse(
    execFileSync(process.execPath,[cli,command,manifestPath],
      {encoding:'utf8',env,maxBuffer:2*1024*1024}));
  try{
    mkdirSync(join(folder,'content'));
    writeFileSync(join(folder,'content/source.txt'),source);
    writeFileSync(manifestPath,JSON.stringify(manifest));
    const editorEmail='folioctl-editor-'+randomUUID()+'@example.com';
    const editor=await registerPendingAccount(db,editorEmail,password);
    await verifyAccountEmail(db,editor.verificationToken);
    const session=await signInVerifiedAccount(db,editorEmail,password,'folioctl-import-test');
    const manager=await registerPendingAccount(db,
      'folioctl-granter-'+randomUUID()+'@example.com',password);
    await verifyAccountEmail(db,manager.verificationToken);
    // Only in isolated Folio test DB: seed a synthetic superadmin + MFA session
    // for the real production authorization helper; no runtime bypass added.
    await db.insert(schema.adminRoleMemberships).values({
      userId:editor.userId,role:'superadmin',grantedBy:manager.userId,
    });
    const verifiedAt=new Date();
    await db.insert(schema.adminSessionMfa).values({
      sessionId:session.sessionId,userId:editor.userId,method:'totp',
      verifiedAt,expiresAt:new Date(verifiedAt.getTime()+5*60_000),
    });
    const before=await counts();
    const preview=cliRun('dry-run',mainEnvironment(url,vault));
    check(preview.readOnly===true&&preview.action==='create'&&
      preview.rights==='unreviewed','Read-only draft preview missing');
    check(JSON.stringify(before)===JSON.stringify(await counts()),'Dry-run wrote to PostgreSQL');
    denied(()=>cliRun('apply',mainEnvironment(url,vault)),
      'Apply without authenticated MFA bearer succeeded');
    denied(()=>cliRun('apply',mainEnvironment(url,vault,'A'.repeat(43))),
      'Unknown admin bearer inserted records');
    check(JSON.stringify(before)===JSON.stringify(await counts()),'Denied apply changed DB');
    const env=mainEnvironment(url,vault,session.sessionToken);
    const applied=cliRun('apply',env);
    check(applied.action==='create'&&!applied.alreadyApplied&&
      applied.publication==='draft'&&applied.rights==='unreviewed',
      'First apply failed to create unapproved draft');
    const [work]=await db.select().from(schema.works).where(eq(schema.works.id,applied.workId)).limit(1);
    const [edition]=await db.select().from(schema.editions).where(eq(schema.editions.id,applied.editionId)).limit(1);
    const [revision]=await db.select().from(schema.contentRevisions)
      .where(eq(schema.contentRevisions.id,applied.revisionId)).limit(1);
    const [asset]=await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id,applied.assetId)).limit(1);
    const [block]=await db.select().from(schema.contentBlocks)
      .where(eq(schema.contentBlocks.revisionId,applied.revisionId)).limit(1);
    const rights=await db.select().from(schema.rightsRecords)
      .where(eq(schema.rightsRecords.workId,applied.workId));
    check(!!work&&work.publicationStatus==='draft'&&
      !!edition&&edition.status==='draft'&&edition.workId===work.id&&
      !!revision&&revision.status==='draft'&&revision.editionId===edition.id&&
      !!block&&block.sourceText===source&&block.includeNormal&&block.includeRsvp&&
      !!asset&&asset.ownerScope==='catalog'&&asset.ownerUserId===null&&
      asset.status==='pending_verify'&&rights.length===0,'Imported source, owner, block or rights boundary incorrect');
    check(readFileSync(join(vault,'quarantine','catalog',asset.storageKey+'.blob'),'utf8')===source,
      'Catalog asset not durably stored in private quarantine');
    const after=await counts();
    check(after[0]===before[0]+1&&after[1]===before[1]+1&&after[2]===before[2]+1&&
      after[3]===before[3]+1&&after[4]===before[4]+1&&after[5]===before[5]+1&&
      after[6]===before[6]+1&&after[7]===before[7]+1&&after[9]===before[9],
      'First apply did not persist exactly one private draft');
    const repeat=cliRun('apply',env);
    check(repeat.alreadyApplied&&repeat.batchId===applied.batchId&&
      repeat.workId===applied.workId,'Repeated apply lost original canonical identity');
    check(JSON.stringify(after)===JSON.stringify(await counts()),'Repeated apply inserted duplicate rows');
    writeFileSync(join(folder,'content/source.txt'),source.replace('Synthetic','Synthetix'));
    denied(()=>cliRun('apply',env),'Mutated source accepted stale SHA-256');
    writeFileSync(join(folder,'content/source.txt'),source);
    const other={...manifest,book:{...manifest.book,title:'Other unapproved title'}};
    writeFileSync(manifestPath,JSON.stringify(other));
    const conflict=cliRun('dry-run',mainEnvironment(url,vault));
    check(conflict.action==='conflict','Reused package UUID with changed manifest was not flagged');
    denied(()=>cliRun('apply',env),'Reused package identity silently mutated canonical work');
    check(JSON.stringify(after)===JSON.stringify(await counts()),'Rejected package modified DB');
    console.log('PASS: read-only dry-run, denied unauthenticated apply, verified single private draft, repeat noop, checksum/identity reject, unpublished rights.');
  }finally{
    await pool.end();
    rmSync(folder,{recursive:true,force:true});
    rmSync(vault,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
