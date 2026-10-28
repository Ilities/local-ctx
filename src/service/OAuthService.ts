import { createRemoteJWKSet, jwtVerify } from 'jose';
import express from 'express';
import { OAuthConfig } from '../router';

export class OAuthService {
  private static readonly DEFAULT_JWKS_PATH = '/oauth2/jwks';

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

  // Method to get the resource server URL
  private getResourceServerUrl(): string | undefined {
    return this.oauthConfig?.resourceServerUrl;
  }

  // Create JWKS with the current configuration
  private getJwks() {
    return createRemoteJWKSet(this.getJwksUrl());
  }

  /**
   * Build the resource identifier for a specific endpoint.
   * Per RFC 9728, the resource identifier is the canonical URL of the
   * protected resource. For this server each MCP endpoint is a separate
   * resource, so the identifier includes the path (e.g.
   * "http://localhost:8000/memory").
   */
  public getResourceIdentifier(endpointName: string): string {
    return `${this.getResourceServerUrl()}/${endpointName}`;
  }

  /**
   * Build the URL to the protected resource metadata document for a
   * specific endpoint. Per RFC 9728 Section 3.1, when the resource
   * identifier contains a path component, the well-known URI is formed by
   * inserting /.well-known/oauth-protected-resource between the host and
   * the path.
   */
  public getResourceMetadataUrl(endpointName: string): string {
    return `${this.getResourceServerUrl()}/.well-known/oauth-protected-resource/${endpointName}`;
  }

  // Get the WWW-Authenticate header for a specific endpoint
  private getWwwAuthenticateHeader(endpointName: string): string {
    return [
      'Bearer error="unauthorized"',
      'error_description="Authorization needed"',
      `resource_metadata="${this.getResourceMetadataUrl(endpointName)}"`,
    ].join(', ');
  }

  /**
   * Return RFC 9728 protected resource metadata for a specific endpoint.
   */
  public getProtectedResourceMetadata(endpointName: string) {
    return {
      resource: this.getResourceIdentifier(endpointName),
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
   * Validates:
   * - The token was issued by the configured authorization server (iss).
   * - The token audience includes this specific resource endpoint (aud),
   *   as required by RFC 8707 / MCP authorization spec 2025-06-18.
   */
  public getJwtBearerTokenMiddleware(endpointName: string) {
    return async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ): Promise<void> => {
      const jwks = this.getJwks();
      if (!jwks) {
        res
          .set('WWW-Authenticate', this.getWwwAuthenticateHeader(endpointName))
          .status(401)
          .json({ error: 'No JWKS endpoint configured.' });
        return;
      }

      const issuer = this.getIssuerUrl();
      if (!issuer) {
        res
          .set('WWW-Authenticate', this.getWwwAuthenticateHeader(endpointName))
          .status(401)
          .json({ error: 'No issuer URL configured.' });
        return;
      }
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!token) {
        res
          .set('WWW-Authenticate', this.getWwwAuthenticateHeader(endpointName))
          .status(401)
          .json({ error: 'No token provided.' });
        return;
      }

      try {
        const resourceId = this.getResourceIdentifier(endpointName);

        const { payload: _payload } = await jwtVerify(token, jwks, {
          issuer,
          audience: resourceId,
        });

        // Use access token claims to populate request context.
        // i.e. `req.userId = payload.sub;`

        await next();
      } catch (err) {
        res
          .set('WWW-Authenticate', this.getWwwAuthenticateHeader(endpointName))
          .status(401)
          .json({ error: 'Invalid bearer token.' });
      }
    };
  }
}
