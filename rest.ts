// GitHub REST v3: repositories, branches, commits, contents, issues,
// labels, comments and pull requests, over the in-memory store.

import { parseCommit, VIEWER, ZERO_OID, type Repo, type Store } from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function ok(body: unknown, headers?: Record<string, string>): RestResult {
  return { status: 200, body, headers };
}

export function created(body: unknown): RestResult {
  return { status: 201, body };
}

export function noContent(): RestResult {
  return { status: 204, body: null };
}

export function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.fullName}`,
    clone_url: `https://example.invalid/${repo.fullName}.git`,
    created_at: store.nowIso,
    updated_at: store.nowIso,
    pushed_at: store.nowIso,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    watchers_count: 0,
  };
}

function issueJson(store: Store, repo: Repo, issue: Repo['issues'][number]): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.find((l) => l.name === name);
      return { id: label?.id ?? 0, name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: store.nowIso,
    updated_at: store.nowIso,
    closed_at: issue.state === 'closed' ? store.nowIso : null,
    comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: Repo['pulls'][number]): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER.login}:${pull.headRef}`, user: { login: VIEWER.login, id: VIEWER.id } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER.login}:${pull.baseRef}`, user: { login: VIEWER.login, id: VIEWER.id } },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: store.nowIso,
    updated_at: store.nowIso,
    closed_at: pull.state === 'closed' ? store.nowIso : null,
  };
}

export function parseQuery(url: string): { path: string; query: URLSearchParams } {
  const u = new URL(url, 'http://entry');
  return { path: u.pathname, query: u.searchParams };
}

function paginate<T>(items: T[], query: URLSearchParams, basePath: string, origin = ''): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = `${origin}${basePath}?per_page=${perPage}&page=${page + 1}`;
    headers.link = `<${next}>; rel="next"`;
  }
  return { page: slice, headers };
}

