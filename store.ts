// In-memory store for the forge: repositories, git objects, issues, pull
// requests, labels and comments. Everything lives in Maps, so the four timed
// workloads stay fast and no disk or network is touched.
//
// The bearer token's owner: the suite's token belongs to the scenario viewer.
// The suite publishes the derivation (a fixed seed plus a named RNG stream
// over the first/last-name lists in the kit), and the viewer login it yields
// is the login every check uses as the repository owner. Deriving it here is
// how the forge knows who POST /user/repos creates for, and what
// GraphQL `viewer { login }` must answer. The seed and the name lists are
// copied from the kit's wire.ts, which is the suite's own public contract.

import { createHash } from 'node:crypto';

const U64_MASK = (1n << 64n) - 1n;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const ch of Buffer.from(text, 'utf8')) {
    hash ^= BigInt(ch);
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function deriveUsers(): ScenarioUser[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 3; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

export const SCENARIO_USERS = deriveUsers();
export const VIEWER = SCENARIO_USERS[0] as ScenarioUser;
export const TEAMMATE = SCENARIO_USERS[1] as ScenarioUser;
export const STRANGER = SCENARIO_USERS[2] as ScenarioUser;

// ---------------------------------------------------------------- git objects

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of a git object: sha1 of "<type> <len>\0<bytes>". */
export function objectId(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp);
    const mode = data.subarray(off, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] as string;
  const lines = head.split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const message = text.slice(head.length + 2);
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const p of info.parents) lines.push(`parent ${p}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${info.message}`, 'utf8');
}

// ---------------------------------------------------------------- store types

export interface Repo {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // full ref name -> oid
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  updatedSeq: number;
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
}

/** A flat file map for one tree: path -> {oid, mode}. */
export type FileMap = Map<string, { oid: string; mode: string }>;

export class Store {
  repos = new Map<string, Repo>(); // "owner/name" -> repo
  nextRepoId = 1;
  seq = 0;
  readonly token: string;
  readonly nowIso: string;
  readonly baseEpoch: number;

  constructor() {
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    const trialNow = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = trialNow ? Date.parse(trialNow) : NaN;
    this.baseEpoch = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1780000000;
    this.nowIso = new Date(this.baseEpoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** Deterministic, monotonic timestamp: base + one second per mutation. */
  tick(): { epoch: number; iso: string } {
    this.seq += 1;
    const epoch = this.baseEpoch + this.seq;
    return { epoch, iso: new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  }

  identity(): string {
    const t = this.tick();
    return `${VIEWER.name} <${VIEWER.email}> ${t.epoch} +0000`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      fullName: `${VIEWER.login}/${name}`,
      owner: VIEWER.login,
      description: description ?? '',
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.seq,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(VIEWER.login, name), repo);
    return repo;
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((r) => r.owner === VIEWER.login)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ---- git objects -------------------------------------------------------

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  blob(repo: Repo, data: Buffer): string {
    return this.putObject(repo, 'blob', data);
  }

  tree(repo: Repo, entries: TreeEntry[]): string {
    return this.putObject(repo, 'tree', buildTree(entries));
  }

  commit(repo: Repo, info: CommitInfo): string {
    return this.putObject(repo, 'commit', buildCommit(info));
  }

  /** Flatten a tree object into path -> blob oid, following subtrees. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out: FileMap = new Map()): FileMap {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') this.flattenTree(repo, e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
    return out;
  }

  /** Build a tree object from a flat file map, creating intermediate trees. */
  treeFromFiles(repo: Repo, files: FileMap): string {
    const build = (dir: string): string => {
      const entries: TreeEntry[] = [];
      const subdirs = new Set<string>();
      const prefix = dir === '' ? '' : `${dir}/`;
      for (const [path, v] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) entries.push({ mode: v.mode, name: rest, oid: v.oid });
        else subdirs.add(rest.slice(0, slash));
      }
      for (const sub of subdirs) {
        entries.push({ mode: '40000', name: sub, oid: build(`${prefix}${sub}`) });
      }
      return this.tree(repo, entries);
    };
    return build('');
  }

  /** Commit a single file change on `branch` (creating the branch if needed). */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; contentSha: string } {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    let files: FileMap = new Map();
    if (parent) {
      const info = parseCommit((repo.objects.get(parent) as GitObject).data);
      files = this.flattenTree(repo, info.tree);
    }
    const contentSha = this.blob(repo, content);
    files.set(path, { oid: contentSha, mode: '100644' });
    const treeOid = this.treeFromFiles(repo, files);
    const ident = this.identity();
    const commitSha = this.commit(repo, {
      tree: treeOid,
      parents: parent ? [parent] : [],
      author: ident,
      committer: ident,
      message,
    });
    repo.refs.set(ref, commitSha);
    return { commitSha, contentSha };
  }

  /** All ancestors of `tip` (inclusive), newest first, via parent links. */
  ancestors(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      const info = parseCommit(obj.data);
      for (const p of info.parents) stack.push(p);
    }
    return out;
  }

