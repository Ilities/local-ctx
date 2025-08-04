import { Logger } from 'pino';
import { DefaultMcpService } from './McpService';
import { McpController } from '../controller/McpController';
import { CommandConfig } from '../router';
import { createRootLogger } from '../util';

export class LocalServerRegistry {
  private readonly logger: Logger;
  private readonly children: Map<string, McpController> = new Map();

  constructor() {
    this.logger = createRootLogger();
  }

  public registerLocalMcp(command: CommandConfig): void {
    const commandName = command.name;
    const mcpService = new DefaultMcpService(
      command.command,
      this.logger.child({ name: `McpService.${commandName}` })
    );
    const mcpController = new McpController(
      mcpService,
      this.logger.child({ name: `McpController.${commandName}` })
    );
    this.children.set(commandName, mcpController);
  }

  public getLocalServers(): Map<string, McpController> {
    return this.children;
  }
}
