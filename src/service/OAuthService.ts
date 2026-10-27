import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey } from 'jose';
import express from 'express';
import { OAuthConfig } from '../router';

export class OAuthService {
  private static readonly DEFAULT_JWKS_PATH = '/oauth2/jwks';
  private static readonly PROTECTED_RESOURCE_METADATA_PREFIX =
    '/.well-known/oauth-protected-resource';

  private readonly oauthConfig: OAuthConfig | undefined;
  private readonly jwks: JWTVerifyGetKey | undefined;

  constructor(config?: OAuthConfig) {
    this.oauthConfig = config;
    this.jwks = config ? createRemoteJWKSet(this.getJwksUrl(config)) : undefined;
  }

  private getJwksUrl(config: OAuthConfig): URL {
    const jwksPath = config.jwksPath ?? OAuthService.DEFAULT_JWKS_PATH;
    return new URL(`${config.authorizationServerUrl}${jwksPath}`);
  }

  // Resource server base URL without a trailing slash, e.g. http://localhost:8000
  private getResourceServerBaseUrl(): string {
    return (this.oauthConfig?.resourceServerUrl ?? '').replace(/\/+$/, '');
  }

  /**
   * The RFC 8707 / MCP resource identifier of an exposed MCP endpoint, e.g. http://localhost:8000/memory.
   * Access tokens must carry this value in `aud` to be accepted by that endpoint.
   */
  public getResourceIdentifier(endpoint: string): string {
    return `${this.getResourceServerBaseUrl()}/${endpoint}`;
  }

  /** Absolute URL of the RFC 9728 protected resource metadata document for an endpoint. */
  public getProtectedResourceMetadataUrl(endpoint: string): string {
    return `${this.getResourceServerBaseUrl()}${OAuthService.PROTECTED_RESOURCE_METADATA_PREFIX}/${endpoint}`;
  }

  /** Builds the WWW-Authenticate challenge for a 401 response on an endpoint. */
  private buildChallenge(endpoint: string, error?: string, description?: string): string {
    const params: string[] = [];
    if (error) params.push(`error="${error}"`);
    if (description) params.push(`error_description="${description}"`);
    params.push(`resource_metadata="${this.getProtectedResourceMetadataUrl(endpoint)}"`);
    return `Bearer ${params.join(', ')}`;
  }

  /**
   * RFC 9728 metadata. With an endpoint, describes that MCP endpoint as the protected resource.
   * Without one, serves the legacy root document that describes the server origin.
   */
  public getProtectedResourceMetadata(endpoint?: string) {
    return {
      resource:
        endpoint === undefined
          ? `${this.getResourceServerBaseUrl()}/`
          : this.getResourceIdentifier(endpoint),
      authorization_servers: [this.oauthConfig?.authorizationServerUrl],
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
   * Middleware that protects an MCP endpoint. Only accepts JWT access tokens that are signed by
   * the configured authorization server, issued by it, and whose audience is this endpoint.
   */
  public getJwtBearerTokenMiddleware(endpoint: string) {
    if (!this.oauthConfig || !this.jwks) {
      throw new Error('OAuth is not configured');
    }
    const issuer = this.oauthConfig.authorizationServerUrl;
    const audience = this.getResourceIdentifier(endpoint);
    const jwks = this.jwks;

    return async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ): Promise<void> => {
      const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (!token) {
        res
          .set('WWW-Authenticate', this.buildChallenge(endpoint))
          .status(401)
          .json({ error: 'No token provided.' });
        return;
      }

      try {
        await jwtVerify(token, jwks, { issuer, audience });
      } catch {
        res
          .set(
            'WWW-Authenticate',
            this.buildChallenge(
              endpoint,
              'invalid_token',
              'The access token is invalid or was not issued for this resource'
            )
          )
          .status(401)
          .json({ error: 'Invalid bearer token.' });
        return;
      }

      next();
    };
  }
}
