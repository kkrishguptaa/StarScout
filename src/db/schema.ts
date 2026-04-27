import { int, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { relations } from 'drizzle-orm'

export const tokens = sqliteTable('tokens', {
  userId: text('user_id').primaryKey().notNull(),
  username: text('username').notNull().unique(),
  token: text('github_token').notNull().unique(),

  lastTokenUseAt: int('last_token_use_at', { mode: 'timestamp' }).notNull(),
})

export const repositories = sqliteTable(
  'repositories',
  {
    id: text('id').primaryKey().notNull(),

    owner: text('owner').notNull(),
    repo: text('repo').notNull(),

    n_stars: int('n_stars').notNull(),
    n_fake_stars: int('n_fake_stars').notNull(),
    n_low_activity: int('n_low_activity').notNull(),
    n_activity_cluster: int('n_activity_cluster').notNull(),

    score: int('score').notNull(),

    checkedAt: int('checked_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [uniqueIndex('repository_owner_repo_idx').on(t.owner, t.repo)],
)

export const stargazers = sqliteTable('stargazers', {
  username: text('username').primaryKey(),

  n_dates: int('n_dates').notNull(), // Distinct active dates
  n_repos: int('n_repos').notNull(), // Distinct repos interacted with
  n_orgs: int('n_orgs').notNull(), // Distinct orgs interacted with

  total_actions: int('total_actions').notNull(), // Total lifetime actions

  default_avatar: int('default_avatar', { mode: 'boolean' }).notNull(),
  has_organization: int('has_organization', { mode: 'boolean' }).notNull(),
  has_blog: int('has_blog', { mode: 'boolean' }).notNull(),
  has_company: int('has_company', { mode: 'boolean' }).notNull(),
  public_repos: int('public_repos').notNull(),
  followers: int('followers').notNull(),

  score: int('score').notNull(),

  account_created_at: int('account_created_at', { mode: 'timestamp' }).notNull(),

  checkedAt: int('checked_at', { mode: 'timestamp' }).notNull(),
})

export const stargazersToRepos = sqliteTable(
  'stargazers_to_repos',
  {
    stargazerUsername: text('stargazer_username')
      .notNull()
      .references(() => stargazers.username),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id),
  },
  (t) => [primaryKey({ columns: [t.stargazerUsername, t.repositoryId] })],
)

export const stargazersRelations = relations(stargazers, ({ many }) => ({
  stargazersToRepos: many(stargazersToRepos),
}))

export const repositoriesRelations = relations(repositories, ({ many }) => ({
  stargazersToRepos: many(stargazersToRepos),
}))

export const stargazersToReposRelations = relations(stargazersToRepos, ({ one }) => ({
  stargazer: one(stargazers, {
    fields: [stargazersToRepos.stargazerUsername],
    references: [stargazers.username],
  }),
  repository: one(repositories, {
    fields: [stargazersToRepos.repositoryId],
    references: [repositories.id],
  }),
}))
