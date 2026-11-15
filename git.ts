// Git smart HTTP: pkt-line framing, packfile read/write, upload-pack v2
// and receive-pack v0. No git binary anywhere: objects are zlib-compressed
// in memory by the store, packs are built and parsed here with node:zlib
// and node:crypto only.
//
// One subtlety: inflateSync ignores trailing bytes, so it cannot tell where
// one object's deflate stream ends and the next object's header begins.
// inflateAt finds the exact stream length by searching for the smallest
// prefix that inflates cleanly to the expected size.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseCommit, parseTree, ZERO_OID, type GitObject, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------- pkt-line

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([head, payload]);
}

export const FLUSH = Buffer.from('0000', 'utf8');
export const DELIM = Buffer.from('0001', 'utf8');

export interface Packet {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Split a buffer into pkt-line packets (data / flush / delim). */
export function parsePackets(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('utf8'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
    } else {
      out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return out;
}

// ---------------------------------------------------------------- packfile

function shaOf(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

/** Inflate the deflate stream at `off`, expecting `size` output bytes. */
function inflateAt(buf: Buffer, off: number, size: number): { data: Buffer; consumed: number } {
  const remaining = buf.length - off;
  const tryLen = (len: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(off, off + len));
      return out.length === size ? out : null;
    } catch {
      return null;
    }
  };
  // Exponential search for an upper bound, then binary search for the
  // smallest length that inflates to the expected size.
  let hi = 1;
  while (hi < remaining && tryLen(hi) === null) hi *= 2;
  if (hi > remaining) hi = remaining;
  if (tryLen(hi) === null) throw new Error('deflate stream not found');
  let lo = 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (tryLen(mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  const data = tryLen(lo);
  if (data === null) throw new Error('deflate stream not found');
  return { data, consumed: lo };
}

function applyDelta(baseData: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[p] as number;
      p += 1;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVarint();
  if (srcSize !== baseData.length) throw new Error('delta base size mismatch');
  const dstSize = readVarint();
  const parts: Buffer[] = [];
  while (p < delta.length) {
    const op = delta[p] as number;
    p += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { cpOff |= (delta[p] as number) << (8 * i); p += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { cpSize |= (delta[p] as number) << (8 * i); p += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(baseData.subarray(cpOff, cpOff + cpSize));
    } else if (op !== 0) {
      parts.push(delta.subarray(p, p + op));
      p += op;
    } else throw new Error('delta opcode 0');
  }
  const out = Buffer.concat(parts);
  if (out.length !== dstSize) throw new Error('delta result size mismatch');
  return out;
}

const TYPE_NAMES = ['', 'commit', 'tree', 'blob', 'tag', '', 'ofs-delta', 'ref-delta'] as const;

export interface PackObject {
  type: GitObject['type'];
  data: Buffer;
}

/** Parse a packfile, resolving deltas against `base` and earlier entries. */
export function parsePack(buf: Buffer, base: Map<string, GitObject>): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('utf8') !== 'PACK') throw new Error('bad pack header');
  const count = buf.readUInt32BE(8);
  let off = 12;
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { type: GitObject['type']; data: Buffer; oid: string }>();
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const first = buf[off] as number;
    const typeNum = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    off += 1;
    let b = first;
    while (b & 0x80) {
      b = buf[off] as number;
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseObj: { type: GitObject['type']; data: Buffer } | undefined;
    if (typeNum === 6) {
      b = buf[off] as number;
      off += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = buf[off] as number;
        off += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseObj = byOffset.get(start - offset);
      if (!baseObj) throw new Error('ofs-delta base not found');
    } else if (typeNum === 7) {
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      baseObj = objects.get(baseOid) ?? base.get(baseOid);
      if (!baseObj) throw new Error('ref-delta base not found');
    }
    const { data: inflated, consumed } = inflateAt(buf, off, size);
    off += consumed;
    let type: GitObject['type'];
    let data: Buffer;
    if (baseObj) {
      type = baseObj.type;
      data = applyDelta(baseObj.data, inflated);
    } else {
      type = TYPE_NAMES[typeNum] as GitObject['type'];
      data = inflated;
    }
    const oid = shaOf(type, data);
    const entry = { type, data, oid };
    objects.set(oid, { type, data });
    byOffset.set(start, entry);
  }
  return objects;
}

/** Pack object header: type (1 commit, 2 tree, 3 blob, 4 tag) + size. */
function packObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

const TYPE_NUMS: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Build a packfile holding `objects` (no deltas: every object verbatim). */
export function buildPack(objects: Array<{ type: GitObject['type']; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packObjectHeader(TYPE_NUMS[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Objects a client holds after a shallow clone: everything reachable
 * from `haves`, except the ancestors of a shallow-boundary commit (the
 * client never received those). */
export function collectHeld(store: Store, repo: Repo, haves: string[], shallowBoundaries: Set<string>): Set<string> {
  const held = new Set<string>();
  const queue = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (held.has(oid) || oid === ZERO_OID) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      for (const o of collectReachable(store, repo, [parseCommit(obj.data).tree])) held.add(o.oid);
      if (!shallowBoundaries.has(oid)) {
        for (const p of parseCommit(obj.data).parents) queue.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const o of collectReachable(store, repo, [oid])) held.add(o.oid);
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) queue.push(m[1] as string);
    }
  }
  return held;
}

/** All objects reachable from `tips` (commits, their trees/blobs, tags). */
export function collectReachable(store: Store, repo: Repo, tips: string[]): Array<{ type: GitObject['type']; data: Buffer; oid: string }> {
  const seen = new Set<string>();
  const out: Array<{ type: GitObject['type']; data: Buffer; oid: string }> = [];
  const queue = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.push({ type: obj.type, data: obj.data, oid });
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      queue.push(info.tree);
      for (const p of info.parents) queue.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) queue.push(e.oid);
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) queue.push(m[1] as string);
    }
  }
  return out;
}

