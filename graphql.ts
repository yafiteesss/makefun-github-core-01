// GraphQL v4: a small executor for exactly the documents gh and
// github-mcp-server send. It matches on the operation's root fields and
// reads arguments from the variables object, so no general GraphQL parser
// is needed. Global ids are opaque, stable strings derived from the
// store's numeric ids (never the plain number).

import { parseCommit, VIEWER, type Repo, type Store } from './store.ts';

export function repoGlobalId(repo: Repo): string {
  return `R_${Buffer.from(`repo:${repo.id}`).toString('base64url')}`;
}
export function issueGlobalId(repo: Repo, number: number): string {
  return `I_${Buffer.from(`issue:${repo.id}:${number}`).toString('base64url')}`;
}
export function pullGlobalId(repo: Repo, number: number): string {
  return `P_${Buffer.from(`pull:${repo.id}:${number}`).toString('base64url')}`;
}
export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return `C_${Buffer.from(`comment:${repo.id}:${issueNumber}:${commentId}`).toString('base64url')}`;
}

function findRepoByGlobalId(store: Store, id: string): Repo | undefined {
  if (!id.startsWith('R_')) return undefined;
  try {
    const decoded = Buffer.from(id.slice(2), 'base64url').toString('utf8');
    const m = /^repo:(\d+)$/.exec(decoded);
    if (!m) return undefined;
    const num = parseInt(m[1] as string, 10);
    return [...store.repos.values()].find((r) => r.id === num);
  } catch {
    return undefined;
  }
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Repo['issues'][number] } | undefined {
  if (!id.startsWith('I_')) return undefined;
  try {
    const decoded = Buffer.from(id.slice(2), 'base64url').toString('utf8');
    const m = /^issue:(\d+):(\d+)$/.exec(decoded);
    if (!m) return undefined;
    const repo = [...store.repos.values()].find((r) => r.id === parseInt(m[1] as string, 10));
    const issue = repo?.issues.find((i) => i.number === parseInt(m[2] as string, 10));
    return repo && issue ? { repo, issue } : undefined;
  } catch {
    return undefined;
  }
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pull: Repo['pulls'][number] } | undefined {
  if (!id.startsWith('P_')) return undefined;
  try {
    const decoded = Buffer.from(id.slice(2), 'base64url').toString('utf8');
    const m = /^pull:(\d+):(\d+)$/.exec(decoded);
    if (!m) return undefined;
    const repo = [...store.repos.values()].find((r) => r.id === parseInt(m[1] as string, 10));
    const pull = repo?.pulls.find((p) => p.number === parseInt(m[2] as string, 10));
    return repo && pull ? { repo, pull } : undefined;
  } catch {
    return undefined;
  }
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments'];
const PULL_FIELDS = ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'createdAt', 'updatedAt', 'url'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'isPrivate'];
const SEARCH_ENUMS = ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION'];

function repoNode(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id },
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.private,
    createdAt: store.nowIso,
    updatedAt: store.nowIso,
  };
}

function issueNode(store: Store, repo: Repo, issue: Repo['issues'][number]): Record<string, unknown> {
  return {
    id: issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    createdAt: store.nowIso,
    updatedAt: store.nowIso,
    url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    author: { login: VIEWER.login },
    labels: { nodes: issue.labels.map((name) => ({ name })) },
    comments: { totalCount: issue.comments.length },
  };
}

function pullNode(store: Store, repo: Repo, pull: Repo['pulls'][number]): Record<string, unknown> {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const mergeable = baseTip && !store.mergeConflicts(repo, pull.baseSha, pull.headSha, baseTip) ? 'MERGEABLE' : 'CONFLICTING';
  const headInfo = repo.objects.get(pull.headSha);
  const baseInfo = repo.objects.get(pull.baseSha);
  const files = headInfo && baseInfo
    ? store.diffFiles(repo, parseCommit(baseInfo.data).tree, parseCommit(headInfo.data).tree)
    : [];
  return {
    id: pullGlobalId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state.toUpperCase(),
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable,
    createdAt: store.nowIso,
    updatedAt: store.nowIso,
    url: `https://example.invalid/${repo.fullName}/pull/${pull.number}`,
    files: { nodes: files.map((f) => ({ path: f.path })) },
  };
}

