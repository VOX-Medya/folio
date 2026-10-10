/**
 * Central V1 permission names, shared by Admin, NestJS and audit.
 * This is NOT an authentication scheme: only trusted server sessions may
 * supply role memberships. Raw client headers are not role evidence.
 */
export const adminRoles=['superadmin','editor','rights','audio','moderator','read-only'] as const;
export type AdminRole=(typeof adminRoles)[number];

export const adminPermissions=[
  'admin:view',
  'catalog:read','catalog:edit','content:revise',
  'rights:read','rights:review',
  'audio:read','audio:replace',
  'import:preview','import:apply',
  'moderation:review','users:support','audit:read',
  'personal:book:read',
] as const;
export type AdminPermission=(typeof adminPermissions)[number];

const grants:Record<Exclude<AdminRole,'superadmin'>,readonly AdminPermission[]>={
  editor:['admin:view','catalog:read','catalog:edit','content:revise','rights:read','import:preview'],
  rights:['admin:view','catalog:read','rights:read','rights:review','import:preview'],
  audio:['admin:view','catalog:read','audio:read','audio:replace'],
  moderator:['admin:view','moderation:review'],
  'read-only':['admin:view','catalog:read'],
};

/**
 * Fail-closed, including superadmin: private user book BODIES are inaccessible
 * by default. A future explicitly authorized support workflow is separate.
 */
export function hasAdminPermission(rawRoles:readonly string[],rawPermission:string):boolean{
  if(!adminPermissions.includes(rawPermission as AdminPermission))return false;
  if(rawPermission==='personal:book:read')return false;
  return rawRoles.some(role=>{
    if(!adminRoles.includes(role as AdminRole))return false;
    if(role==='superadmin')return true;
    return grants[role as Exclude<AdminRole,'superadmin'>]?.includes(rawPermission as AdminPermission)??false;
  });
}
