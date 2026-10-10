import { randomUUID } from 'node:crypto';
import {
  ArgumentsHost, CanActivate, Catch, ExceptionFilter, ExecutionContext,
  ForbiddenException, HttpException, HttpStatus, Injectable, NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';

interface FolioRequest {
  requestId?: string;
  originalUrl?: string;
  url?: string;
  auth?: { userId: string };
  params?: { userId?: string };
}
interface FolioResponse {
  setHeader(name: string, value: string): void;
  status(code: number): { json(value: unknown): void };
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: FolioRequest, res: FolioResponse, next: () => void): void {
    const requestId = randomUUID();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<FolioRequest>();
    const response = ctx.getResponse<FolioResponse>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = exception instanceof HttpException ? exception.message : 'Unexpected server error';
    const codes: Record<number, string> = {
      400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 429: 'RATE_LIMITED', 503: 'SERVICE_UNAVAILABLE',
    };
    if (status === HttpStatus.TOO_MANY_REQUESTS) response.setHeader('Retry-After', '900');
    const path=(request.originalUrl ?? request.url ?? '').split('?')[0] ?? '';
    if (path.startsWith('/v1/me/') || path.startsWith('/v1/auth/web/')) {
      response.setHeader('Cache-Control', 'private, no-store');
    }else if(path==='/v1/health'||path==='/v1/ready'||
             path==='/v1/system/capabilities'){
      // A 400/503 from these public probes must not be cached either.
      // Private account/auth errors retain their stricter private policy.
      response.setHeader('Cache-Control', 'no-store');
    }
    response.status(status).json({error: {
      code: codes[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : `HTTP_${status}`),
      message,
      requestId: request.requestId ?? randomUUID(),
    }});
  }
}

/** Auth must provide a trusted principal. Never trust client-provided user IDs. */
@Injectable()
export class UserOwnershipGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FolioRequest>();
    if (!request.auth?.userId) throw new UnauthorizedException('Authentication required');
    if (request.auth.userId !== request.params?.userId) throw new ForbiddenException('Resource is not owned by user');
    return true;
  }
}
