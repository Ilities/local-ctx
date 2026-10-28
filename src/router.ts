import express from 'express';
import { createRootLogger, passThroughMiddleware } from './util';
import { Logger } from 'pino';
import { LocalServerRegistry } from './service/LocalServerRegistry';
import { OAuthController } from './controller/OAuthController';
import { OAuthService } from './service/OAuthService';

export interface CommandConfig {
  name: string;
  command: string;
}

export interface OAuthConfig {
  authorizationServerUrl: string;
  /**
   * Public base URL at which this process is reachable by MCP clients. Used as
   * the base of every resource identifier and in the `WWW-Authenticate` and PRM
   * documents. Defaults to `http://localhost:<port>` when not provided.
   */
  resourceServerUrl: string;
  jwksPath?: string;
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

  public getApp(): express.Application {
    return this.app;
  }

  private configureMiddleware(): void {
    this.app.use((_req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization'
      );
      res.header('Access-Control-Expose-Headers', 'WWW-Authenticate');
      next();
    });

    this.app.use(express.json());
  }

  private configureRoutes(): void {
    if (this.oAuthController) {
      // OAuth authorization server metadata (proxied from the configured AS)
      this.app
        .route('/.well-known/oauth-authorization-server')
        .get(this.oAuthController.getAuthorizationServerHandler())
        .options(this.oAuthController.getAuthorizationServerHandler());

      // Per-resource RFC 9728 protected resource metadata documents. Each
      // exposed endpoint `/<name>` has its own metadata document at
      // `/.well-known/oauth-protected-resource/<name>`.
      for (const [name] of this.localServerRegistry.getLocalServers()) {
        const prmHandler = this.oAuthController.getProtectedResourceHandler(name);
        this.app
          .route(`/.well-known/oauth-protected-resource/${name}`)
          .get(prmHandler)
          .options(prmHandler);
      }

      // Backwards-compatible top-level PRM: default to the first registered
      // resource so existing clients that fetch the bare well-known document
      // keep working. Clients that follow the WWW-Authenticate
      // `resource_metadata` link get the correct per-resource document.
      const firstName = this.localServerRegistry.getLocalServers().keys().next().value;
      if (firstName) {
        const firstHandler = this.oAuthController.getProtectedResourceHandler(firstName);
        this.app
          .route('/.well-known/oauth-protected-resource')
          .get(firstHandler)
          .options(firstHandler);
      }
    } else {
      this.logger.warn(
        'OAuth is not configured. Exposed endpoints will be insecure. Please configure OAuth to enable OAuth support.'
      );
    }

    for (const [name, controller] of this.localServerRegistry.getLocalServers()) {
      // POST endpoint for MCP requests
      this.app
        .post(
          `/${name}`,
          this.oAuthController
            ? this.oAuthService.getJwtBearerTokenMiddleware(name)
            : passThroughMiddleware,
          (req, res) => controller.handleMCPRequest(req, res)
        )
        .get(`/${name}`, (req, res) => controller.handleUnsupportedMethod(req, res))
        .delete(`/${name}`, (req, res) => controller.handleUnsupportedMethod(req, res));
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