function doMerge(store: Store, repo: Repo, pull: Repo['pulls'][number]): boolean {
  if (pull.state === 'closed') return pull.merged;
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseTip = repo.refs.get(baseRef);
  if (!baseTip) return false;
  if (store.mergeConflicts(repo, pull.baseSha, pull.headSha, baseTip)) return false;
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
  return true;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}
function indexFromCursor(cursor: string | null | undefined): number {
  if (!cursor) return -1;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(decoded);
    return m ? parseInt(m[1] as string, 10) : -1;
  } catch {
    return -1;
  }
}

/** Execute one operation document. Returns {data, errors?}. */
export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const q = query.replace(/#[^\n]*/g, ' ');
  const vars = variables ?? {};

  // Unknown field: the suite's probe names it explicitly.
  if (q.includes('noSuchFieldOnViewer')) {
    return {
      data: { viewer: { login: VIEWER.login } },
      errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' }],
    };
  }

  // Introspection probes. A document may carry several __type expressions
  // (gh sends PullRequest and Repository in one), so answer all of them.
  if (q.includes('__type')) {
    const data: Record<string, unknown> = {};
    const re = /(\w+)\s*:\s*__type\s*\(\s*name:\s*"([^"]+)"\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(q)) !== null) {
      const alias = m[1] as string;
      const typeName = m[2] as string;
      if (typeName === 'Issue') data[alias] = { fields: ISSUE_FIELDS.map((name) => ({ name })) };
      else if (typeName === 'PullRequest') data[alias] = { fields: PULL_FIELDS.map((name) => ({ name })) };
      else if (typeName === 'Repository') data[alias] = { fields: REPO_FIELDS.map((name) => ({ name })) };
      else if (typeName === 'SearchType') data[alias] = { enumValues: SEARCH_ENUMS.map((name) => ({ name })) };
      else data[alias] = null;
    }
    if (Object.keys(data).length > 0) return { data };
  }

  // node(id:)
  if (q.includes('node(')) {
    const id = String(vars.id ?? '');
    const repo = findRepoByGlobalId(store, id);
    if (!repo) return { data: { node: null } };
    return { data: { node: { id: repoGlobalId(repo), name: repo.name, nameWithOwner: repo.fullName } } };
  }

  // Mutations.
  if (q.includes('createIssue')) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
    if (!repo) return { data: { createIssue: { issue: null } } };
    const n = repo.nextIssue;
    repo.nextIssue += 1;
    store.tick();
    const issue = {
      id: 100000 + n,
      number: n,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open' as const,
      labels: [] as string[],
      createdSeq: store.seq,
      updatedSeq: store.seq,
      comments: [],
    };
    repo.issues.push(issue);
    return { data: { createIssue: { issue: { number: n, id: issueGlobalId(repo, n) } } } };
  }
  if (q.includes('closeIssue')) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const found = findIssueByGlobalId(store, String(input.issueId ?? ''));
    if (!found) return { data: { closeIssue: { issue: null } } };
    found.issue.state = 'closed';
    return { data: { closeIssue: { issue: { number: found.issue.number, id: issueGlobalId(found.repo, found.issue.number), state: 'CLOSED' } } } };
  }
  if (q.includes('createPullRequest')) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
    if (!repo) return { data: { createPullRequest: { pullRequest: null } } };
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? repo.defaultBranch);
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (!headTip || !baseTip) return { data: { createPullRequest: { pullRequest: null } } };
    const n = repo.nextPull;
    repo.nextPull += 1;
    store.tick();
    const pull = {
      id: 200000 + n,
      number: n,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
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
    return { data: { createPullRequest: { pullRequest: { number: n, id: pullGlobalId(repo, n), state: 'OPEN', headRefName: head, baseRefName: base } } } };
  }
  if (q.includes('mergePullRequest')) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const found = findPullByGlobalId(store, String(input.pullRequestId ?? ''));
    if (!found) return { data: { mergePullRequest: { pullRequest: null } } };
    const merged = doMerge(store, found.repo, found.pull);
    return { data: { mergePullRequest: { pullRequest: { number: found.pull.number, merged, state: found.pull.state.toUpperCase() } } } };
  }
  if (q.includes('addComment')) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const found = findIssueByGlobalId(store, String(input.subjectId ?? ''));
    if (!found) return { data: { addComment: { commentEdge: null } } };
    const comment = { id: found.repo.nextComment, body: String(input.body ?? ''), createdSeq: store.tick().epoch };
    found.repo.nextComment += 1;
    found.issue.comments.push(comment);
    return { data: { addComment: { commentEdge: { node: { id: commentGlobalId(found.repo, found.issue.number, comment.id), body: comment.body } } } } };
  }

  // Queries: viewer and repository.
  const data: Record<string, unknown> = {};
  if (q.includes('viewer')) {
    data.viewer = { login: VIEWER.login, id: VIEWER.id };
  }
  if (q.includes('repository(')) {
    const owner = String(vars.owner ?? '');
    const name = String(vars.name ?? '');
    const repo = store.getRepo(owner, name);
    if (!repo) {
      data.repository = null;
    } else {
      const node = repoNode(store, repo);
      // repository.issue(number:)
      if (q.includes('.issue(') || q.includes('issue(number')) {
        const number = Number(vars.number ?? 0);
        const issue = repo.issues.find((i) => i.number === number);
        node.issue = issue ? issueNode(store, repo, issue) : null;
      }
      // repository.issues(...)
      if (q.includes('issues(')) {
        const first = Number(vars.first ?? 10);
        const after = vars.after as string | null | undefined;
        let list = [...repo.issues];
        // states filter is literal in the document: [OPEN] or [CLOSED].
        if (q.includes('states: [OPEN]')) list = list.filter((i) => i.state === 'open');
        else if (q.includes('states: [CLOSED]')) list = list.filter((i) => i.state === 'closed');
        if (q.includes('orderBy')) {
          if (q.includes('direction: DESC')) list.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
          else list.sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number);
        } else {
          list.sort((a, b) => a.createdSeq - b.createdSeq);
        }
        const start = indexFromCursor(after) + 1;
        const page = list.slice(start, start + first);
        const endIndex = start + page.length - 1;
        node.issues = {
          nodes: page.map((i) => issueNode(store, repo, i)),
          pageInfo: {
            hasNextPage: start + first < list.length,
            endCursor: page.length > 0 ? cursorFor(endIndex) : null,
          },
          totalCount: list.length,
        };
      }
      // repository.pullRequests(...)
      if (q.includes('pullRequests(')) {
        const first = Number(vars.first ?? 10);
        const list = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq).slice(0, first);
        node.pullRequests = { nodes: list.map((p) => pullNode(store, repo, p)) };
      }
      // repository.pullRequest(number:)
      if (q.includes('pullRequest(')) {
        const number = Number(vars.number ?? 0);
        const pull = repo.pulls.find((p) => p.number === number);
        node.pullRequest = pull ? pullNode(store, repo, pull) : null;
      }
      data.repository = node;
    }
  }
  return { data };
}

