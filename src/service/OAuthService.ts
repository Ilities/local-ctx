import { createRemoteJWKSet, jwtVerify } from 'jose';
import express from 'express';
import type { OAuthConfig } from '../router';

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

  public getResourceUrlForEndpoint(endpointPath: string): string {
    const resourceServerUrl = this.getResourceServerUrl();
    return resourceServerUrl ? new URL(endpointPath, resourceServerUrl).toString() : endpointPath;
  }

  // Create JWKS with the current configuration
  private getJwks() {
    return createRemoteJWKSet(this.getJwksUrl());
  }

  // Get the WWW-Authenticate header with the current configuration
  private getWwwAuthenticateHeader(resourceUrl: string): string {
    const resourceMetadataUrl = `${resourceUrl.replace(/\/$/, '')}/.well-known/oauth-protected-resource`;
    return [
      'Bearer error="unauthorized"',
      'error_description="Authorization needed"',
      `resource_metadata="${resourceMetadataUrl}"`,
    ].join(', ');
  }

  public getProtectedResourceMetadata(resourceUrl?: string) {
    return {
      resource: resourceUrl ?? this.getResourceServerUrl(),
      authorization_servers: [this.oauthConfig?.authorizationServerUrl],
      bearer_methods_supported: ['header'],
    };
  }

  public async getAuthorizationServerMetadata() {
    const response = await fetch(
      `${this.oauthConfig?.authorizationServerUrl}/.well-known/oauth-authorization-server`
    );
    if (!response.ok) {
      throw new Error(`Authorization server metadata request failed: ${response.status}`);
    }
    return await response.json();
  }
  /**
   * Middleware that verifies JWT tokens from the authorization header
   */
  public getJwtBearerTokenMiddleware(resourceUrl?: string) {
    return async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ): Promise<void> => {
      const configuredResourceUrl = resourceUrl ?? this.getResourceServerUrl();
      if (!configuredResourceUrl) {
        res.status(401).json({ error: 'No resource URL configured.' });
        return;
      }
      const challengeResourceUrl = resourceUrl ?? this.getResourceUrlForEndpoint('/');
      const wwwAuthenticateHeader = this.getWwwAuthenticateHeader(challengeResourceUrl);

      const jwks = this.getJwks();
      if (!jwks) {
        res
          .set('WWW-Authenticate', wwwAuthenticateHeader)
          .status(401)
          .json({ error: 'No JWKS endpoint configured.' });
        return;
      }

      const issuer = this.getIssuerUrl();
      if (!issuer) {
        res
          .set('WWW-Authenticate', wwwAuthenticateHeader)
          .status(401)
          .json({ error: 'No issuer URL configured.' });
        return;
      }
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!token) {
        res
          .set('WWW-Authenticate', wwwAuthenticateHeader)
          .status(401)
          .json({ error: 'No token provided.' });
        return;
      }

      try {
        await jwtVerify(token, jwks, {
          issuer,
          audience: this.oauthConfig?.audience ?? configuredResourceUrl,
        });

        // Use access token claims to populate request context.
        // i.e. `req.userId = payload.sub;`

        await next();
      } catch {
        res
          .set('WWW-Authenticate', wwwAuthenticateHeader)
          .status(401)
          .json({ error: 'Invalid bearer token.' });
      }
    };
  }
}
