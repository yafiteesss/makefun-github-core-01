// Model Context Protocol over Streamable HTTP (JSON-RPC 2.0). Two eras:
// modern 2026-07-28 via server/discover, and the legacy handshake
// (initialize + notifications/initialized). The tools act on the same
// store as REST, so a repository or issue created over MCP reads back
// over /api/v3 with the same ids.

import { parseCommit, VIEWER, type Repo, type Store } from './store.ts';
import { repoGlobalId } from './graphql.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full name owner/repo' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | undefined {
  const fullName = typeof args.full_name === 'string' ? (args.full_name as string) : '';
  if (fullName.includes('/')) {
    const [owner, name] = fullName.split('/', 2) as [string, string];
    return store.getRepo(owner, name);
  }
  const owner = String(args.owner ?? '');
  const repo = String(args.repo ?? args.repository ?? '');
  if (!owner || !repo) return undefined;
  return store.getRepo(owner, repo);
}

function textResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { ok: boolean; result: Record<string, unknown> } {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const canonical = norm.endsWith('createrepo') || norm === 'createrepository' ? 'create_repo'
    : norm.endsWith('getrepo') || norm === 'getrepository' ? 'get_repo'
    : norm.endsWith('createissue') ? 'create_issue'
    : norm.endsWith('listissues') || norm.endsWith('issuelist') ? 'list_issues'
    : norm.endsWith('createpullrequest') || norm.endsWith('createpr') ? 'create_pull_request'
    : norm.endsWith('mergepullrequest') || norm.endsWith('mergepr') ? 'merge_pull_request'
    : null;
  if (canonical === null) return { ok: false, result: {} };

  if (canonical === 'create_repo') {
    const repoName = String(args.name ?? args.repo ?? '');
    if (!repoName) return { ok: true, result: errorResult('Missing required argument: name') };
    const existing = store.getRepo(VIEWER.login, repoName);
    if (existing) {
      return { ok: true, result: textResult({ id: repoGlobalId(existing), databaseId: existing.id, name: existing.name, full_name: existing.fullName, owner: { login: existing.owner }, private: existing.private, default_branch: existing.defaultBranch }) };
    }
    const repo = store.createRepo(repoName, args.private === true, String(args.description ?? ''));
    return { ok: true, result: textResult({ id: repoGlobalId(repo), databaseId: repo.id, name: repo.name, full_name: repo.fullName, owner: { login: repo.owner }, private: repo.private, default_branch: repo.defaultBranch }) };
  }

  const repo = resolveRepo(store, args);
  if (!repo) return { ok: true, result: errorResult('Repository not found') };

  if (canonical === 'get_repo') {
    return { ok: true, result: textResult({ id: repoGlobalId(repo), databaseId: repo.id, name: repo.name, full_name: repo.fullName, owner: { login: repo.owner }, private: repo.private, description: repo.description, default_branch: repo.defaultBranch }) };
  }
  if (canonical === 'create_issue') {
    const title = String(args.title ?? '');
    if (!title) return { ok: true, result: errorResult('Missing required argument: title') };
    const n = repo.nextIssue;
    repo.nextIssue += 1;
    store.tick();
    const issue = {
      id: 100000 + n,
      number: n,
      title,
      body: String(args.body ?? ''),
      state: 'open' as const,
      labels: [] as string[],
      createdSeq: store.seq,
      updatedSeq: store.seq,
      comments: [],
    };
    repo.issues.push(issue);
    return { ok: true, result: textResult({ id: 100000 + n, number: n, title, body: issue.body, state: 'open' }) };
  }
  if (canonical === 'list_issues') {
    const state = String(args.state ?? 'open');
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    return { ok: true, result: textResult(list.map((i) => ({ id: 100000 + i.number, number: i.number, title: i.title, body: i.body, state: i.state }))) };
  }
  if (canonical === 'create_pull_request') {
    const head = String(args.head ?? '');
    const base = String(args.base ?? repo.defaultBranch);
    const title = String(args.title ?? '');
    if (!head || !title) return { ok: true, result: errorResult('Missing required argument: head or title') };
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (!headTip || !baseTip) return { ok: true, result: errorResult('Head or base branch does not exist') };
    const n = repo.nextPull;
    repo.nextPull += 1;
    store.tick();
    const pull = {
      id: 200000 + n,
      number: n,
      title,
      body: String(args.body ?? ''),
      state: 'open' as const,
      merged: false,
      mergedAt: null as string | null,
      mergeCommitSha: null as string | null,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      createdSeq: store.seq,
    };
    repo.pulls.push(pull);
    return { ok: true, result: textResult({ id: 200000 + n, number: n, title, state: 'open', head, base, headRef: head, baseRef: base }) };
  }
  if (canonical === 'merge_pull_request') {
    const num = Number(args.pull_number ?? args.number ?? NaN);
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) return { ok: true, result: errorResult('Pull request not found') };
    if (pull.state === 'closed') {
      return { ok: true, result: textResult({ number: pull.number, merged: pull.merged, state: pull.state, sha: pull.mergeCommitSha }) };
    }
    const baseRef = `refs/heads/${pull.baseRef}`;
    const baseTip = repo.refs.get(baseRef);
    if (!baseTip) return { ok: true, result: errorResult('Base branch not found') };
    if (store.mergeConflicts(repo, pull.baseSha, pull.headSha, baseTip)) {
      return { ok: true, result: errorResult('Merge conflict') };
    }
    const headInfo = parseCommit((repo.objects.get(pull.headSha) as { data: Buffer }).data);
    const ident = store.identity();
    const mergeSha = store.commit(repo, {
      tree: headInfo.tree,
      parents: [baseTip],
      author: ident,
      committer: ident,
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
    });
    repo.refs.set(baseRef, mergeSha);
    const t = store.tick();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = t.iso;
    pull.mergeCommitSha = mergeSha;
    return { ok: true, result: textResult({ number: pull.number, merged: true, state: 'closed', sha: mergeSha }) };
  }
  return { ok: false, result: {} };
}

