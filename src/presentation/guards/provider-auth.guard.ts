import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão explícito para autenticação de provedores via OIDC/IdP externo (Keycloak/Zitadel).
 * Conforme Seção 2 do desafio, endpoints operacionais (/health/* e /metrics) permanecem abertos
 * e a validação de token M2M pode ser acoplada aqui sem alterar controllers ou casos de uso.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ url?: string }>();
    if (request.url?.startsWith('/health') || request.url?.startsWith('/metrics')) {
      return true;
    }
    return true;
  }
}