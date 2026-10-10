import {
  CanActivate,ExecutionContext,ForbiddenException,Injectable,
  SetMetadata,UnauthorizedException,
} from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {hasAdminPermission} from '@folio/contracts';
import type {AdminPermission} from '@folio/contracts';

const ADMIN_PERMISSION_METADATA='folio:admin:permission';
export const RequireAdminPermission=(permission:AdminPermission)=>
  SetMetadata(ADMIN_PERMISSION_METADATA,permission);

interface TrustedAdminRequest {
  auth?:{userId:string;adminRoles?:readonly string[]};
}

/**
 * Only trusted session middleware may attach auth. Headers, query and request
 * bodies MUST NOT be interpreted as role evidence. This guard is not bound to
 * live routes while self-hosted verified sessions (#30) remain unavailable.
 */
@Injectable()
export class AdminPermissionGuard implements CanActivate {
  private readonly reflector=new Reflector();
  canActivate(context:ExecutionContext):boolean{
    const permission=this.reflector.getAllAndOverride<AdminPermission>(
      ADMIN_PERMISSION_METADATA,[context.getHandler(),context.getClass()],
    );
    if(!permission)throw new ForbiddenException('Admin permission declaration missing');
    const req=context.switchToHttp().getRequest<TrustedAdminRequest>();
    if(!req.auth?.userId)throw new UnauthorizedException('Authentication required');
    if(!hasAdminPermission(req.auth.adminRoles??[],permission)){
      throw new ForbiddenException('Insufficient administrator permission');
    }
    return true;
  }
}