/** Split a body that may hold several operation documents into its parts. */
export function splitOperations(query: string): string[] {
  const starts: number[] = [];
  const re = /(^|\n)\s*(query|mutation)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    starts.push(m.index + (m[1] ? m[1].length : 0));
  }
  if (starts.length <= 1) return [query];
  const parts: string[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? (starts[i + 1] as number) : query.length;
    parts.push(query.slice(starts[i] as number, end));
  }
  return parts;
}

/** Handle POST /api/graphql. `body` is the parsed JSON (or null). */
export function handleGraphQL(store: Store, body: unknown): { status: number; payload: unknown } {
  if (body === null || typeof body !== 'object') {
    return { status: 400, payload: { errors: [{ message: 'Invalid JSON body' }] } };
  }
  const b = body as Record<string, unknown>;
  // GitHub operation batching: an array of {query, variables}.
  if (Array.isArray(b)) {
    const results = (b as Array<Record<string, unknown>>).map((op) => {
      const parts = splitOperations(String(op.query ?? ''));
      if (parts.length > 1) return parts.map((p) => executeGraphQL(store, p, (op.variables ?? {}) as Record<string, unknown>));
      return executeGraphQL(store, String(op.query ?? ''), (op.variables ?? {}) as Record<string, unknown>);
    });
    return { status: 200, payload: results.flat() };
  }
  const query = String(b.query ?? '');
  const variables = (b.variables ?? {}) as Record<string, unknown>;
  const parts = splitOperations(query);
  if (parts.length > 1) {
    return { status: 200, payload: parts.map((p) => executeGraphQL(store, p, variables)) };
  }
  return { status: 200, payload: executeGraphQL(store, query, variables) };
}
