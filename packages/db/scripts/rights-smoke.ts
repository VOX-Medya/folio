import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {createFolioDb,createCanonicalAuthor,createCanonicalWork,getCanonicalWorkDetails,createContentRevision,sha256Text,
  submitRightsEvidence,reviewRightsEvidence,verifyRightsForAction,schema} from '../src/index.js';

async function main():Promise<void>{
  const url=process.env.DATABASE_URL;
  if (!url || !url.endsWith('/folio_test')) throw new Error('Rights tests require the isolated folio_test DB');
  const {db,pool}=createFolioDb(url);
  const actor=randomUUID();
  try {
    const author=await createCanonicalAuthor(db,actor,{canonicalName:`Rights Fixture ${randomUUID()}`});
    const work=await createCanonicalWork(db,actor,{originalTitle:'Synthetic Rights Fixture',originalLanguage:'tr',
      authors:[{authorId:author.id}],editions:[{language:'tr',label:'Unpublished draft'}]});
    const editionId=(await getCanonicalWorkDetails(db,work.id))?.editions[0]?.id;
    if (!editionId) throw new Error('Missing draft edition');
    const sourceText='This is only synthetic test content.';
    const rev=await createContentRevision(db,actor,{
      editionId,language:'tr',rawArtifactKey:`private/test/${randomUUID()}`,
      rawSha256:'c'.repeat(64),parserVersion:'manual-fixture',provenance:{sourceName:'manual_local_pkg'},
      chapters:[{chapterId:randomUUID(),ordinal:0,heading:'Fixture',blocks:[{
        blockId:randomUUID(),ordinal:0,kind:'paragraph',locator:{format:'text',path:'0/0'},sourceText,
        textSha256:sha256Text(sourceText),includeRsvp:true,includeAudio:true,
      }]}],
    });
    const base={workId:work.id,editionId,revisionId:rev.revision.id,territory:'TR',action:'display'} as const;
    const check=(q:typeof base)=>verifyRightsForAction(db,q);
    let state=await check(base);
    if (state.allowed || state.reason!=='missing') throw new Error('Unapproved rights incorrectly allowed');
    const evidence={evidence:'Synthetic reviewed evidence. No publishing rights claimed.',licenseKind:'restricted',
      territories:['TR','GB'],displayAllowed:true,translationAllowed:false,audioAllowed:false,sharingAllowed:false};
    const workRights=await submitRightsEvidence(db,actor,{...evidence,workId:work.id});
    const editionRights=await submitRightsEvidence(db,actor,{...evidence,workId:work.id,editionId});
    const revisionRights=await submitRightsEvidence(db,actor,{...evidence,workId:work.id,editionId,revisionId:rev.revision.id});
    state=await check(base);
    if(state.allowed || state.reason!=='unreviewed') throw new Error('Pending evidence leaked rights');
    let wrongScopeRejected=false;
    try {await submitRightsEvidence(db,actor,{...evidence,workId:randomUUID(),editionId});}
    catch {wrongScopeRejected=true;}
    if (!wrongScopeRejected) throw new Error('Mismatched work/edition rights accepted');
    const rationale='Local test reviewer approval, not a real license.';
    await reviewRightsEvidence(db,actor,workRights.id,'approved',rationale);
    if ((await check(base)).allowed) throw new Error('Work-level approval bypassed edition/revision');
    await reviewRightsEvidence(db,actor,editionRights.id,'approved',rationale);
    if ((await check(base)).allowed) throw new Error('Edition-level approval bypassed revision');
    await reviewRightsEvidence(db,actor,revisionRights.id,'approved',rationale);
    if (!(await check(base)).allowed) throw new Error('Explicit three-level TR display approval denied');
    const us=await verifyRightsForAction(db,{...base,territory:'US'});
    if (us.allowed || us.reason!=='territory') throw new Error('Country restriction bypassed');
    for (const action of ['audio','translation','sharing'] as const){
      const denied=await verifyRightsForAction(db,{...base,action});
      if(denied.allowed || denied.reason!=='prohibited') throw new Error(`Restricted ${action} was allowed`);
    }
    await db.update(schema.rightsRecords).set({expiresAt:new Date('2000-01-01')})
      .where(eq(schema.rightsRecords.id,revisionRights.id));
    if ((await check(base)).reason!=='expired') throw new Error('Expired rights still allowed');
    await db.update(schema.rightsRecords).set({expiresAt:null}).where(eq(schema.rightsRecords.id,revisionRights.id));
    await reviewRightsEvidence(db,actor,revisionRights.id,'withdrawn','Reviewer withdraws the test rights record.');
    if ((await check(base)).allowed) throw new Error('Withdrawn rights still allowed');
    let restorationRejected=false;
    try {await reviewRightsEvidence(db,actor,revisionRights.id,'approved',rationale);}
    catch {restorationRejected=true;}
    if(!restorationRejected) throw new Error('Withdrawn rights silently restored');
    // Real competing PostgreSQL connections: an approval must never race
    // a withdrawal into the last committed status for the same evidence.
    const competing=createFolioDb(url);
    try{
      for(let attempt=0;attempt<4;attempt++){
        const contested=await submitRightsEvidence(db,actor,{
          ...evidence,workId:work.id,editionId,revisionId:rev.revision.id,
          evidence:'Synthetic contested rights review requiring a human decision.',
        });
        const otherReviewer=randomUUID();
        const outcomes=await Promise.allSettled([
          reviewRightsEvidence(db,actor,contested.id,'withdrawn',
            'Reviewer withdraws synthetic evidence while another review is pending.'),
          reviewRightsEvidence(competing.db,otherReviewer,contested.id,'approved',
            'Competing reviewer tries to approve synthetic evidence at the same time.'),
        ]);
        if(outcomes[0]?.status!=='fulfilled'){
          throw new Error('Concurrent withdrawal did not finish');
        }
        const [final]=await db.select().from(schema.rightsRecords)
          .where(eq(schema.rightsRecords.id,contested.id)).limit(1);
        if(final?.reviewStatus!=='withdrawn'){
          throw new Error('Concurrent approval restored a withdrawn rights record');
        }
        const events=await db.select().from(schema.auditEvents)
          .where(eq(schema.auditEvents.entityId,contested.id));
        if(events.filter(e=>e.action==='rights.review.withdrawn').length!==1){
          throw new Error('Concurrent withdrawal was not audited exactly once');
        }
        if(outcomes[1]?.status==='rejected'&&
          !String(outcomes[1].reason).includes('Withdrawn rights cannot be restored')){
          throw new Error('Competing reviewer rejected for an unexpected cause');
        }
      }
    }finally{await competing.pool.end();}
    const [workRow]=await db.select().from(schema.works).where(eq(schema.works.id,work.id));
    if(workRow?.publicationStatus!=='draft') throw new Error('Rights tests published a fixture');
    const audit=await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId,revisionRights.id));
    if(!audit.some(event=>event.action==='rights.review.withdrawn')) throw new Error('Withdrawal audit missing');
    console.log('Rights gate PASS: missing/pending deny, three-level approval, TR allowed/US denied, audio/translation/share denied, expiry+withdrawal revoke, scope FK, audit; draft never published.');
  } finally {await pool.end();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
