import express from 'express';
import { createRootLogger, passThroughMiddleware } from './util';
import { Logger } from 'pino';
import { LocalServerRegistry } from './service/LocalServerRegistry';
import { OAuthController } from './controller/OAuthController';
import { OAuthService } from './service/OAuthService';

export interface CommandConfig {
  name: string;
  command: string;
  path: string;
}

export interface OAuthConfig {
  authorizationServerUrl: string;
  resourceServerUrl: string;
  jwksPath?: string;
  audience?: string;
}

export interface LocalServerConfig {
  commands: CommandConfig[];
  port: number;
  oauth: OAuthConfig | undefined;
}

export class LocalContextServer {
  private app: express.Application;
  private readonly logger: Logger;
  private readonly localServerRegistry: LocalServerRegistry;
  private readonly oAuthController?: OAuthController;

  constructor(
    private config: LocalServerConfig,
    private readonly oAuthService: OAuthService
  ) {
    this.app = express();
    this.logger = createRootLogger();

    this.localServerRegistry = new LocalServerRegistry();

    for (const command of this.config.commands) {
      this.localServerRegistry.registerLocalMcp(command);
    }

    // Set OAuth configuration for middleware
    if (this.config.oauth) {
      this.oAuthController = new OAuthController(this.oAuthService);
    }

    this.configureMiddleware();
    this.configureRoutes();
  }

  private configureMiddleware(): void {
    this.app.use((_req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      next();
    });

    this.app.use(express.json());
  }

  private configureRoutes(): void {
    if (this.oAuthController) {
      // OAuth endpoints
      this.app
        .route('/.well-known/oauth-protected-resource')
        .get(this.oAuthController.getProtectedResourceHandler())
        .options(this.oAuthController.getProtectedResourceHandler());
      this.app
        .route('/.well-known/oauth-authorization-server')
        .get(this.oAuthController.getAuthorizationServerHandler())
        .options(this.oAuthController.getAuthorizationServerHandler());
    } else {
      this.logger.warn(
        'OAuth is not configured. Exposed endpoints will be insecure. Please configure OAuth to enable OAuth support.'
      );
    }

    for (const [name, controller] of this.localServerRegistry.getLocalServers()) {
      const endpointPath = `/${name}`;
      const resourceUrl = this.oAuthService.getResourceUrlForEndpoint(endpointPath);

      if (this.oAuthController) {
        const metadataHandler = this.oAuthController.getProtectedResourceHandler(resourceUrl);

        // RFC 9728: /.well-known/oauth-protected-resource/<resource path>
        this.app
          .route(`/.well-known/oauth-protected-resource${endpointPath}`)
          .get(metadataHandler)
          .options(metadataHandler);

        // Also accept the metadata path after the endpoint for clients that use it.
        this.app
          .route(`${endpointPath}/.well-known/oauth-protected-resource`)
          .get(metadataHandler)
          .options(metadataHandler);
      }

      // POST endpoint for MCP requests
      this.app
        .post(
          endpointPath,
          this.oAuthController
            ? this.oAuthService.getJwtBearerTokenMiddleware(resourceUrl)
            : passThroughMiddleware,
          (req, res) => controller.handleMCPRequest(req, res)
        )
        .get(endpointPath, (req, res) => controller.handleUnsupportedMethod(req, res))
        .delete(endpointPath, (req, res) => controller.handleUnsupportedMethod(req, res));
      this.logger.info(`Configured routes for command at path: ${name}`);
    }
  }

  public start(): void {
    this.app.listen(this.config.port, () => {
      this.logger.info(`Listening on port ${this.config.port}`);

      // Log all command endpoints
      for (const [name] of this.localServerRegistry.getLocalServers()) {
        this.logger.info(`StreamableHttp endpoint: http://localhost:${this.config.port}/${name}`);
      }
    });
  }
}
