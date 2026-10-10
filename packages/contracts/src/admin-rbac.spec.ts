import {describe,expect,it} from 'vitest';
import {adminPermissions,adminRoles,hasAdminPermission} from './admin-rbac.js';

describe('server-owned default deny V1 admin RBAC policy',()=>{
  it('uses a finite V1 role set and an explicit permission catalog',()=>{
    expect(new Set(adminRoles).size).toBe(6);
    expect(new Set(adminPermissions).size).toBe(adminPermissions.length);
    expect(hasAdminPermission([],'admin:view')).toBe(false);
    expect(hasAdminPermission(['untrusted'],'admin:view')).toBe(false);
    expect(hasAdminPermission(['superadmin'],'arbitrary:power')).toBe(false);
  });
  it('never grants reading private book content, even to superadmin',()=>{
    for(const role of adminRoles){
      expect(hasAdminPermission([role],'personal:book:read')).toBe(false);
    }
  });
  it('isolates editor, rights, audio and moderator write operations',()=>{
    expect(hasAdminPermission(['editor'],'catalog:edit')).toBe(true);
    expect(hasAdminPermission(['editor'],'rights:review')).toBe(false);
    expect(hasAdminPermission(['rights'],'rights:review')).toBe(true);
    expect(hasAdminPermission(['rights'],'audio:replace')).toBe(false);
    expect(hasAdminPermission(['audio'],'audio:replace')).toBe(true);
    expect(hasAdminPermission(['audio'],'users:support')).toBe(false);
    expect(hasAdminPermission(['moderator'],'moderation:review')).toBe(true);
    expect(hasAdminPermission(['moderator'],'catalog:edit')).toBe(false);
  });
  it('keeps read-only accounts non-mutating; superadmin has known non-private permissions',()=>{
    expect(hasAdminPermission(['read-only'],'admin:view')).toBe(true);
    expect(hasAdminPermission(['read-only'],'catalog:read')).toBe(true);
    for(const p of ['catalog:edit','rights:review','import:apply','users:support','audio:replace']){
      expect(hasAdminPermission(['read-only'],p)).toBe(false);
      expect(hasAdminPermission(['superadmin'],p)).toBe(true);
    }
  });
});
