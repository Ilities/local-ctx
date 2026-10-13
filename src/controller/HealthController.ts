import { Request, Response } from 'express';
import { LocalServerRegistry } from '../service/LocalServerRegistry';

export class HealthController {
  constructor(private readonly localServerRegistry: LocalServerRegistry) {}

  public getHealthHandler() {
    return (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        servers: this.localServerRegistry.getServerNames(),
      });
    };
  }
}
