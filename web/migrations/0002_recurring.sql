-- 毎月決まった支出(docs/設計/データと照合.md §1.17・表 Q)。子を持つ表(expenses)には ADD COLUMN だけ(§1.1)

CREATE TABLE recurring_expenses (
  id INTEGER PRIMARY KEY,
  client_request_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL REFERENCES payment_methods(code),
  day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  next_on TEXT NOT NULL CHECK (date(next_on) IS next_on),
  ended_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

ALTER TABLE expenses ADD COLUMN recurring_id INTEGER REFERENCES recurring_expenses(id);
CREATE INDEX expenses_recurring_id ON expenses(recurring_id) WHERE recurring_id IS NOT NULL;

-- 止めていない登録が指す費目はやめられない(§1.13 と同じ守り)。未分類(system_categories)は system_category_not_retired が断る
-- (SQLite は後に作ったトリガーを先に動かすので、ここで外して結果を 1 つにする = 優先は system_category)
CREATE TRIGGER recurring_category_not_retired
BEFORE UPDATE OF retired_at ON categories
WHEN NEW.retired_at IS NOT NULL
 AND EXISTS (SELECT 1 FROM recurring_expenses WHERE category_id = NEW.id AND ended_at IS NULL)
 AND NOT EXISTS (SELECT 1 FROM system_categories WHERE category_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'category used by recurring expense'); END;

-- 逆向き: やめた費目で登録する・直すことも止める(口の読んでから書くの間に費目がやめられても、止めていない登録がやめた費目を指さない)
CREATE TRIGGER recurring_category_active_on_insert
BEFORE INSERT ON recurring_expenses
WHEN (SELECT retired_at FROM categories WHERE id = NEW.category_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'recurring expense category retired'); END;

CREATE TRIGGER recurring_category_active_on_update
BEFORE UPDATE OF category_id, ended_at ON recurring_expenses
WHEN NEW.ended_at IS NULL AND (SELECT retired_at FROM categories WHERE id = NEW.category_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'recurring expense category retired'); END;

-- 家賃などの引き落とし(現金の次に並べる)
UPDATE payment_methods SET sort_order = sort_order + 1 WHERE sort_order >= 6;
INSERT INTO payment_methods (code, label, sort_order, card_compatible, statement_expected) VALUES ('bank_transfer', '口座振替', 6, 0, 0);
