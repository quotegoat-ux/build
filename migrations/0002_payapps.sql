CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  number TEXT NOT NULL DEFAULT '',
  gc_name TEXT NOT NULL DEFAULT '',
  gc_contact_email TEXT NOT NULL DEFAULT '',
  owner_name TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '' CHECK (state = '' OR (length(state) = 2 AND state = upper(state))),
  original_contract_cents INTEGER NOT NULL,
  retainage_work_bp INTEGER NOT NULL CHECK (retainage_work_bp BETWEEN 0 AND 10000),
  retainage_stored_bp INTEGER NOT NULL CHECK (retainage_stored_bp BETWEEN 0 AND 10000),
  first_furnished_on TEXT,
  last_furnished_on TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX projects_org_id ON projects(org_id);

CREATE TABLE change_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, number)
);
CREATE INDEX change_orders_org_id ON change_orders(org_id);

CREATE TABLE sov_lines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  item_no TEXT NOT NULL,
  description TEXT NOT NULL,
  scheduled_cents INTEGER NOT NULL,
  change_order_id TEXT UNIQUE REFERENCES change_orders(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sov_lines_org_id ON sov_lines(org_id);
CREATE INDEX sov_lines_project_id ON sov_lines(project_id, position);

CREATE TABLE pay_apps (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'paid')),
  retainage_work_bp INTEGER NOT NULL CHECK (retainage_work_bp BETWEEN 0 AND 10000),
  retainage_stored_bp INTEGER NOT NULL CHECK (retainage_stored_bp BETWEEN 0 AND 10000),
  submitted_at INTEGER,
  paid_at INTEGER,
  paid_cents INTEGER,
  share_token_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, number)
);
CREATE INDEX pay_apps_org_id ON pay_apps(org_id);
CREATE UNIQUE INDEX pay_apps_one_draft ON pay_apps(project_id) WHERE status = 'draft';

CREATE TABLE pay_app_lines (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  pay_app_id TEXT NOT NULL REFERENCES pay_apps(id) ON DELETE CASCADE,
  sov_line_id TEXT NOT NULL REFERENCES sov_lines(id) ON DELETE CASCADE,
  work_this_period_cents INTEGER NOT NULL DEFAULT 0,
  stored_to_date_cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pay_app_id, sov_line_id)
);
CREATE INDEX pay_app_lines_org_id ON pay_app_lines(org_id);
CREATE INDEX pay_app_lines_sov_line_id ON pay_app_lines(sov_line_id);
