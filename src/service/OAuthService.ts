import { createRemoteJWKSet, JWTVerifyGetKey, jwtVerify } from 'jose';
import express from 'express';
import { OAuthConfig } from '../router';

export class OAuthService {
  private static readonly DEFAULT_JWKS_PATH = '/oauth2/jwks';
  private static readonly PROTECTED_RESOURCE_METADATA_PATH =
    '/.well-known/oauth-protected-resource';

  private oauthConfig: OAuthConfig | undefined;

  constructor(config?: OAuthConfig) {
    this.oauthConfig = config;
  }

  // Method to get the JWKS URL
  private getJwksUrl(): URL {
    const authServerUrl = this.oauthConfig?.authorizationServerUrl;
    const jwksPath = this.oauthConfig?.jwksPath ?? OAuthService.DEFAULT_JWKS_PATH;
    return new URL(`${authServerUrl}${jwksPath}`);
  }

  // Method to get the issuer URL
  private getIssuerUrl(): string | undefined {
    return this.oauthConfig?.authorizationServerUrl;
  }

  // Canonical base URL of this resource server (no trailing slash).
  private getResourceBaseUrl(): string {
    return (this.oauthConfig?.resourceServerUrl ?? '').replace(/\/+$/, '');
  }

  // Normalise an endpoint path to a leading-slash, no-trailing-slash form ('' for root).
  private static normalizePath(endpointPath: string): string {
    const trimmed = endpointPath.replace(/^\/+|\/+$/g, '');
    return trimmed ? `/${trimmed}` : '';
  }

  private static joinUrl(...parts: string[]): string {
    return parts
      .map((part, index) =>
        index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, '')
      )
      .filter((part, index) => index === 0 || part.length > 0)
      .join('/');
  }

  // The canonical resource identifier for a given MCP endpoint (e.g. `http://host/memory`).
  public getResourceUrl(endpointPath: string): string {
    return OAuthService.joinUrl(
      this.getResourceBaseUrl(),
      OAuthService.normalizePath(endpointPath)
    );
  }

  // RFC 9728 path-specific metadata URL for a given MCP endpoint.
  public getProtectedResourceMetadataUrl(endpointPath: string): string {
    return OAuthService.joinUrl(
      this.getResourceBaseUrl(),
      OAuthService.PROTECTED_RESOURCE_METADATA_PATH,
      OAuthService.normalizePath(endpointPath)
    );
  }

  // Create JWKS with the current configuration
  private getJwks(): JWTVerifyGetKey {
    return createRemoteJWKSet(this.getJwksUrl());
  }

  // Get the WWW-Authenticate header for a given MCP endpoint (RFC 6750 + RFC 9728).
  private getWwwAuthenticateHeader(endpointPath: string): string {
    return [
      'Bearer error="invalid_token"',
      'error_description="Authorization needed"',
      `resource_metadata="${this.getProtectedResourceMetadataUrl(endpointPath)}"`,
    ].join(', ');
  }

  public getProtectedResourceMetadata(endpointPath: string) {
    return {
      resource: this.getResourceUrl(endpointPath),
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
   * Middleware that verifies JWT tokens from the authorization header.
   *
   * Per the MCP authorization spec (2025-06-18) the access token must have been
   * issued for *this* resource server, so the `aud` claim is validated against the
   * canonical resource identifier of the endpoint being accessed.
   */
  public getJwtBearerTokenMiddleware(endpointPath: string) {
    return async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ): Promise<void> => {
      const unauthorized = (error: string) => {
        res
          .set('WWW-Authenticate', this.getWwwAuthenticateHeader(endpointPath))
          .status(401)
          .json({ error });
      };

      const jwks = this.getJwks();
      if (!jwks) {
        unauthorized('No JWKS endpoint configured.');
        return;
      }

      const issuer = this.getIssuerUrl();
      if (!issuer) {
        unauthorized('No issuer URL configured.');
        return;
      }

      const audience = this.getResourceUrl(endpointPath);
      if (!audience) {
        unauthorized('No resource server URL configured.');
        return;
      }

      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!token) {
        unauthorized('No token provided.');
        return;
      }

      try {
        const { payload: _payload } = await jwtVerify(token, jwks, { issuer, audience });

        // Use access token claims to populate request context.
        // i.e. `req.userId = payload.sub;`

        await next();
      } catch (_err) {
        unauthorized('Invalid bearer token.');
      }
    };
  }
}
