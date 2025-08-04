/**
 *
 * This is a derivative work of the Supergateway project.
 *
 *
 * MIT License
 *
 * Copyright (c) 2024 Supercorp
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 */

import { Request, Response } from 'express';
import { ChildProcess, spawn } from 'child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from 'pino';

export interface McpService {
  processRequest(req: Request, res: Response, body: any): Promise<void>;
}

export class DefaultMcpService implements McpService {
  private readonly VERSION = '1.0.0';

  constructor(
    private stdioCmd: string,
    private logger: Logger
  ) {}

  public async processRequest(req: Request, res: Response, body: any): Promise<void> {
    const server = new Server(
      { name: 'local-context', version: this.VERSION },
      { capabilities: {} }
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    const child = this.spawnChildProcess(transport);

    this.setupChildProcessHandlers(child, transport);
    this.setupTransportHandlers(transport, child);

    await transport.handleRequest(req, res, body);
  }

  private spawnChildProcess(transport: StreamableHTTPServerTransport): ChildProcess {
    const child = spawn(this.stdioCmd, { shell: true });

    child.on('exit', (code, signal) => {
      this.logger.error(`Child exited: code=${code}, signal=${signal}`);
      transport.close();
    });

    return child;
  }

  private setupChildProcessHandlers(
    child: ChildProcess,
    transport: StreamableHTTPServerTransport
  ): void {
    let buffer = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      lines.forEach(line => {
        if (!line.trim()) return;
        try {
          const jsonMsg = JSON.parse(line);
          this.logger.info('Child → StreamableHttp:', line);
          try {
            transport.send(jsonMsg);
          } catch (e) {
            this.logger.error(`Failed to send to StreamableHttp`, e);
          }
        } catch {
          this.logger.error(`Child non-JSON: ${line}`);
        }
      });
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.logger.error(`Child stderr: ${chunk.toString('utf8')}`);
    });
  }

  private setupTransportHandlers(
    transport: StreamableHTTPServerTransport,
    child: ChildProcess
  ): void {
    transport.onmessage = (msg: JSONRPCMessage) => {
      this.logger.info(`StreamableHttp → Child: ${JSON.stringify(msg)}`);
      child.stdin?.write(JSON.stringify(msg) + '\n');
    };

    transport.onclose = () => {
      this.logger.info('StreamableHttp connection closed');
      child.kill();
    };

    transport.onerror = err => {
      this.logger.error(`StreamableHttp error:`, err);
      child.kill();
    };
  }
}
