# Agent Handoff: Implement Heuristics & Scoring in TypeScript

This document gives a complete, self-contained specification for implementing the StarScout heuristics and scoring pipeline entirely in TypeScript. Read it top-to-bottom before writing any code.

---

## 1. What You Are Building

A TypeScript module (`src/scorer/`) that:

1. Fetches a GitHub repository's stargazers via the GitHub REST API.
2. Fetches each stargazer's public event history via the GitHub REST API.
3. Labels every stargazer as `suspected-low_activity`, `suspected-activity_cluster`, or `unknown` using two heuristics.
4. Computes per-user and per-repository scores.
5. Upserts the results into the SQLite database managed by Drizzle ORM.

There is no BigQuery, MongoDB, or Python dependency. Everything runs locally against the GitHub API and the existing SQLite database.

---

## 2. Project Setup

### Runtime and tooling

| Item | Value |
|---|---|
| Language | TypeScript (strict mode) |
| Target | ES2022, `module: Node16` |
| Source root | `src/` |
| Build command | `tsc --noEmit` (type-check only; no build step required) |
| Database | SQLite via Drizzle ORM + `better-sqlite3` |
| Schema file | `src/db/schema.ts` |
| Drizzle config | `drizzle.config.ts` (dialect: sqlite, schema: `./src/db/schema.ts`) |

### Generating and applying the schema migration

```bash
npm run db:generate   # generates SQL migration in /drizzle
npm run db:migrate    # applies it to sqlite.db (created at project root)
```

Run these once before executing any scoring code.

### GitHub authentication

Tokens are stored in `tokens` table (see schema below). Your code must rotate across all available tokens to stay within the 5 000 req/hr per-token rate limit.

---

## 3. Database Schema

> Source: `src/db/schema.ts`

```
tokens
  userId         TEXT  PK
  username       TEXT  UNIQUE
  githubToken    TEXT  UNIQUE
  lastTokenUseAt INT   (Unix timestamp)

repositories
  id             TEXT  PK             — GitHub repo node ID (GraphQL)
  owner          TEXT
  repo           TEXT
  n_stars        INT   — total stargazers in analysis window
  n_fake_stars   INT   — |low_activity ∪ activity_cluster| (union, not sum)
  n_low_activity INT   — stars from suspected-low_activity users
  n_activity_cluster INT — stars from suspected-activity_cluster users
  score          INT   — 0–100, see §6
  checkedAt      INT   (Unix timestamp)
  UNIQUE (owner, repo)

stargazers
  username            TEXT  PK
  n_dates             INT   — distinct calendar dates with any activity
  n_repos             INT   — distinct repos interacted with
  n_orgs              INT   — distinct orgs interacted with
  total_actions       INT   — total lifetime GitHub events
  default_avatar      BOOL
  has_organization    BOOL
  has_blog            BOOL
  has_company         BOOL
  public_repos        INT
  followers           INT
  score               INT   — 0 or 100; see §5
  account_created_at  INT   (Unix timestamp)
  checkedAt           INT   (Unix timestamp)

stargazers_to_repos
  stargazer_username  TEXT  FK → stargazers.username
  repository_id       TEXT  FK → repositories.id
  PRIMARY KEY (stargazer_username, repository_id)
```

---

## 4. Heuristic 1 — Low Activity

> Source spec: `docs/scoring-methods.md` §Heuristic 1, `scripts/local/sql/dagster/stg_all_repos_with_low_activity_stars.sql`

### Signals required

Fetch `GET /users/{username}/events` (paginate up to 300 events maximum). From those events derive:

| Signal | How to compute |
|---|---|
| `n_dates` | `new Set(events.map(e => e.created_at.slice(0, 10))).size` |
| `n_repos` | `new Set(events.map(e => e.repo?.name).filter(Boolean)).size` |
| `n_orgs` | `new Set(events.map(e => e.org?.login).filter(Boolean)).size` |
| `total_actions` | `events.length` |

### Rule

A user is labelled **`suspected-low_activity`** when **all four** are simultaneously true:

```
n_dates        === 1
n_repos        <= 1
n_orgs         <= 1
total_actions  <= 2
```

### Additional profile signals (stored but not gating)

Fetch `GET /users/{username}` and store in `stargazers`:

| Field | Column |
|---|---|
| `avatar_url` contains `gravatar` or is the default | `default_avatar` |
| `organizations_url` non-empty membership | `has_organization` |
| `blog` non-empty | `has_blog` |
| `company` non-empty | `has_company` |
| `public_repos` | `public_repos` |
| `followers` | `followers` |
| `created_at` | `account_created_at` |

These are stored for future use and display; they do **not** affect the label from Heuristic 1 in this implementation.

---

## 5. Heuristic 2 — Activity Cluster

