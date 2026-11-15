// The forge's HTTP server: one process, four surfaces. Routing:
//   GET  /healthz                        boot probe, no auth
//   /{owner}/{repo}.git/...              git smart HTTP (upload-pack v2, receive-pack v0)
//   /api/v3/...                          REST v3 (JSON, X-GitHub-Request-Id on every reply)
//   POST /api/graphql                    GraphQL v4
//   POST /mcp                            MCP over Streamable HTTP
//   anything else                        404 JSON
//
// Auth: every API call carries Authorization: Bearer <MAKEFUN_SHOP_TOKEN>;
// a missing or wrong token is 401, except /healthz. Bodies are read fully
// before dispatch; a malformed JSON body is 400.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, parseQuery } from './rest.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  requestCounter += 1;
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${requestCounter.toString(16)}-${Date.now().toString(36)}`,
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(store: Store): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const { path, query } = parseQuery(req.url ?? '/');
        const auth = req.headers.authorization ?? '';
        const token = store.token;
        const authorized = token === '' ? auth.startsWith('Bearer ') : auth === `Bearer ${token}`;

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const action = gitMatch[3] as string;
          const repo = store.getRepo(owner, repoName);
          if (!authorized) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          if (action === 'info/refs') {
            const service = query.get('service') ?? '';
            const gitProtocol = (req.headers['git-protocol'] as string) ?? '';
            const out = handleInfoRefs(store, repo, service, gitProtocol.includes('version=2') ? '2' : gitProtocol);
            if (out.status === 404) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            sendBytes(res, 200, out.contentType, out.body);
            return;
          }
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const body = await readBody(req);
          if (action === 'git-upload-pack') {
            const gitProtocol = (req.headers['git-protocol'] as string) ?? '';
            const out = handleUploadPack(store, repo, body, gitProtocol.includes('version=2') ? '2' : gitProtocol);
            sendBytes(res, 200, 'application/x-git-upload-pack-result', out);
            return;
          }
          const out = handleReceivePack(store, repo, body);
          sendBytes(res, 200, 'application/x-git-receive-pack-result', out);
          return;
        }

        // GraphQL
        if (path === '/api/graphql') {
          if (!authorized) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown = null;
          let badJson = false;
          try {
            parsed = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : null;
          } catch {
            badJson = true;
          }
          if (badJson) {
            sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] });
            return;
          }
          const out = handleGraphQL(store, parsed);
          sendJson(res, out.status, out.payload);
          return;
        }

        // MCP
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(req);
          const out = handleMcp(store, raw, authorized);
          if (out.status === 202) {
            res.writeHead(202, { 'content-length': 0 });
            res.end();
            return;
          }
          sendJson(res, out.status, out.payload, out.headers ?? {});
          return;
        }

        // REST v3
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          let parsed: unknown = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                parsed = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Invalid JSON' });
                return;
              }
            }
          }
          const restPath = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
          const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
          const out = handleRest(store, method, restPath, query, parsed, origin);
          if (out.status === 204) {
            requestCounter += 1;
            res.writeHead(204, { 'x-github-request-id': `req-${requestCounter.toString(16)}-${Date.now().toString(36)}` });
            res.end();
            return;
          }
          sendJson(res, out.status, out.body, out.headers ?? {});
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });
}
