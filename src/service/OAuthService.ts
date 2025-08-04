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

  // Get the WWW-Authenticate header with the current configuration
  private getWwwAuthenticateHeader(): string {
    return [
      'Bearer error="unauthorized"',
      'error_description="Authorization needed"',
      `resource_metadata="${this.getResourceServerUrl()}/.well-known/oauth-protected-resource"`,
    ].join(', ');
  }

  public getProtectedResourceMetadata() {
    return {
      resource: `${this.oauthConfig?.resourceServerUrl}/`,
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
   * Middleware that verifies JWT tokens from the authorization header
   */
  public getJwtBearerTokenMiddleware() {
    return async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ): Promise<void> => {
      console.log(req.headers.authorization);

      const jwks = this.getJwks();
      if (!jwks) {
        res
          .set('WWW-Authenticate', this.getWwwAuthenticateHeader())
          .status(401)
          .json({ error: 'No JWKS endpoint configured.' });
        return;
      }

      const issuer = this.getIssuerUrl();
      if (!issuer) {
        res
          .set('WWW-Authenticate', this.getWwwAuthenticateHeader())
          .status(401)
          .json({ error: 'No issuer URL configured.' });
        return;
      }
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!token) {
        res
          .set('WWW-Authenticate', this.getWwwAuthenticateHeader())
          .status(401)
          .json({ error: 'No token provided.' });
        return;
      }

      try {
        const { payload: _payload } = await jwtVerify(token, jwks, { issuer });

        // Use access token claims to populate request context.
        // i.e. `req.userId = payload.sub;`

        await next();
      } catch (err) {
        res
          .set('WWW-Authenticate', this.getWwwAuthenticateHeader())
          .status(401)
          .json({ error: 'Invalid bearer token.' });
      }
    };
  }
}
