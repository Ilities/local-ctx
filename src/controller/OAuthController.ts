import { Request, Response } from 'express';
import { OAuthService } from '../service/OAuthService.js';

export class OAuthController {
  constructor(private readonly oAuthService: OAuthService) {}

  /**
   * RFC 9728 protected resource metadata handler for the MCP endpoint `/<name>`.
   * The URL path for this is `/.well-known/oauth-protected-resource/<name>`.
   */
  public getProtectedResourceHandler(name: string) {
    return (_req: Request, res: Response) => {
      const metadata = this.oAuthService.getProtectedResourceMetadata(name);
      res.json(metadata);
    };
  }

  public getAuthorizationServerHandler() {
    return async (_req: Request, res: Response) => {
      try {
        const metadata = await this.oAuthService.getAuthorizationServerMetadata();
        res.json(metadata);
      } catch {
        res.status(500).json({ error: 'Failed to fetch authorization server metadata' });
      }
    };
  }
}
