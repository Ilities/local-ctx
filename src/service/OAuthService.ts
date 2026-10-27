import { createRemoteJWKSet, jwtVerify } from 'jose';
import express from 'express';
import type { OAuthConfig } from '../router';

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

  // Method to get the resource server base URL without a trailing slash
  private getResourceServerUrl(): string | undefined {
    return this.oauthConfig?.resourceServerUrl?.replace(/\/+$/, '');
  }

  /**
   * Build the resource identifier (and expected token audience) for an endpoint.
   * Each MCP endpoint is its own protected resource.
   */
  public getResourceUrlForEndpoint(endpointPath: string): string {
    const resourceServerUrl = this.getResourceServerUrl();
    const path = endpointPath.replace(/^\/+|\/+$/g, '');

    if (!resourceServerUrl) {
      return path ? `/${path}` : '/';
    }

    return path ? `${resourceServerUrl}/${path}` : resourceServerUrl;
  }

  // Create JWKS with the current configuration
  private getJwks() {
    return createRemoteJWKSet(this.getJwksUrl());
  }

  /**
   * RFC 9728 metadata URL for a resource. For a resource at
   * https://example.com/memory this is
   * https://example.com/.well-known/oauth-protected-resource/memory.
   */
  public getProtectedResourceMetadataUrl(resourceUrl: string): string {
    try {
      const url = new URL(resourceUrl);
      const path = url.pathname.replace(/\/+$/, '');
      const metadataPath = `${OAuthService.PROTECTED_RESOURCE_METADATA_PATH}${path === '/' ? '' : path}`;
      return `${url.origin}${metadataPath}`;
    } catch {
      return OAuthService.PROTECTED_RESOURCE_METADATA_PATH;
    }
  }

  // Get the WWW-Authenticate header with the current configuration
  private getWwwAuthenticateHeader(resourceUrl: string, error?: 'invalid_token'): string {
    const parameters = ['Bearer'];

    if (error) {
      parameters.push(
        `error="${error}"`,
        'error_description="The access token is invalid or expired"'
      );
    }

    parameters.push(`resource_metadata="${this.getProtectedResourceMetadataUrl(resourceUrl)}"`);

    return parameters.join(', ');
  }

  public getProtectedResourceMetadata(resourceUrl?: string) {
    return {
      resource: resourceUrl ?? this.getResourceServerUrl() ?? '',
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
   * Middleware that verifies JWT tokens from the authorization header.
   * Tokens must be issued for the given resource (the endpoint URL) to prevent
   * tokens issued for another resource from being replayed here.
   */
  public getJwtBearerTokenMiddleware(resourceUrl?: string) {
    return async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ): Promise<void> => {
      const configuredResourceUrl = resourceUrl ?? this.getResourceServerUrl();

      if (!this.oauthConfig || !configuredResourceUrl) {
        res.status(401).json({ error: 'No resource server configured.' });
        return;
      }

      const wwwAuthenticateHeader = this.getWwwAuthenticateHeader(configuredResourceUrl);

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
        await jwtVerify(token, this.getJwks(), {
          issuer,
          audience: this.oauthConfig.audience ?? configuredResourceUrl,
        });

        // Use access token claims to populate request context.
        // i.e. `req.userId = payload.sub;`

        await next();
      } catch {
        res
          .set(
            'WWW-Authenticate',
            this.getWwwAuthenticateHeader(configuredResourceUrl, 'invalid_token')
          )
          .status(401)
          .json({ error: 'Invalid bearer token.' });
      }
    };
  }
}
