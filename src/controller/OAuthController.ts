import { Request, Response } from 'express';
import { OAuthService } from '../service/OAuthService.js';

export class OAuthController {
  constructor(private readonly oAuthService: OAuthService) {}

  /**
   * Handler for GET /.well-known/oauth-protected-resource/:endpointName
   *
   * Returns RFC 9728 protected resource metadata for the specific MCP
   * endpoint identified by the route parameter.
   */
  public getProtectedResourceHandler() {
    return (req: Request, res: Response) => {
      const endpointName = req.params['endpointName'];
      if (!endpointName) {
        res.status(404).json({ error: 'Unknown resource' });
        return;
      }
      const metadata = this.oAuthService.getProtectedResourceMetadata(endpointName);
      res.json(metadata);
    };
  }

  public getAuthorizationServerHandler() {
    return async (_req: Request, res: Response) => {
      try {
        const metadata = await this.oAuthService.getAuthorizationServerMetadata();
        res.json(metadata);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch authorization server metadata' });
      }
    };
  }
}
