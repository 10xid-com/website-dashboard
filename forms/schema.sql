-- Every enquiry the forms Worker accepts, saved before it is emailed.
-- Apply with: npx wrangler d1 execute client-forms --remote --file forms/schema.sql -c forms/wrangler.jsonc
CREATE TABLE IF NOT EXISTS submissions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site       TEXT NOT NULL,               -- the key in src/sites.js
  form       TEXT NOT NULL,
  page       TEXT,
  origin     TEXT NOT NULL,               -- https://<hostname> it came from
  live       INTEGER NOT NULL,            -- 1 = live site, 0 = staging
  email      TEXT,                        -- the visitor's, when they gave one
  fields     TEXT NOT NULL,               -- JSON [{label, value, type}]
  country    TEXT,
  user_agent TEXT,
  delivery   TEXT NOT NULL,               -- pending, sent or failed
  resend_id  TEXT,
  error      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS submissions_site ON submissions (site, created_at);
