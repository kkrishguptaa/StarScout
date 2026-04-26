# StarScout Scoring Methods

StarScout uses two independent detection pipelines — **Simple Detector** and **Complex Detector** — each producing a label per user and an aggregate fake-star percentage per repository.

---

## User Scoring

### Label values

| Label | Meaning |
|---|---|
| `suspected-low_activity` | Matched the low-activity heuristic |
| `suspected-activity_cluster` | Matched the activity-cluster heuristic |
| `unknown` | Not flagged by either heuristic (treated as real) |

A user flagged by *either* heuristic is counted as a fake star.

---

### Heuristic 1 — Low Activity (Simple Detector)

Collected from GitHub event history (GH Archive or GitHub API `/users/{username}/events`).

| Signal | Suspicious threshold |
|---|---|
| `first_active == last_active` (`n_dates == 1`) | Active on exactly 1 calendar date |
| `n_repos <= 1` | Interacted with at most 1 repository |
| `n_orgs <= 1` | Interacted with at most 1 organization |
| `n_actions <= 2` | Total lifetime GitHub actions ≤ 2 |

**Rule:** a user is labelled `suspected-low_activity` when **all four** conditions are simultaneously true.

Source: `scripts/dagster/queries/stg_all_repos_with_low_activity_stars.sql`, `scripts/local/sql/dagster/stg_low_activity_stargazers.sql`

The `simple_detector.py` (MongoDB pipeline) applies a stricter variant that also checks profile fields retrieved via the GitHub API:

| Additional signal | Threshold |
|---|---|
| `followers` | < 2 |
| `following` | < 2 |
| `gists` | == 0 |
| `repos` | < 5 |
| `created_at` | after 2022-01-01 |
| `email` | empty string |
| `bio` | null or empty |
| `star_date == update_date == create_date` | all three on the same day |

Source: `scripts/dagster/simple_detector.py` (`_validate_star`)

---

### Heuristic 2 — Activity Cluster (Complex Detector)

Requires a pre-built list of **spammy repos** (see Repository Scoring below).

| Signal | Suspicious threshold |
|---|---|
| `n_spammy_repo_overlap` | ≥ 2 spammy repos interacted with |
| `p_spammy_repo_overlap` | > 50 % of the user's repos are spammy |
| `actions_per_repo` (`n / n_repos`) | < 2 actions per repo on average |

**Rule:** a user is labelled `suspected-activity_cluster` when **all three** conditions are simultaneously true.

Source: `scripts/dagster/queries/stargazer_summary.sql`

---

## Repository Scoring

### Per-repo fake-star statistics

After users are labelled, each repository receives the following aggregate metrics:

| Column | Definition |
|---|---|
| `total_stars` | Total stargazers in the analysis window |
| `n_fake_stars` | Stars from users labelled `suspected-*` |
| `n_low_activity` | Stars from `suspected-low_activity` users |
| `n_activity_cluster` | Stars from `suspected-activity_cluster` users |
| `real_stars` | Stars from `unknown` (real) users |
| `p_fake` | `n_fake_stars / total_stars × 100` |

Source: `scripts/dagster/queries/fake_star_stats.sql`, `scripts/dagster/complex_detector.py` (`dump_fake_star_data`)

---

### Identifying Spammy Repos (activity-cluster prerequisite)

Before the cluster heuristic can run, repos interacted with by the target repo's stargazers are ranked by how many of those same users also touched them.

**Step 1 — Repo overlap summary** (`stg_stargazer_repo_clusters.sql`)

For every repo touched by the set of stargazers, compute:

| Metric | Description |
|---|---|
| `n_actor_overlap` | Number of other stargazers who also interacted with this repo |
| `p_actor_overlap` | `n_actor_overlap / n_actors` for that repo |
| `actions_per_actor` | `n / n_actors` |

**Step 2 — Spammy-repo filter** (`stg_spammy_repos.sql`)

A repo is added to the spammy list when:

```
n_actor_overlap >= 4
OR (n_actor_overlap >= 3 AND p_actor_overlap >= 0.5)
```

Source: `scripts/dagster/queries/stg_spammy_repos.sql`

---

## End-to-End Data Flow

```
GH Archive / GitHub API
        │
        ▼
stg_all_actions_for_stargazers   ← all events for users who starred the target repo
        │
        ├──► stg_stargazer_overlap       ← per-user summary (n_repos, n_dates, n_orgs, …)
        │           │
        │           ├──► stg_stargazer_repo_clusters  ← per-repo overlap stats
        │           │           │
        │           │           └──► stg_spammy_repos  ← spammy repo list
        │           │
        │           └──► stargazer_summary   ← user labels (low_activity / activity_cluster)
        │                       │
        │                       └──► fake_star_stats   ← repo-level fake % summary
        │
        └──► (Simple Detector only)
             stg_all_repos_with_low_activity_stars
                     │
                     └──► stg_low_activity_stargazers  ← per-star low-activity flag
```

---

## GitHub API Fields Used

When scoring a single user without GH Archive data, these GitHub REST API endpoints supply the required signals:

| Endpoint | Signals derived |
|---|---|
| `GET /users/{username}` | `followers`, `following`, `public_gists`, `public_repos`, `created_at`, `updated_at`, `email`, `bio` |
| `GET /users/{username}/events` | `n_actions`, `n_dates`, `n_repos`, `n_orgs`, `actions_per_repo` |
| `GET /users/{username}/starred` | cross-reference against spammy-repo list for cluster heuristic |