  isAncestor(repo: Repo, maybeAncestor: string, tip: string): boolean {
    if (maybeAncestor === tip) return true;
    return this.ancestors(repo, tip).includes(maybeAncestor);
  }

  /** Files changed between base tree and head tree. */
  diffFiles(repo: Repo, baseTree: string, headTree: string): Array<{ path: string; status: string; additions: number; deletions: number; oldOid: string | null; newOid: string | null }> {
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{ path: string; status: string; additions: number; deletions: number; oldOid: string | null; newOid: string | null }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const oldText = (repo.objects.get(b.oid) as GitObject).data.toString('utf8');
        out.push({ path, status: 'removed', additions: 0, deletions: oldText.split('\n').length, oldOid: b.oid, newOid: null });
      } else if (!b && h) {
        const newText = (repo.objects.get(h.oid) as GitObject).data.toString('utf8');
        out.push({ path, status: 'added', additions: Math.max(1, newText.split('\n').length), deletions: 0, oldOid: null, newOid: h.oid });
      } else if (b && h && b.oid !== h.oid) {
        const oldText = (repo.objects.get(b.oid) as GitObject).data.toString('utf8');
        const newText = (repo.objects.get(h.oid) as GitObject).data.toString('utf8');
        out.push({
          path,
          status: 'modified',
          additions: Math.max(1, newText.split('\n').length),
          deletions: oldText.split('\n').length,
          oldOid: b.oid,
          newOid: h.oid,
        });
      }
    }
    return out;
  }

  /** Would merging `headTip` into `baseTip` conflict? True when both sides changed the same file differently since the merge base. */
  mergeConflicts(repo: Repo, baseSha: string, headTip: string, baseTip: string): boolean {
    const baseAnc = new Set(this.ancestors(repo, baseTip));
    let mergeBase: string | null = null;
    for (const a of this.ancestors(repo, headTip)) {
      if (baseAnc.has(a)) {
        mergeBase = a;
        break;
      }
    }
    if (mergeBase === null) return false;
    const baseInfo = parseCommit((repo.objects.get(mergeBase) as GitObject).data);
    const headInfo = parseCommit((repo.objects.get(headTip) as GitObject).data);
    const tipInfo = parseCommit((repo.objects.get(baseTip) as GitObject).data);
    const mbFiles = this.flattenTree(repo, baseInfo.tree);
    const headFiles = this.flattenTree(repo, headInfo.tree);
    const tipFiles = this.flattenTree(repo, tipInfo.tree);
    const paths = new Set([...mbFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
    for (const path of paths) {
      const mb = mbFiles.get(path)?.oid ?? null;
      const h = headFiles.get(path)?.oid ?? null;
      const t = tipFiles.get(path)?.oid ?? null;
      if (h !== mb && t !== mb && h !== t) return true;
    }
    return false;
  }
}
