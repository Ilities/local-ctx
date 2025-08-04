import { Request, Response } from 'express';
import { OAuthService } from '../service/OAuthService.js';

export class OAuthController {
  constructor(private readonly oAuthService: OAuthService) {}

  public getProtectedResourceHandler() {
    return (_req: Request, res: Response) => {
      const metadata = this.oAuthService.getProtectedResourceMetadata();
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
