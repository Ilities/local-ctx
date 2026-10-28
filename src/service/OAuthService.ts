import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import express from 'express';
import { OAuthConfig } from '../router';

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
}

/**
 * OAuthService validates bearer tokens and produces the OAuth metadata documents
 * required by the MCP authorization specification (revision 2025-06-18).
 *
 * Each exposed MCP endpoint is treated as its own OAuth protected resource with a
 * distinct canonical resource identifier. Tokens are only accepted when the `aud`
 * (or `audience`) claim contains that identifier — a token minted by the same
 * authorization server for a different resource is rejected.
 */
export class OAuthService {
  private static readonly DEFAULT_JWKS_PATH = '/oauth2/jwks';

  private readonly oauthConfig: OAuthConfig | undefined;

  constructor(config?: OAuthConfig) {
    this.oauthConfig = config;
  }

  public isConfigured(): boolean {
    return !!this.oauthConfig;
  }

  // JWKS URL for the configured authorization server
  private getJwksUrl(): URL {
    const authServerUrl = this.oauthConfig?.authorizationServerUrl;
    const jwksPath = this.oauthConfig?.jwksPath ?? OAuthService.DEFAULT_JWKS_PATH;
    return new URL(`${authServerUrl}${jwksPath}`);
  }

  // Issuer that signs tokens (the authorization server)
  private getIssuerUrl(): string | undefined {
    return this.oauthConfig?.authorizationServerUrl;
  }

  // Base URL of this resource server as reachable by clients
  public getResourceServerUrl(): string {
    const url = this.oauthConfig?.resourceServerUrl ?? '';
    return url.replace(/\/+$/, '');
  }

  /**
   * The canonical resource identifier for the MCP endpoint exposed at `/<name>`.
   * RFC 8707 requires this to be the exact URL the client used, without a
   * trailing slash.
   */
  public getResourceIdentifier(name: string): string {
    return `${this.getResourceServerUrl()}/${name}`;
  }

  /**
   * URL where RFC 9728 protected resource metadata for the endpoint `/<name>`
   * is served. Per RFC 9728 §3.1 the resource path is appended after the
   * well-known suffix.
   */
  public getProtectedResourceMetadataUrl(name: string): string {
    return `${this.getResourceServerUrl()}/.well-known/oauth-protected-resource/${name}`;
  }

  private jwksCache: ReturnType<typeof createRemoteJWKSet> | undefined;
  private getJwks() {
    if (!this.jwksCache) {
      this.jwksCache = createRemoteJWKSet(this.getJwksUrl());
    }
    return this.jwksCache;
  }

  /**
   * Build the WWW-Authenticate header for a 401 response from the endpoint
   * `/<name>`. Clients follow `resource_metadata` to discover the authorization
   * server for this specific resource.
   */
  private getWwwAuthenticateHeader(name: string, errorDescription: string): string {
    return [
      'Bearer error="unauthorized"',
      `error_description="${errorDescription}"`,
      `resource_metadata="${this.getProtectedResourceMetadataUrl(name)}"`,
    ].join(', ');
  }

  /**
   * RFC 9728 protected resource metadata for the endpoint `/<name>`.
   */
  public getProtectedResourceMetadata(name: string): ProtectedResourceMetadata {
    return {
      resource: this.getResourceIdentifier(name),
      authorization_servers: [this.oauthConfig?.authorizationServerUrl ?? ''],
      bearer_methods_supported: ['header'],
    };
  }

  public async getAuthorizationServerMetadata() {
    const response = await fetch(
      `${this.oauthConfig?.authorizationServerUrl}/.well-known/oauth-authorization-server`
    );
    return await response.json();
  }

  /**
   * Returns true when the token's `aud`/`audience` claim includes the resource
   * identifier for `name`. Audience may be a string or an array per RFC 7519.
   */
  private audienceMatches(payload: JWTPayload, resourceIdentifier: string): boolean {
    const audRaw = payload['aud'] ?? (payload as Record<string, unknown>)['audience'];
    if (audRaw === undefined || audRaw === null) {
      return false;
    }
    const audiences = Array.isArray(audRaw) ? audRaw : [audRaw];
    return audiences.some(a => typeof a === 'string' && a === resourceIdentifier);
  }

  /**
   * Middleware that verifies a JWT bearer token and ensures it was issued for
   * the specified MCP resource (`name`). On failure a 401 is returned with a
   * `WWW-Authenticate` header pointing at the resource metadata for `name`.
   */
  public getJwtBearerTokenMiddleware(name: string) {
    return async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ): Promise<void> => {
      const respond401 = (description: string, bodyError: string) => {
        res
          .set('WWW-Authenticate', this.getWwwAuthenticateHeader(name, description))
          .status(401)
          .json({ error: bodyError });
      };

      const issuer = this.getIssuerUrl();
      if (!issuer) {
        respond401('Authorization server not configured', 'No issuer URL configured.');
        return;
      }

      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!token) {
        respond401('Authorization needed', 'No token provided.');
        return;
      }

      try {
        const jwks = this.getJwks();
        const resourceIdentifier = this.getResourceIdentifier(name);
        const { payload } = await jwtVerify(token, jwks, {
          issuer,
          audience: resourceIdentifier,
        });

        // Belt-and-braces check in case the authorization server used a
        // non-standard claim name. `jwtVerify` already rejects tokens whose
        // `aud` does not include `resourceIdentifier`, but we assert the match
        // explicitly so the error path is reached for any future divergence.
        if (!this.audienceMatches(payload, resourceIdentifier)) {
          respond401(
            'Token audience does not include this resource',
            'Token not issued for this resource.'
          );
          return;
        }

        // Use access token claims to populate request context.
        // i.e. `req.userId = payload.sub;`

        await next();
      } catch {
        respond401('Invalid bearer token', 'Invalid bearer token.');
      }
    };
  }
}
