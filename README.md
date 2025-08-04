
# Local Ctx

An MCP server helper allows users to expose standard STDIO servers as Streamable HTTP to external clients. Supports authentication via OAuth.

## Sponsor

This project is sponsored by [Ctxpack](https://ctxpack.com) - (em-dash) a context management platform for AI tools and workflows.

If you're managing multiple MCP servers or AI tools across your organization, Ctxpack helps you package and share configurations as reusable "context packs" that work with Claude, ChatGPT, and other AI platforms.

{rocket or some other random emoji} 

[Learn more →](https://ctxpack.com)

---

## Features

- Connects a child process using stdio to a Streamable HTTP endpoint
- Supports OAuth authentication via JWT tokens
- Multiple configuration methods (JSON files, CLI arguments, environment variables)

## Usage

Local Ctx supports running multiple local MCP servers simultaneously. They are all spun up as standard STDIO servers based on the commands provided. 

They are exposed as Streamable HTTP endpoints **which is generated based on the name given for the command in the configuration**.

For example command:
```json
{
  "name": "memento",
  "command": "npx -y @modelcontextprotocol/server-memory"
}
```

Will expose streamable HTTP `server-memory` MCP server on address `http://localhost:8000/memento`.


### Using npx (Recommended)

```bash
# Basic usage with command-line arguments
npx local-ctx --commands '[{"name":"memory","command":"npx -y @modelcontextprotocol/server-memory"}]' --port 8000

# Using a configuration file
npx local-ctx --config ./my-config.json

# Using environment variables with custom port
PORT=9000 COMMANDS='[{"name":"memory","command":"npx -y @modelcontextprotocol/server-memory"}]' npx local-ctx

# Using default config.json in current directory
# (Place a config.json in your current directory and run)
npx local-ctx
```

### Using node 

```bash
git clone https://github.com/Ilities/local-ctx.git

# Install locally
npm install

# Build the project
npm run build

# Basic usage with command-line arguments
node dist/index.js --commands '[{"name":"memory","command":"npx -y @modelcontextprotocol/server-memory"}]' --port 8000

# Using a configuration file
node dist/index.js --config ./my-config.json

# Using environment variables with custom port
PORT=9000 COMMANDS='[{"name":"memory","command":"npx -y @modelcontextprotocol/server-memory"}]' node dist/index.js

# Using default config.json next to index.js
# (Place a config.json in the dist directory and run)
node dist/index.js
```

## Configuration Methods

Configuration is loaded in the following order of precedence (highest to lowest):

1. Command-line arguments
2. Environment variables
3. JSON configuration file
4. Default values

### Command Line Options

- `--config, -c`: Path to JSON configuration file
- `--port, -p`: Port number for the server (default: 8000)
- `--commands`: JSON string of commands configuration
- `--authorizationServerUrl`: URL for the OAuth authorization server

### Environment Variables

- `PORT`: Port number for the server
- `COMMANDS`: JSON string array of command configurations

### Configuration File Format

Place a `config.json` file next to the built index.js or specify a custom path with the `--config` option:

```json
{
  "commands": [
    {
      "name": "memory",
      "command": "npx -y @modelcontextprotocol/server-memory"
    }
  ],
  "port": 8000,
  "oauth": {
    "authorizationServerUrl": "https://your-auth-server.example.com",
    "jwksPath": "/optional-jwks-path"
  }
}
```

### Command Configuration

Each command requires the following properties:

- `name`: Unique identifier for the command (used as the endpoint path)
- `command`: The shell command to execute to spin up an MCP server. The tools to run the command needs to be present on the system (npx, uv, python etc. depending on the server)
- `path`: This property is defined in the interface but not currently used in the implementation

### OAuth Configuration

OAuth can be configured to secure your endpoints with JWT bearer tokens:

- `authorizationServerUrl`: URL of the OAuth authorization server
- `jwksPath`: Optional path to the JWKS endpoint (defaults to standard path)

When OAuth is configured, the server will automatically:
- Expose OAuth discovery endpoints at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`
- Require valid JWT bearer tokens for all command endpoints


## Auth Setup

### WorkOS

WorkOS is one the IDPs that support OAuth 2.1 (though, like many of them, still not providing good enough CORS header support for all clients). The setup to secure your local MCP servers that are exposed externally is fairly straight forward. The steps are:
1. Sign up to WorkOS
2. Click on the 'Set Up AuthKit' button on the main page. <details><summary>See Image</summary>![workos-main-page.webp](docs/images/workos/workos-main-page.webp)</details>
3. Step through the wizard <details><summary>See Image</summary>![workos-authkit-setup.webp](docs/images/workos/workos-authkit-setup.webp)</details>
4. On Step 4, set `http://localhost:8000` (or your port config) as the callback URL <details><summary>See Image</summary>![workos-authkit-callback.webp](docs/images/workos/workos-authkit-callback.webp)</details>
5. Navigate to 'Applications' on the left menu. Click 'Create application' <details><summary>See Image</summary>![workos-create-app.webp](docs/images/workos/workos-create-app.webp)</details>
6. Select OAuth Application on the dialog
7. Add name and description to yout app. Enable PKCE. Click 'Create Application' <details><summary>See Image</summary>![workos-app-details.webp](docs/images/workos/workos-app-details.webp)</details>
8. Add `http://localhost:8000` as the redirect URL for the application <details><summary>See Image</summary>![workos-redir-url.webp](docs/images/workos/workos-redir-url.webp)</details>
9. Navigate back to Applications on the left menu, click 'Configuration' on the second level menu and **Enable** _Dynamic Client Registration_ <details><summary>See Image</summary>![workos-allow-dynamic-reg.webp](docs/images/workos/workos-allow-dynamic-reg.webp)</details>
10. Disable/Enable your wanted OAuth providers. You need to create OAuth client/secret pairs for each is you want to enable them.
    * The easiest way to get started is to disable everything and rely on WorkOS Username/Password auth. To do that, create a user in WorkOS
11.  Navigate to Authentication -> Features -> Copy the **AuthKit URL** <details><summary>See Image</summary>![workos-auth-url.webp](docs/images/workos/workos-auth-url.webp)</details>
12. Add the copied URL to you `config.json` as the `oauth.authorizationServerUrl`. Start with `https://...`


## Exposing externally

You can expose the created MCP server now externally using tunneling tools. It is recommended to set up auth (see above ^^)before doing that, otherwise it is publicly available.

### ngrok

The easiest way to get started is to use ngrok.

1. Log in/Sign up to ngrok
2. Install the ngrok binary as stated in their documentation `https://dashboard.ngrok.com/get-started/setup/linux`
3. Run the tunnel `ngrok http http://localhost:8000`


## Configuring with AI Clients
Since the whole purpose of this exercise was to expose our local MCP server to the internet securely, let's connect it to an application.

### Claude AI (web)

1. Click the `tuning` icon on the bottom of your chat box -> Manage connectors
2. Click **Add Custom Connector**
3. Give a name to your "connector" and add the URL <details><summary>See Image</summary>![claude-connector-setup.webp](docs/images/claude/claude-connector-setup.webp)</details>
  * Each server is exposed on their own endpoint so the URL to use would look something like `https://gibberish.ngrok-free.app/memento` (if `memento` would be the `name` value of your command).
4. Click "Connect" and go through the login loop towards WorkOS <details><summary>See Image</summary>![claude-workos-oauth-login.webp](docs/images/claude/claude-workos-oauth-login.webp)</details>
5. You should see a green notification on the top right telling you that your connector is connected.




## Examples

### Running with Multiple Commands

Create a `config.json` with multiple commands:

```json
{
  "commands": [
    {
      "name": "memory",
      "command": "npx -y @modelcontextprotocol/server-memory"
    },
    {
      "name": "pipe-brain",
      "command": "npx -y @modelcontextprotocol/server-sequential-thinking"
    }
  ],
  "port": 8000,
  "corsOrigin": "*"
}
```

Then run:

```bash
node dist/index.js
```

### Running with Environment Variables

Set the environment variables:

```
PORT=9000
COMMANDS=[{"name":"test","command":"npx -y @modelcontextprotocol/server-memory"}]
```

Then run:

```bash
node dist/index.js
```

### Running with OAuth Authentication

Create a `config.json` with OAuth configuration:

```json
{
  "commands": [
    {
      "name": "memory",
      "command": "npx -y @modelcontextprotocol/server-memory"
    }
  ],
  "port": 8000,
  "oauth": {
    "authorizationServerUrl": "https://your-auth-server.example.com"
  }
}
```


## License

[MIT License](./LICENSE)