/** Peel a tag object to the commit it points at (following tag chains). */
export function peelTag(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    const text = obj.data.toString('utf8');
    const m = /^object ([0-9a-f]{40})$/m.exec(text);
    if (!m) return cur;
    cur = m[1] as string;
  }
  return cur;
}

// ---------------------------------------------------------------- ref lists

export interface RefEntry {
  name: string;
  oid: string;
}

export function listRefs(repo: Repo): RefEntry[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  const refs = listRefs(repo);
  const caps = service === 'git-upload-pack'
    ? 'multi_ack_detailed no-done side-band-64k ofs-delta symref=HEAD:refs/heads/main agent=forge/1.0'
    : 'report-status report-status-v2 delete-refs side-band-64k ofs-delta symref=HEAD:refs/heads/main agent=forge/1.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, i) => {
      const extra = i === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${extra}\n`));
      const obj = repo.objects.get(ref.oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelTag(repo, ref.oid);
        if (peeled !== ref.oid) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((l) => pktLine(l)), FLUSH]);
}

// ---------------------------------------------------------------- handlers

export function handleInfoRefs(store: Store, repo: Repo | undefined, service: string, gitProtocol: string): { status: number; contentType: string; body: Buffer } {
  if (!repo) return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, service) };
  }
  if (gitProtocol === '2') {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, service) };
}

function sidebandPack(pack: Buffer): Buffer {
  // One sideband band-1 packet per chunk: a pkt-line is at most 65520
  // bytes total, so the payload (1 band byte + data) is at most 65516.
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; prefixes: string[] }): Buffer {
  const refs = listRefs(repo);
  const parts: Buffer[] = [];
  const headTarget = repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const wantHead = args.prefixes.length === 0 || args.prefixes.some((p) => 'HEAD'.startsWith(p) || p.startsWith('HEAD'));
  if (wantHead && args.symrefs && headTarget) {
    const target = `refs/heads/${repo.defaultBranch}`;
    parts.push(pktLine(`${headTarget} HEAD symref-target:${target}\n`));
  }
  for (const ref of refs) {
    if (args.prefixes.length > 0 && !args.prefixes.some((p) => ref.name.startsWith(p))) continue;
    let line = `${ref.oid} ${ref.name}`;
    const obj = repo.objects.get(ref.oid);
    if (args.peel && obj && obj.type === 'tag') {
      const peeled = peelTag(repo, ref.oid);
      if (peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function handleUploadPack(store: Store, repo: Repo, body: Buffer, gitProtocol: string): Buffer {
  if (gitProtocol === '2') return handleUploadPackV2(store, repo, body);
  return handleUploadPackV0(store, repo, body);
}

function handleUploadPackV2(store: Store, repo: Repo, body: Buffer): Buffer {
  const packets = parsePackets(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const command = lines[0]?.trim() ?? '';
  if (command.startsWith('command=ls-refs')) {
    const args = { peel: false, symrefs: false, prefixes: [] as string[] };
    for (const line of lines.slice(1)) {
      const t = line.trim();
      if (t === 'peel') args.peel = true;
      else if (t === 'symrefs') args.symrefs = true;
      else if (t.startsWith('ref-prefix ')) args.prefixes.push(t.slice('ref-prefix '.length).trim());
    }
    return lsRefsResponse(repo, args);
  }
  if (command.startsWith('command=fetch')) {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowLines: string[] = [];
    let depth: number | null = null;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('want ')) wants.push(t.slice(5).trim());
      else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t.startsWith('shallow ')) shallowLines.push(t.slice(8).trim());
      else if (t.startsWith('deepen ')) depth = parseInt(t.slice(7).trim(), 10);
    }
    const haveSet = new Set(haves);
    // Objects the client already has: reachable from its haves, stopping
    // at shallow boundaries (those ancestors were never sent to it).
    const haveReachable = collectHeld(store, repo, haves, new Set(shallowLines));
    let wanted: Array<{ type: GitObject['type']; data: Buffer; oid: string }> = [];
    let shallow: string[] = [];
    if (depth !== null && wants.length > 0) {
      // Depth-limited walk: keep only the newest `depth` generations.
      const keep = new Map<string, number>();
      const queue: Array<[string, number]> = wants.map((w) => [w, 1] as [string, number]);
      while (queue.length > 0) {
        const [oid, d] = queue.shift() as [string, number];
        if (keep.has(oid) || d > depth) continue;
        keep.set(oid, d);
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        const info = parseCommit(obj.data);
        for (const p of info.parents) queue.push([p, d + 1]);
      }
      // Objects belonging to kept commits only: each kept commit plus the
      // trees/blobs of its tree, never the parents beyond the depth.
      const keptCommits = [...keep.keys()];
      const seenDepth = new Set<string>();
      const fromKept: Array<{ type: GitObject['type']; data: Buffer; oid: string }> = [];
      const addTree = (treeOid: string): void => {
        const obj = repo.objects.get(treeOid);
        if (!obj || seenDepth.has(treeOid)) return;
        seenDepth.add(treeOid);
        fromKept.push({ type: obj.type, data: obj.data, oid: treeOid });
        if (obj.type === 'tree') {
          for (const e of parseTree(obj.data)) {
            const child = repo.objects.get(e.oid);
            if (!child) continue;
            if (child.type === 'tree') addTree(e.oid);
            else if (!seenDepth.has(e.oid)) {
              seenDepth.add(e.oid);
              fromKept.push({ type: child.type, data: child.data, oid: e.oid });
            }
          }
        }
      };
      for (const oid of keptCommits) {
        const obj = repo.objects.get(oid);
        if (!obj || seenDepth.has(oid)) continue;
        seenDepth.add(oid);
        fromKept.push({ type: obj.type, data: obj.data, oid });
        if (obj.type === 'commit') addTree(parseCommit(obj.data).tree);
      }
      wanted = fromKept.filter((o) => !haveReachable.has(o.oid));
      shallow = keptCommits.filter((oid) => {
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') return false;
        const info = parseCommit(obj.data);
        return info.parents.length > 0 && !info.parents.some((p) => keep.has(p));
      });
    } else {
      const all = collectReachable(store, repo, wants);
      wanted = all.filter((o) => !haveReachable.has(o.oid));
    }
    // If the client already has everything, still send an (empty) packfile
    // section: the client expects a pack when it asked for objects.
    const pack = buildPack(wanted);
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine(haves.length > 0 ? 'ready\n' : 'NAK\n'));
    parts.push(DELIM);
    if (depth !== null) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
      parts.push(DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    return Buffer.concat(parts);
  }
  return Buffer.concat([pktLine('error\n'), FLUSH]);
}

function handleUploadPackV0(store: Store, repo: Repo, body: Buffer): Buffer {
  const packets = parsePackets(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowLines: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0] as string);
    else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) shallowLines.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) depth = parseInt(t.slice(7).trim(), 10);
  }
  const haveReachable = collectHeld(store, repo, haves, new Set(shallowLines));
  const all = collectReachable(store, repo, wants);
  const wanted = all.filter((o) => !haveReachable.has(o.oid));
  const pack = buildPack(wanted);
  const parts: Buffer[] = [pktLine('NAK\n'), sidebandPack(pack)];
  void depth;
  return Buffer.concat(parts);
}

export function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  // Split the request at the first flush: commands, then the packfile.
  const packets = parsePackets(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packStart = -1;
  for (let i = 0; i < packets.length; i += 1) {
    const p = packets[i] as Packet;
    if (p.kind === 'flush') {
      packStart = i + 1;
      break;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').trim();
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (!m) continue;
    // First command line may carry capabilities after a NUL.
    let ref = m[3] as string;
    const nul = ref.indexOf('\0');
    if (nul >= 0) ref = ref.slice(0, nul);
    commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: ref.trim() });
  }
  // The packfile follows the flush as raw bytes (not pkt-lines). Re-derive
  // its offset by re-encoding the packets consumed so far.
  let consumed = 0;
  for (let i = 0; i < (packStart < 0 ? packets.length : packStart); i += 1) {
    const p = packets[i] as Packet;
    consumed += p.kind === 'data' ? p.payload.length + 4 : 4;
  }
  const packBuf = body.subarray(consumed);
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let parsed: Map<string, GitObject> = new Map();
  if (packBuf.length >= 12) {
    try {
      parsed = parsePack(packBuf, repo.objects);
    } catch {
      parsed = new Map();
    }
  }
  for (const [oid, obj] of parsed) {
    if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
  }
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      repo.refs.delete(cmd.ref);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (current !== ZERO_OID && !store.isAncestor(repo, current, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  const report = results
    .map((r) => (r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`))
    .join('');
  const payload = Buffer.concat([Buffer.from([1]), Buffer.from(`unpack ok\n${report}`, 'utf8')]);
  return Buffer.concat([pktLine(payload), FLUSH]);
}
