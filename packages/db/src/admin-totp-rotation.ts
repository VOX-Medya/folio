import {eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import {withVerifiedAdminPermission} from './admin-authorization.js';
import {
  decryptTotpSeed,encryptTotpSeedForVersion,
  requireTotpKeyring,requireVersionedTotpKey,
} from './admin-totp-crypto.js';
import type {TotpKeyMaterial,TotpKeyVersion} from './admin-totp-crypto.js';
import * as schema from './schema.js';

type Db=ReturnType<typeof createFolioDb>['db'];
export type TotpEnvelopeRotation={
  userId:string;
  fromVersion:TotpKeyVersion;
  toVersion:TotpKeyVersion;
  changed:boolean;
};
const uuid=z.uuid();
const explanation=z.string().trim().min(12).max(1200);

/**
 * Two-key operator staging: deploy readers with BOTH keys before rewrapping
 * any account. No public route, API bootstrap, key file, or production CLI.
 *
 * Rewrap ONLY an existing factor; never issue/reset a new OTP secret. The
 * operation and audit commit under exactly the same superadmin + device MFA
 * transaction as role authorization. Every other factor state is preserved.
 * An approved operator must separately decide when retiring the v1 key.
 */
export async function rotateAdminTotpEnvelopeForUser(
  db:Db,adminBearer:string,rawUserId:string,
  fromVersion:TotpKeyVersion,toVersion:TotpKeyVersion,
  rawKeys:TotpKeyMaterial,reason:string,requestId:string,
):Promise<TotpEnvelopeRotation>{
  const userId=uuid.parse(rawUserId);
  const trace=uuid.parse(requestId);
  const why=explanation.parse(reason);
  if(fromVersion===toVersion||
    !['v1','v2'].includes(fromVersion)||!['v1','v2'].includes(toVersion)){
    throw new Error('Distinct supported TOTP key versions required');
  }
  const keys=requireTotpKeyring(rawKeys);
  const oldKey=requireVersionedTotpKey(keys,fromVersion);
  const newKey=requireVersionedTotpKey(keys,toVersion);
  return withVerifiedAdminPermission(db,adminBearer,'users:support',
    async(tx,actor)=>{
      const [row]=await tx.select().from(schema.adminTotpCredentials)
        .where(eq(schema.adminTotpCredentials.userId,userId))
        .limit(1).for('update');
      if(!row)throw new Error('Admin factor does not exist');
      if(row.keyVersion===toVersion){
        // A duplicate or racing operator action is a no-op, without a false
        // audit event or a new IV.
        return {userId,fromVersion,toVersion,changed:false};
      }
      if(row.keyVersion!==fromVersion){
        throw new Error('Unexpected TOTP key version: refuse blind rewrite');
      }
      const seed=decryptTotpSeed(userId,row,oldKey);
      let encrypted:ReturnType<typeof encryptTotpSeedForVersion>;
      try{
        encrypted=encryptTotpSeedForVersion(userId,seed,newKey,toVersion);
      }finally{
        seed.fill(0);
      }
      await tx.update(schema.adminTotpCredentials)
        .set({...encrypted,updatedAt:new Date()})
        .where(eq(schema.adminTotpCredentials.userId,userId));
      await tx.insert(schema.auditEvents).values({
        actorId:actor.userId,action:'admin.totp.envelope.rotated',
        entityType:'user_account',entityId:userId,
        requestId:trace,reason:why,
        beforeJson:{keyVersion:fromVersion},
        afterJson:{keyVersion:toVersion},
      });
      return {userId,fromVersion,toVersion,changed:true};
    });
}

/** Privileged inventory gate for deciding whether an old deployment key may
 * be withdrawn. The return value contains ONLY version counts, never a seed,
 * username, ciphertext, or factor IDs. Refuse a retirement decision if any
 * v1 row remains, including pending or revoked-role factors. */
export async function inspectAdminTotpKeyVersions(
  db:Db,adminBearer:string,
):Promise<{v1:number;v2:number}>{
  return withVerifiedAdminPermission(db,adminBearer,'users:support',
    async(tx)=>{
      const rows=await tx.select({
        keyVersion:schema.adminTotpCredentials.keyVersion,
        total:sql<number>`count(*)::integer`,
      }).from(schema.adminTotpCredentials)
        .groupBy(schema.adminTotpCredentials.keyVersion);
      const counts={v1:0,v2:0};
      for(const row of rows){
        if(row.keyVersion!=='v1'&&row.keyVersion!=='v2'){
          throw new Error('Unknown persisted TOTP key version');
        }
        counts[row.keyVersion]=row.total;
      }
      return counts;
    });
}