/** Handle one REST request. `segments` are the path parts after /api/v3. */
export function handleRest(store: Store, method: string, path: string, query: URLSearchParams, body: unknown, origin = ''): RestResult {
  const segs = path.split('/').filter((s) => s.length > 0);
  const b = (body ?? {}) as Record<string, unknown>;

  if (segs.length === 0) {
    if (method === 'GET') return ok({ current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return err(404, 'Not Found');
  }
  if (segs[0] === 'meta' && method === 'GET') {
    return ok({ installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (segs[0] === 'rate_limit' && method === 'GET') {
    return ok({ resources: { core: { limit: 60, remaining: 60, reset: 0 } }, rate: { limit: 60, remaining: 60, reset: 0 } });
  }
  if (segs[0] === 'user') {
    if (segs.length === 1 && method === 'GET') {
      return ok({ login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    }
    if (segs[1] === 'repos') {
      if (method === 'GET') {
        const repos = store.listViewerRepos();
        const { page, headers } = paginate(repos.map((r) => repoJson(store, r)), query, '/api/v3/user/repos', origin);
        return { status: 200, body: page, headers };
      }
      if (method === 'POST') {
        const name = String(b.name ?? '');
        if (!name) return err(422, 'name is required');
        const existing = store.getRepo(VIEWER.login, name);
        if (existing) return err(422, 'Repository already exists');
        const repo = store.createRepo(name, b.private === true, String(b.description ?? ''));
        if (typeof b.default_branch === 'string' && b.default_branch) repo.defaultBranch = b.default_branch as string;
        return created(repoJson(store, repo));
      }
    }
    return err(404, 'Not Found');
  }
  if (segs[0] !== 'repos' || segs.length < 3) return err(404, 'Not Found');

  const owner = decodeURIComponent(segs[1] as string);
  const repoName = decodeURIComponent(segs[2] as string);
  const repo = store.getRepo(owner, repoName);
  if (!repo) return err(404, 'Not Found');
  const rest = segs.slice(3);

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return ok(repoJson(store, repo));
    if (method === 'PATCH') {
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.default_branch === 'string' && b.default_branch) repo.defaultBranch = b.default_branch;
      return ok(repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.repos.delete(store.repoKey(owner, repoName));
      return noContent();
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
    const branchName = decodeURIComponent(rest[1] as string);
    const oid = repo.refs.get(`refs/heads/${branchName}`);
    if (!oid) return err(404, 'Not Found');
    return ok({ name: branchName, commit: { sha: oid }, protected: false });
  }

  if (rest[0] === 'branches' && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }));
    branches.sort((a, c) => (a.name < c.name ? -1 : 1));
    return ok(branches);
  }

  if (rest[0] === 'commits' && method === 'GET') {
    const shaParam = query.get('sha');
    const refName = shaParam ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${refName}`) ?? repo.refs.get(refName) ?? (repo.objects.has(refName) ? refName : undefined);
    if (!tip || tip === ZERO_OID) return ok([]);
    const list = store.ancestors(repo, tip).map((oid) => {
      const info = parseCommit((repo.objects.get(oid) as { data: Buffer }).data);
      return {
        sha: oid,
        commit: { message: info.message, author: { name: VIEWER.name, email: VIEWER.email, date: store.nowIso }, committer: { name: VIEWER.name, email: VIEWER.email, date: store.nowIso } },
        author: { login: VIEWER.login, id: VIEWER.id },
      };
    });
    return ok(list);
  }

  if (rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
    const ref = String(b.ref ?? '');
    const sha = String(b.sha ?? '');
    if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return err(422, 'Invalid ref or sha');
    repo.refs.set(ref, sha);
    return created({ ref, object: { sha, type: 'commit', url: '' } });
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && method === 'GET') {
    const refPath = rest.slice(2).map(decodeURIComponent).join('/');
    const oid = repo.refs.get(`refs/${refPath}`) ?? repo.refs.get(refPath);
    if (!oid) return err(404, 'Not Found');
    return ok({ ref: `refs/${refPath}`, object: { sha: oid, type: 'commit', url: '' } });
  }

  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).map(decodeURIComponent).join('/');
    const refParam = query.get('ref');
    const branch = (typeof b.branch === 'string' && b.branch ? (b.branch as string) : undefined) ?? refParam ?? repo.defaultBranch;
    if (method === 'PUT') {
      const contentB64 = String(b.content ?? '');
      const message = String(b.message ?? 'Update file');
      const sha = typeof b.sha === 'string' ? (b.sha as string) : undefined;
      const ref = `refs/heads/${branch}`;
      const parent = repo.refs.get(ref);
      let files = new Map<string, { oid: string; mode: string }>();
      if (parent) {
        const info = parseCommit((repo.objects.get(parent) as { data: Buffer }).data);
        files = store.flattenTree(repo, info.tree);
      }
      const existing = files.get(filePath);
      if (sha && existing && existing.oid !== sha) return err(409, 'sha does not match');
      if (sha && !existing) return err(409, 'sha does not match');
      const isUpdate = Boolean(existing);
      let contentBuf: Buffer;
      try {
        contentBuf = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      } catch {
        return err(422, 'Invalid base64 content');
      }
      const { commitSha, contentSha } = store.commitFile(repo, branch, filePath, contentBuf, message);
      return {
        status: isUpdate ? 200 : 201,
        body: {
          content: { name: filePath.split('/').pop(), path: filePath, sha: contentSha, size: contentBuf.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitSha, message },
        },
      };
    }
    if (method === 'GET') {
      const ref = `refs/heads/${branch}`;
      const tip = repo.refs.get(ref);
      if (!tip) return err(404, 'Not Found');
      const info = parseCommit((repo.objects.get(tip) as { data: Buffer }).data);
      const files = store.flattenTree(repo, info.tree);
      const exact = files.get(filePath);
      if (exact) {
        const data = (repo.objects.get(exact.oid) as { data: Buffer }).data;
        return ok({
          name: filePath.split('/').pop(),
          path: filePath,
          sha: exact.oid,
          size: data.length,
          type: 'file',
          encoding: 'base64',
          content: data.toString('base64'),
        });
      }
      // Directory listing: entries directly under filePath (or root when empty).
      const prefix = filePath ? `${filePath}/` : '';
      const entries: Array<Record<string, unknown>> = [];
      const seenDirs = new Set<string>();
      for (const [p, v] of files) {
        if (!p.startsWith(prefix)) continue;
        const restPath = p.slice(prefix.length);
        const slash = restPath.indexOf('/');
        if (slash === -1) {
          const data = (repo.objects.get(v.oid) as { data: Buffer }).data;
          entries.push({ type: 'file', name: restPath, path: p, sha: v.oid, size: data.length });
        } else {
          const dir = restPath.slice(0, slash);
          if (!seenDirs.has(dir)) {
            seenDirs.add(dir);
            entries.push({ type: 'dir', name: dir, path: `${prefix}${dir}`, sha: v.oid, size: 0 });
          }
        }
      }
      if (entries.length === 0) return err(404, 'Not Found');
      entries.sort((a, c) => String(a.name) < String(c.name) ? -1 : 1);
      return ok(entries);
    }
    if (method === 'DELETE') {
      const ref = `refs/heads/${branch}`;
      const parent = repo.refs.get(ref);
      if (!parent) return err(404, 'Not Found');
      const info = parseCommit((repo.objects.get(parent) as { data: Buffer }).data);
      const files = store.flattenTree(repo, info.tree);
      if (!files.has(filePath)) return err(404, 'Not Found');
      files.delete(filePath);
      const treeOid = store.treeFromFiles(repo, files);
      const ident = store.identity();
      const commitSha = store.commit(repo, {
        tree: treeOid,
        parents: [parent],
        author: ident,
        committer: ident,
        message: String(b.message ?? 'Delete file'),
      });
      repo.refs.set(ref, commitSha);
      return ok({ commit: { sha: commitSha } });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'labels') {
    if (method === 'POST') {
      const name = String(b.name ?? '');
      if (!name) return err(422, 'name is required');
      const existing = repo.labels.find((l) => l.name === name);
      if (existing) return created({ id: existing.id, name: existing.name, color: existing.color, description: existing.description });
      const label = { id: repo.labels.length + 1, name, color: String(b.color ?? 'ededed'), description: String(b.description ?? '') };
      repo.labels.push(label);
      return created({ id: label.id, name: label.name, color: label.color, description: label.description });
    }
    if (method === 'GET') {
      return ok(repo.labels.map((l) => ({ id: l.id, name: l.name, color: l.color, description: l.description })));
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = String(b.title ?? '');
        if (!title) return err(422, 'title is required');
        const labelNames = Array.isArray(b.labels) ? (b.labels as unknown[]).map(String) : [];
        for (const name of labelNames) {
          if (!repo.labels.some((l) => l.name === name)) return err(422, `Label does not exist: ${name}`);
        }
        const n = repo.nextIssue;
        repo.nextIssue += 1;
        store.tick();
        const issue = {
          id: 100000 + n,
          number: n,
          title,
          body: String(b.body ?? ''),
          state: 'open' as const,
          labels: labelNames,
          createdSeq: store.seq,
          updatedSeq: store.seq,
          comments: [],
        };
        repo.issues.push(issue);
        return created(issueJson(store, repo, issue));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (sort === 'created') {
          list.sort((a, c) => (direction === 'asc' ? a.createdSeq - c.createdSeq : c.createdSeq - a.createdSeq));
        }
        const { page } = paginate(list.map((i) => issueJson(store, repo, i)), query, `/api/v3/repos/${owner}/${repoName}/issues`);
        return ok(page);
      }
      return err(404, 'Not Found');
    }
    const num = parseInt(rest[1] as string, 10);
    const issue = repo.issues.find((i) => i.number === num);
    if (!issue) return err(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return ok(issueJson(store, repo, issue));
      if (method === 'PATCH') {
        if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) issue.state = b.state;
        if (typeof b.title === 'string') issue.title = b.title;
        if (typeof b.body === 'string') issue.body = b.body;
        issue.updatedSeq = store.tick().epoch;
        return ok(issueJson(store, repo, issue));
      }
      return err(404, 'Not Found');
    }
    if (rest[2] === 'comments') {
      if (method === 'POST') {
        const comment = { id: repo.nextComment, body: String(b.body ?? ''), createdSeq: store.tick().epoch };
        repo.nextComment += 1;
        issue.comments.push(comment);
        return created({ id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: store.nowIso, updated_at: store.nowIso });
      }
      if (method === 'GET') {
        return ok(issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: store.nowIso, updated_at: store.nowIso })));
      }
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const head = String(b.head ?? '');
        const base = String(b.base ?? repo.defaultBranch);
        const headTip = repo.refs.get(`refs/heads/${head}`);
        const baseTip = repo.refs.get(`refs/heads/${base}`);
        if (!headTip) return err(422, 'Head branch does not exist');
        if (!baseTip) return err(422, 'Base branch does not exist');
        const n = repo.nextPull;
        repo.nextPull += 1;
        store.tick();
        const pull = {
          id: 200000 + n,
          number: n,
          title: String(b.title ?? ''),
          body: String(b.body ?? ''),
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
        return created(pullJson(store, repo, pull));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, c) => c.createdSeq - a.createdSeq);
        return ok(list.map((p) => pullJson(store, repo, p)));
      }
      return err(404, 'Not Found');
    }
    const num = parseInt(rest[1] as string, 10);
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) return err(404, 'Not Found');
    if (rest.length === 2 && method === 'GET') return ok(pullJson(store, repo, pull));
    if (rest[2] === 'files' && method === 'GET') {
      const headInfo = parseCommit((repo.objects.get(pull.headSha) as { data: Buffer }).data);
      const baseInfo = parseCommit((repo.objects.get(pull.baseSha) as { data: Buffer }).data);
      const diffs = store.diffFiles(repo, baseInfo.tree, headInfo.tree);
      return ok(diffs.map((d) => ({
        sha: d.newOid ?? d.oldOid ?? '',
        filename: d.path,
        status: d.status,
        additions: d.additions,
        deletions: d.deletions,
        changes: d.additions + d.deletions,
        patch: '',
      })));
    }
    if (rest[2] === 'merge' && method === 'PUT') {
      if (pull.state === 'closed') {
        if (pull.merged) return ok({ sha: pull.mergeCommitSha, merged: true, message: 'Pull request successfully merged' });
        return err(405, 'Pull request is closed');
      }
      const baseRef = `refs/heads/${pull.baseRef}`;
      const baseTip = repo.refs.get(baseRef);
      if (!baseTip) return err(404, 'Not Found');
      if (store.mergeConflicts(repo, pull.baseSha, pull.headSha, baseTip)) {
        return err(405, 'Merge conflict');
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
      return ok({ sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
