import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  exportJWK,
  generateKeyPair,
  JWK,
  KeyObject,
  SignJWT,
  CryptoKey as JoseCryptoKey,
} from 'jose';
import { randomUUID } from 'node:crypto';

export interface TestAuthServer {
  issuer: string;
  jwksPath: string;
  close(): Promise<void>;
  mintToken(claims: {
    audience?: string | string[];
    issuer?: string;
    subject?: string;
    expiresIn?: string;
  }): Promise<string>;
  mintTokenWithKey(
    privateKey: JoseCryptoKey | KeyObject,
    kid: string,
    claims: {
      audience?: string | string[];
      issuer?: string;
      subject?: string;
      expiresIn?: string;
      alg?: string;
    }
  ): Promise<string>;
}

/**
 * Spins up an in-process HTTP server that serves a JWKS document and can mint
 * tokens signed by the matching private key. Used as a stand-in for a real
 * OAuth authorization server in tests.
 */
export async function startTestAuthServer(jwksPath = '/oauth2/jwks'): Promise<TestAuthServer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = randomUUID();
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };

  const server: HttpServer = createServer((req, res) => {
    if (req.url === jwksPath) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const issuer = `http://127.0.0.1:${port}`;

  const mintToken: TestAuthServer['mintToken'] = async claims => {
    const jwt = new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuedAt()
      .setIssuer(claims.issuer ?? issuer)
      .setSubject(claims.subject ?? 'user-123')
      .setExpirationTime(claims.expiresIn ?? '5m');
    if (claims.audience !== undefined) {
      jwt.setAudience(claims.audience);
    }
    return jwt.sign(privateKey);
  };

  const mintTokenWithKey: TestAuthServer['mintTokenWithKey'] = async (key, keyId, claims) => {
    const jwt = new SignJWT({})
      .setProtectedHeader({ alg: claims.alg ?? 'RS256', kid: keyId })
      .setIssuedAt()
      .setIssuer(claims.issuer ?? issuer)
      .setSubject(claims.subject ?? 'user-123')
      .setExpirationTime(claims.expiresIn ?? '5m');
    if (claims.audience !== undefined) {
      jwt.setAudience(claims.audience);
    }
    return jwt.sign(key as JoseCryptoKey);
  };

  return {
    issuer,
    jwksPath,
    close: () =>
      new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
    mintToken,
    mintTokenWithKey,
  };
}

/**
 * Starts the LocalContextServer's Express app on an ephemeral port and returns
 * a base URL plus a teardown function.
 */
export async function startExpressApp(
  app: import('express').Application
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}
