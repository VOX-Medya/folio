import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {eq} from 'drizzle-orm';
import {
  createFolioDb,registerPendingAccount,verifyAccountEmail,signInVerifiedAccount,schema,
  readVerifiedAdminPreparedText,
} from '../src/index.js';

function check(value:unknown,message:string):asserts value {
  if(!value)throw new Error(message);
}
async function deniedAsync(action:()=>Promise<unknown>,message:string){
  try{await action();}catch{return;}
  throw new Error(message);
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
  const cliRun=(command:string,env:NodeJS.ProcessEnv,extra:string[]=[])=>JSON.parse(
    execFileSync(process.execPath,[cli,command,manifestPath,...extra],
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
    const sourceScope={workId:applied.workId,
      editionId:applied.editionId,revisionId:applied.revisionId};
    const previewText=await readVerifiedAdminPreparedText(
      db,session.sessionToken,sourceScope,vault);
    check(previewText?.sourceText===source&&previewText.sha256===manifest.files[0]?.sha256&&
      previewText.sizeBytes===Buffer.byteLength(source),
      'MFA admin cannot read exact private imported source bytes');
    check(await readVerifiedAdminPreparedText(db,session.sessionToken,
      {...sourceScope,workId:randomUUID()},vault)===null,
      'Foreign work ID exposed draft source');
    const guestEmail='folioctl-guest-'+randomUUID()+'@example.com';
    const guest=await registerPendingAccount(db,guestEmail,password);
    await verifyAccountEmail(db,guest.verificationToken);
    const guestSession=await signInVerifiedAccount(db,guestEmail,password,'folioctl-guest');
    await deniedAsync(()=>readVerifiedAdminPreparedText(
      db,guestSession.sessionToken,sourceScope,vault),
      'Unprivileged guest read private editorial source');
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
    const sourcePath=join(vault,'quarantine','catalog',asset.storageKey+'.blob');
    writeFileSync(sourcePath,Buffer.from(source).map((byte,index)=>
      index===0?byte^1:byte));
    await deniedAsync(()=>readVerifiedAdminPreparedText(
      db,session.sessionToken,sourceScope,vault),
      'Tampered source inode unexpectedly released protected bytes');
    // #16: same imported draft, a second manifest that adds one PREPARED
    // audio file (without changing the already-approved text identity).
    const voice=Buffer.from('OggS Synthetic Folio audio fixture only; not playable', 'utf8');
    const audioPath=join(folder,'content/voice.ogg');
    writeFileSync(audioPath,voice);
    const audioManifest={...manifest,files:[
      ...manifest.files,{path:'content/voice.ogg',kind:'audio',
        sha256:createHash('sha256').update(voice).digest('hex'),
        sizeBytes:voice.length},
    ]};
    writeFileSync(manifestPath,JSON.stringify(audioManifest));
    check(block.includeAudio===true,
      'New imported text source cannot anchor prepared voice segment');
    denied(()=>cliRun('attach-audio',mainEnvironment(url,vault),['8000']),
      'Audio attachment accepted missing verified administrator');
    denied(()=>cliRun('attach-audio',mainEnvironment(url,vault,guestSession.sessionToken),['8000']),
      'Audio attachment accepted user without audio:replace MFA permission');
    const stagedBefore=await pool.query<{total:string}>(
      'select count(*)::text as total from audio_variants');
    const tamperedAudio=Buffer.from(voice);
    tamperedAudio[12]=(tamperedAudio[12]??0)^1;
    writeFileSync(audioPath,tamperedAudio);
    denied(()=>cliRun('attach-audio',env,['8000']),
      'Prepared audio with same size but wrong SHA-256 was attached');
    writeFileSync(audioPath,voice);
    const attached=cliRun('attach-audio',env,['8000']);
    check(attached.workId===applied.workId&&
      attached.revisionId===applied.revisionId&&
      attached.audioStatus==='pending_verify'&&
      attached.variantStatus==='draft'&&
      attached.publication==='draft',
      'Prepared audio was not safely associated with the imported draft');
    const [audioAsset]=await db.select().from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id,attached.assetId)).limit(1);
    const [audioVariant]=await db.select().from(schema.audioVariants)
      .where(eq(schema.audioVariants.id,attached.variantId)).limit(1);
    const [segment]=await db.select().from(schema.audioSegments)
      .where(eq(schema.audioSegments.variantId,attached.variantId)).limit(1);
    check(audioAsset?.ownerScope==='catalog'&&audioAsset.ownerUserId===null&&
      audioAsset.status==='pending_verify'&&audioAsset.mime==='audio/ogg'&&
      audioAsset.sha256===audioManifest.files[1]?.sha256&&
      audioVariant?.contentRevisionId===applied.revisionId&&
      audioVariant.status==='draft'&&segment?.assetId===audioAsset.id&&
      segment.textSha256===manifest.files[0]?.sha256&&
      segment.endMs===8000&&
      readFileSync(join(vault,'quarantine','catalog',audioAsset.storageKey+'.blob'))
        .equals(voice),
      'Private owner, stored prepared audio SHA, draft variant or chapter link missing');
    const stagedAfter=await pool.query<{total:string}>(
      'select count(*)::text as total from audio_variants');
    check(Number(stagedAfter.rows[0]?.total)===Number(stagedBefore.rows[0]?.total)+1,
      'Prepared audio variant not created exactly once');
    denied(()=>cliRun('attach-audio',env,['8000']),
      'Repeated attachment overwrote previously staged manual audio');
    const [unpublished]=await db.select().from(schema.works)
      .where(eq(schema.works.id,applied.workId)).limit(1);
    check(unpublished?.publicationStatus==='draft',
      'Audio attachment published an unreviewed work');
    console.log('PREPARED AUDIO PASS: MFA, original text identity, 0600 catalog scope, SHA, draft voice variant, unauthorized/duplicate/bad SHA denial; no TTS or public playback.');
    console.log('PASS: read-only dry-run, denied unauthenticated apply, verified single private draft, repeat noop, checksum/identity reject, unpublished rights.');
  }finally{
    await pool.end();
    rmSync(folder,{recursive:true,force:true});
    rmSync(vault,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