> Source spec: `docs/scoring-methods.md` §Heuristic 2, `scripts/dagster/queries/stargazer_summary.sql`, `scripts/dagster/queries/stg_spammy_repos.sql`, `scripts/dagster/queries/stg_stargazer_repo_clusters.sql`

This heuristic requires building a **spammy-repo list** first, then scoring each user against it.

### Step A — Build the spammy-repo list

For the target repository `owner/repo`:

1. Collect the full stargazer list (`GET /repos/{owner}/{repo}/stargazers`, paginate).
2. For each stargazer, collect `GET /users/{username}/starred` (paginate, cap at 500 repos).
3. Build a frequency map: `repoOverlap: Map<string, number>` — how many of the target repo's stargazers also starred each other repo.
4. Compute per-repo statistics:

   ```
   n_actor_overlap  = repoOverlap.get(otherRepo)
   p_actor_overlap  = n_actor_overlap / totalStargazers
   actions_per_actor = (total events on that repo by those actors) / n_actor_overlap
   ```

5. A repo is **spammy** when:

   ```
   n_actor_overlap >= 4
   OR (n_actor_overlap >= 3 AND p_actor_overlap >= 0.5)
   ```

   > Source: `scripts/dagster/queries/stg_spammy_repos.sql`

### Step B — Label each stargazer

For each stargazer, from the same `GET /users/{username}/starred` data:

| Signal | Definition |
|---|---|
| `n_spammy_repo_overlap` | count of spammy repos in user's starred list |
| `p_spammy_repo_overlap` | `n_spammy_repo_overlap / user's total starred repos` |
| `actions_per_repo` | `total_actions / n_repos` |

A user is labelled **`suspected-activity_cluster`** when **all three** are simultaneously true:

```
n_spammy_repo_overlap  >= 2
p_spammy_repo_overlap  >  0.5
actions_per_repo       <  2
```

> Source: `scripts/dagster/queries/stargazer_summary.sql`

---

## 6. Scoring Formulas

### Per-user score

```
score = (label === 'unknown') ? 100 : 0
```

Store as the `stargazers.score` integer.

### Per-repository score

```
n_low_activity      = count of stargazers labelled suspected-low_activity
n_activity_cluster  = count of stargazers labelled suspected-activity_cluster
n_fake_stars        = |set(low_activity_users) ∪ set(cluster_users)|   // union, not sum
score               = Math.round((1 - n_fake_stars / n_stars) * 100)   // clamp to [0, 100]
```

> **Important:** a user flagged by both heuristics counts **once** in `n_fake_stars`. Use a `Set<string>` of usernames to compute the union before counting.

---

## 7. GitHub API Reference

All endpoints are under `https://api.github.com`. Send `Authorization: Bearer {token}` and `Accept: application/vnd.github+json` on every request.

| What you need | Endpoint | Pagination |
|---|---|---|
| Stargazers list | `GET /repos/{owner}/{repo}/stargazers` | Link header, 100/page |
| User profile | `GET /users/{username}` | None |
| User events | `GET /users/{username}/events` | page param, 100/page, max 10 pages |
| User starred repos | `GET /users/{username}/starred` | Link header, 100/page |
| Repo node ID | `GET /repos/{owner}/{repo}` → `.node_id` | None |

### Rate limiting

- 5 000 requests per token per hour.
- Read remaining quota from `X-RateLimit-Remaining` response header.
- When `X-RateLimit-Remaining < 10`, switch to the next token (round-robin across `tokens` table).
- Update `tokens.lastTokenUseAt` each time a token is used.
- If all tokens are exhausted, wait until `X-RateLimit-Reset` (Unix timestamp in response header).

---

## 8. File Structure to Create

```
src/
  db/
    schema.ts          ← already exists, do not modify
    index.ts           ← export a configured drizzle db instance (create this)
  scorer/
    index.ts           ← public entry point: scoreRepository(owner, repo)
    github.ts          ← GitHub API client with token rotation
    heuristics.ts      ← labelStargazer(events, profile, spammyRepos) → label
    spammy-repos.ts    ← buildSpammyRepoList(stargazers) → Set<string>
    score.ts           ← computeRepoScore(labelledStargazers) → RepoScoreResult
    upsert.ts          ← write stargazers + repository row to SQLite via Drizzle
    types.ts           ← shared TypeScript interfaces
```

### `src/db/index.ts` (example pattern)

```ts
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

const sqlite = new Database('sqlite.db')
export const db = drizzle(sqlite, { schema })
```

### `src/scorer/types.ts` (key interfaces)