export interface McpOutcome {
  status: number;
  payload: unknown;
  headers?: Record<string, string>;
}

/** Handle one POST /mcp request. `rawBody` is the request bytes. */
export function handleMcp(store: Store, rawBody: Buffer, authorized: boolean): McpOutcome {
  if (!authorized) {
    return { status: 401, payload: { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } } };
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, payload: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, payload: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const req = body as Record<string, unknown>;
  const id = (req.id ?? null) as string | number | null;
  const method = String(req.method ?? '');
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) are acknowledged with 202 and no body.
  if (id === null || id === undefined) {
    return { status: 202, payload: null };
  }

  const rpcResult = (result: unknown): McpOutcome => ({
    status: 200,
    payload: { jsonrpc: '2.0', id, result },
    headers: { 'mcp-protocol-version': '2026-07-28' },
  });
  const rpcError = (code: number, message: string): McpOutcome => ({
    status: 200,
    payload: { jsonrpc: '2.0', id, error: { code, message } },
  });

  if (method === 'server/discover') {
    return rpcResult({
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? (params.protocolVersion as string) : '2026-07-28';
    return rpcResult({
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    });
  }
  if (method === 'tools/list') {
    // The same list, byte for byte, on every call: a fixed literal array.
    return rpcResult({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    // Missing required arguments: the tool's schema decides.
    const tool = TOOLS.find((t) => t.name === name || name.toLowerCase().replace(/[^a-z0-9]/g, '').endsWith(t.name.replace(/_/g, '')));
    if (!tool) return rpcError(-32602, `Unknown tool: ${name}`);
    const required = (tool.inputSchema.required ?? []) as string[];
    const missing = required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
    if (missing.length > 0) {
      return rpcResult({ content: [{ type: 'text', text: `Missing required argument: ${missing.join(', ')}` }], isError: true });
    }
    const { result } = callTool(store, name, args);
    return rpcResult(result);
  }
  return rpcError(-32601, `Method not found: ${method}`);
}
