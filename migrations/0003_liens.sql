ALTER TABLE pay_apps ADD COLUMN is_final INTEGER NOT NULL DEFAULT 0 CHECK (is_final IN (0, 1));

CREATE TABLE lien_waivers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pay_app_id TEXT REFERENCES pay_apps(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('conditional_progress', 'unconditional_progress', 'conditional_final', 'unconditional_final')),
  state TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  through_date TEXT NOT NULL,
  exceptions_text TEXT NOT NULL DEFAULT '',
  -- values typed into the form's state-specific blanks, keyed by placeholder name
  fields_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'signed')),
  signer_name TEXT,
  signer_title TEXT,
  signed_at INTEGER,
  -- the filled form as signed, so later project or template edits cannot change a signed waiver
  signed_document TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (pay_app_id, kind)
);
CREATE INDEX lien_waivers_org_id ON lien_waivers(org_id);
CREATE INDEX lien_waivers_project_id ON lien_waivers(project_id);

CREATE TABLE sent_reminders (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  subject_key TEXT NOT NULL,
  due_on TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, subject_key, due_on)
);
