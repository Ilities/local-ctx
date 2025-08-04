import { Request, Response } from 'express';
import { McpService } from '../service/McpService.js';
import { Logger } from 'pino';

export class McpController {
  constructor(
    private readonly mcpService: McpService,
    private readonly logger: Logger
  ) {}

  public async handleMCPRequest(req: Request, res: Response): Promise<void> {
    try {
      await this.mcpService.processRequest(req, res, req.body);
    } catch (error) {
      this.logger.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  }

  public async handleUnsupportedMethod(req: Request, res: Response): Promise<void> {
    this.logger.info(`Received ${req.method} MCP request`);
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
        id: null,
      })
    );
  }
}
