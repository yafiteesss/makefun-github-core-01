# forge — a standalone GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/yafiteesss/makefun-github-core-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/yafiteesss/makefun-github-core-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Entry for the [github-core-clone-01 bounty on make.fun](https://make.fun/bounty/github-core-clone-01) (referral code `tgs239he`).

One process, Node 22 standard library only, no UI, no git binary, no
outside service. It serves git smart HTTP (upload-pack v2, receive-pack
v0), the REST v3 API under `/api/v3`, GraphQL v4 at `/api/graphql` and an
MCP endpoint at `/mcp`, all from one in-memory store.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts
```

The trial sets `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN`; the program
binds an ephemeral port, registers it, and exits 0 when the suite says
done. Locally, grade it with the kit's conformance runner:

```sh
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:PORT --token test-token --perf
```

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, wait for done).
- `app.ts` — the HTTP router and auth.
- `store.ts` — the in-memory store: repos, git objects, issues, pull
  requests, and the token owner's login derived from the suite's fixed
  scenario seed.
- `git.ts` — pkt-line framing, packfile read/write, upload-pack v2 and
  receive-pack v0.
- `rest.ts` — REST v3 resources.
- `graphql.ts` — GraphQL v4 for the documents gh and github-mcp-server
  send.
- `mcp.ts` — MCP over Streamable HTTP (2026-07-28 discover, plus the
  legacy initialize handshake).