```ts
export type StargazerLabel =
  | 'suspected-low_activity'
  | 'suspected-activity_cluster'
  | 'unknown'

export interface StargazerSignals {
  username: string
  n_dates: number
  n_repos: number
  n_orgs: number
  total_actions: number
  default_avatar: boolean
  has_organization: boolean
  has_blog: boolean
  has_company: boolean
  public_repos: number
  followers: number
  account_created_at: Date
}

export interface LabelledStargazer extends StargazerSignals {
  label: StargazerLabel
}

export interface RepoScoreResult {
  n_stars: number
  n_fake_stars: number
  n_low_activity: number
  n_activity_cluster: number
  score: number
}
```

---

## 9. Drizzle Upsert Pattern

Use Drizzle's `insert(...).onConflictDoUpdate(...)` for idempotent writes.

```ts
import { db } from '../db'
import { stargazers, repositories, stargazersToRepos } from '../db/schema'

// Upsert a stargazer
await db.insert(stargazers).values({
  username,
  n_dates, n_repos, n_orgs, total_actions,
  default_avatar, has_organization, has_blog, has_company,
  public_repos, followers, score,
  account_created_at,
  checkedAt: new Date(),
}).onConflictDoUpdate({
  target: stargazers.username,
  set: { n_dates, score, checkedAt: new Date(), /* ...rest */ },
})

// Upsert a repository
await db.insert(repositories).values({
  id,         // GitHub node ID from GET /repos/{owner}/{repo}
  owner, repo,
  n_stars, n_fake_stars, n_low_activity, n_activity_cluster, score,
  checkedAt: new Date(),
}).onConflictDoUpdate({
  target: [repositories.owner, repositories.repo],
  set: { n_stars, n_fake_stars, score, checkedAt: new Date(), /* ...rest */ },
})

// Link stargazer to repository (ignore duplicates)
await db.insert(stargazersToRepos).values({
  stargazerUsername: username,
  repositoryId: id,
}).onConflictDoNothing()
```

---

## 10. End-to-End Flow

```
scoreRepository(owner, repo)
  │
  ├─ 1. GET /repos/{owner}/{repo}           → repoNodeId, n_stars_current
  │
  ├─ 2. GET /repos/{owner}/{repo}/stargazers (paginate)
  │       → stargazerUsernames[]
  │
  ├─ 3. For each stargazer (batch, respect rate limit):
  │       GET /users/{username}             → profile fields
  │       GET /users/{username}/events      → events[]
  │       GET /users/{username}/starred     → starredRepos[]
  │       → StargazerSignals
  │
  ├─ 4. buildSpammyRepoList(allStargazersStarredRepos)
  │       → spammyRepos: Set<string>
  │
  ├─ 5. labelStargazer(signals, spammyRepos)  for each stargazer
  │       → LabelledStargazer[]
  │
  ├─ 6. computeRepoScore(labelledStargazers)
  │       → RepoScoreResult
  │
  └─ 7. upsert all stargazers + repository row + join rows into SQLite
```

---

## 11. Key Constants

All thresholds are defined in `scripts/__init__.py` for the Python pipeline. Mirror these exactly in TypeScript:

| Constant | Value | Used in |
|---|---|---|
| Low-activity: `n_dates` | `=== 1` | Heuristic 1 |
| Low-activity: `n_repos` | `<= 1` | Heuristic 1 |
| Low-activity: `n_orgs` | `<= 1` | Heuristic 1 |
| Low-activity: `total_actions` | `<= 2` | Heuristic 1 |
| Spammy repo: `n_actor_overlap` strong | `>= 4` | Heuristic 2 step A |
| Spammy repo: `n_actor_overlap` weak | `>= 3` | Heuristic 2 step A |
| Spammy repo: `p_actor_overlap` weak | `>= 0.5` | Heuristic 2 step A |
| Cluster user: `n_spammy_repo_overlap` | `>= 2` | Heuristic 2 step B |
| Cluster user: `p_spammy_repo_overlap` | `> 0.5` | Heuristic 2 step B |
| Cluster user: `actions_per_repo` | `< 2` | Heuristic 2 step B |

---

## 12. Checklist for the Implementing Agent

- [ ] `src/db/index.ts` — drizzle instance pointing at `sqlite.db`
- [ ] `src/scorer/types.ts` — `StargazerLabel`, `StargazerSignals`, `LabelledStargazer`, `RepoScoreResult`
- [ ] `src/scorer/github.ts` — `GitHubClient` class with token rotation, typed response methods for each endpoint in §7
- [ ] `src/scorer/heuristics.ts` — `labelStargazer()` implementing §4 and §5
- [ ] `src/scorer/spammy-repos.ts` — `buildSpammyRepoList()` implementing §5 Step A
- [ ] `src/scorer/score.ts` — `computeRepoScore()` implementing §6
- [ ] `src/scorer/upsert.ts` — Drizzle upsert functions from §9
- [ ] `src/scorer/index.ts` — `scoreRepository(owner, repo)` orchestrating §10
- [ ] Run `npm run db:generate && npm run db:migrate` before first execution
- [ ] Run `npm run typecheck` — zero type errors required
