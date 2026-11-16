-- 家計管理アプリの初期スキーマ。正本: docs/設計/データと照合.md §1
-- 子を持つ表は作り直さない(§1.1 の移行)。値が増えうる一覧は参照の表に置く。

-- §1.5 参照の表
CREATE TABLE payment_methods (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL,
  card_compatible INTEGER NOT NULL CHECK (card_compatible IN (0, 1)),
  statement_expected INTEGER NOT NULL CHECK (statement_expected IN (0, 1)),
  CHECK (statement_expected = 0 OR card_compatible = 1)
) STRICT;

CREATE TABLE expense_origins (code TEXT PRIMARY KEY) STRICT;
CREATE TABLE ai_read_states (code TEXT PRIMARY KEY) STRICT;
CREATE TABLE ai_error_kinds (code TEXT PRIMARY KEY) STRICT;

-- §1.2 利用者
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  created_at TEXT NOT NULL
) STRICT;

-- §1.3 費目
CREATE TABLE category_kinds (
  code TEXT PRIMARY KEY
) STRICT;

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  sort_order INTEGER NOT NULL,
  retired_at TEXT,
  kind TEXT NOT NULL REFERENCES category_kinds(code)
) STRICT;

CREATE TABLE system_categories (
  role TEXT PRIMARY KEY CHECK (role IN ('uncategorized')),
  category_id INTEGER NOT NULL UNIQUE REFERENCES categories(id)
) STRICT;

-- §1.4 予算
CREATE TABLE budgets (
  category_id INTEGER NOT NULL REFERENCES categories(id),
  from_month TEXT NOT NULL CHECK (date(from_month || '-01') IS from_month || '-01'),
  amount INTEGER CHECK (amount IS NULL OR amount >= 0),
  PRIMARY KEY (category_id, from_month)
) STRICT;

-- §1.7 レシート
CREATE TABLE receipts (
  id INTEGER PRIMARY KEY,
  client_request_id TEXT NOT NULL UNIQUE,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL,
  first_saved_at TEXT,
  ai_status TEXT NOT NULL REFERENCES ai_read_states(code),
  ai_attempt INTEGER NOT NULL CHECK (ai_attempt >= 1),
  ai_requested_at TEXT NOT NULL,
  ai_result TEXT CHECK ((ai_status = 'read') = (ai_result IS NOT NULL)),
  ai_error_kind TEXT REFERENCES ai_error_kinds(code)
    CHECK ((ai_status = 'failed') = (ai_error_kind IS NOT NULL)),
  ai_model TEXT
) STRICT;

CREATE TABLE receipt_images (
  id INTEGER PRIMARY KEY,
  receipt_id INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  stored_at TEXT,
  UNIQUE (receipt_id, position)
) STRICT;

-- §1.8 明細の取り込み
CREATE TABLE statement_imports (
  id INTEGER PRIMARY KEY,
  client_request_id TEXT NOT NULL UNIQUE,
  billing_month TEXT NOT NULL CHECK (date(billing_month || '-01') IS billing_month || '-01'),
  imported_by INTEGER NOT NULL REFERENCES users(id),
  imported_at TEXT NOT NULL,
  rows_in_file INTEGER NOT NULL,
  rows_new INTEGER NOT NULL,
  rows_changed INTEGER NOT NULL,
  rows_missing INTEGER NOT NULL
) STRICT;

-- §1.14 在庫を数える品物(品目が指すので、品目より前に作る)
CREATE TABLE stock_items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  notify_days INTEGER NOT NULL CHECK (notify_days BETWEEN 0 AND 365),
  retired_at TEXT,
  alerted_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
) STRICT;

-- §1.6 支出
CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL REFERENCES expense_origins(code),
  client_request_id TEXT NOT NULL UNIQUE,
  receipt_id INTEGER UNIQUE REFERENCES receipts(id)
    CHECK (receipt_id IS NULL OR origin = 'person'),
  fee_charge_id INTEGER UNIQUE REFERENCES card_charges(id),
  spent_on TEXT NOT NULL CHECK (date(spent_on) IS spent_on),
  store_name TEXT NOT NULL,
  payment_method TEXT NOT NULL REFERENCES payment_methods(code),
  registered_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((origin = 'statement_fee') = (fee_charge_id IS NOT NULL)),
  UNIQUE (id, origin)
) STRICT;
CREATE INDEX expenses_spent_on ON expenses(spent_on);

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  tax_rate INTEGER CHECK (tax_rate IS NULL OR tax_rate IN (0, 8, 10)),
  base_amount INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  stock_item_id INTEGER REFERENCES stock_items(id),
  stock_quantity INTEGER
    CHECK ((stock_item_id IS NULL) = (stock_quantity IS NULL))
    CHECK (stock_quantity IS NULL OR stock_quantity >= 1),
  UNIQUE (expense_id, position)
) STRICT;
CREATE INDEX items_category_id ON items(category_id);
CREATE INDEX items_stock_item_id ON items(stock_item_id) WHERE stock_item_id IS NOT NULL;

CREATE TABLE expense_adjustments (
  id INTEGER PRIMARY KEY,
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('discount', 'tax')),
  amount INTEGER NOT NULL CHECK (amount <> 0),
  tax_rate INTEGER CHECK (tax_rate IS NULL OR tax_rate IN (0, 8, 10))
) STRICT;
CREATE INDEX expense_adjustments_expense_id ON expense_adjustments(expense_id);

-- §1.9 カードの支払いの記録
CREATE TABLE card_charges (
  id INTEGER PRIMARY KEY,
  import_id INTEGER NOT NULL REFERENCES statement_imports(id),
  billing_month TEXT NOT NULL CHECK (date(billing_month || '-01') IS billing_month || '-01'),
  used_on TEXT NOT NULL CHECK (date(used_on) IS used_on),
  merchant TEXT NOT NULL,
  card_user TEXT NOT NULL,
  payment_type TEXT NOT NULL,
  amount_cell TEXT NOT NULL,
  amount INTEGER CHECK ((amount_cell = '-' AND amount IS NULL)
    OR (amount IS NOT NULL AND CAST(amount AS TEXT) = amount_cell)),
  fee INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  expense_id INTEGER,
  expense_origin TEXT
    CHECK ((expense_id IS NULL) = (expense_origin IS NULL))
    CHECK (expense_origin IS NULL OR expense_origin <> 'statement_fee'),
  FOREIGN KEY (expense_id, expense_origin) REFERENCES expenses(id, origin) ON DELETE SET NULL,
  CHECK (amount IS NOT NULL OR expense_id IS NULL),
  UNIQUE (billing_month, used_on, merchant, card_user, amount_cell, ordinal)
) STRICT;
CREATE UNIQUE INDEX card_charges_one_row_per_statement_purchase
  ON card_charges(expense_id) WHERE expense_origin = 'statement_purchase';
CREATE INDEX card_charges_used_on ON card_charges(used_on);
CREATE INDEX card_charges_expense_id ON card_charges(expense_id);

-- §1.10〜1.12 人の判断の記録
CREATE TABLE match_rejections (
  card_charge_id INTEGER NOT NULL REFERENCES card_charges(id),
  expense_id INTEGER NOT NULL,
  expense_origin TEXT NOT NULL DEFAULT 'person' CHECK (expense_origin = 'person'),
  rejected_by INTEGER NOT NULL REFERENCES users(id),
  rejected_at TEXT NOT NULL,
  FOREIGN KEY (expense_id, expense_origin) REFERENCES expenses(id, origin) ON DELETE CASCADE,
  PRIMARY KEY (card_charge_id, expense_id)
) STRICT;
CREATE INDEX match_rejections_expense_id ON match_rejections(expense_id);

CREATE TABLE no_statement_acks (
  expense_id INTEGER PRIMARY KEY,
  expense_origin TEXT NOT NULL DEFAULT 'person' CHECK (expense_origin = 'person'),
  acked_by INTEGER NOT NULL REFERENCES users(id),
  acked_at TEXT NOT NULL,
  FOREIGN KEY (expense_id, expense_origin) REFERENCES expenses(id, origin) ON DELETE CASCADE
) STRICT;

CREATE TABLE diff_acks (
  expense_id INTEGER PRIMARY KEY,
  expense_origin TEXT NOT NULL DEFAULT 'person' CHECK (expense_origin = 'person'),
  accepted_diff INTEGER NOT NULL CHECK (accepted_diff <> 0),
  acked_by INTEGER NOT NULL REFERENCES users(id),
  acked_at TEXT NOT NULL,
  FOREIGN KEY (expense_id, expense_origin) REFERENCES expenses(id, origin) ON DELETE CASCADE
) STRICT;

-- §1.15 在庫の動きのうち人が押したもの(買って増えた分は items.stock_quantity が持つ)
CREATE TABLE stock_moves (
  id INTEGER PRIMARY KEY,
  stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
  kind TEXT NOT NULL CHECK (kind IN ('use', 'count')),
  delta INTEGER NOT NULL,
  counted INTEGER CHECK ((kind = 'use' AND delta = -1 AND counted IS NULL)
    OR (kind = 'count' AND counted IS NOT NULL AND counted >= 0)),
  moved_by INTEGER NOT NULL REFERENCES users(id),
  moved_at TEXT NOT NULL
) STRICT;
CREATE INDEX stock_moves_item_kind_moved_at ON stock_moves(stock_item_id, kind, moved_at);

-- §1.16 通知の宛先
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE CHECK (endpoint LIKE 'https://%'),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- §1.13 規則が指す費目を守る
CREATE TRIGGER system_category_not_retired
BEFORE UPDATE OF retired_at ON categories
WHEN NEW.retired_at IS NOT NULL
 AND EXISTS (SELECT 1 FROM system_categories WHERE category_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'system category cannot be retired'); END;

CREATE TRIGGER system_categories_no_update
BEFORE UPDATE ON system_categories
BEGIN SELECT RAISE(ABORT, 'system_categories is fixed'); END;

CREATE TRIGGER system_categories_no_delete
BEFORE DELETE ON system_categories
BEGIN SELECT RAISE(ABORT, 'system_categories is fixed'); END;

-- 初期データ
INSERT INTO payment_methods (code, label, sort_order, card_compatible, statement_expected) VALUES
  ('rakuten_card', '楽天カード', 1, 1, 1),
  ('credit', 'クレジット(どのカードか不明)', 2, 1, 1),
  ('unknown', '不明', 3, 1, 0),
  ('other_card', '他のカード', 4, 0, 0),
  ('cash', '現金', 5, 0, 0),
  ('emoney', '電子マネー', 6, 0, 0),
  ('point', 'ポイント', 7, 0, 0),
  ('other', 'その他', 8, 0, 0);

INSERT INTO expense_origins (code) VALUES ('person'), ('statement_purchase'), ('statement_fee');
INSERT INTO ai_read_states (code) VALUES ('waiting'), ('read'), ('failed');
INSERT INTO ai_error_kinds (code) VALUES ('invalid_output'), ('quota'), ('timeout'), ('other');

INSERT INTO category_kinds (code) VALUES ('variable'), ('fixed'), ('extra');

INSERT INTO categories (id, name, sort_order, kind) VALUES
  (1, '食費', 1, 'variable'),
  (2, '外食', 2, 'variable'),
  (3, '日用品', 3, 'variable'),
  (4, '家賃', 4, 'fixed'),
  (5, '水道・光熱', 5, 'variable'),
  (6, '通信', 6, 'fixed'),
  (7, '交通', 7, 'variable'),
  (8, '医療', 8, 'variable'),
  (9, '衣服・美容', 9, 'variable'),
  (10, '趣味・娯楽', 10, 'variable'),
  (11, '教育', 11, 'variable'),
  (12, '交際', 12, 'variable'),
  (13, 'その他', 13, 'variable'),
  (14, '旅行', 14, 'extra'),
  (15, '引っ越し', 15, 'extra'),
  (16, '結婚', 16, 'extra'),
  (17, '家電', 17, 'extra'),
  (18, '臨時その他', 18, 'extra'),
  (19, '未分類', 19, 'variable');

INSERT INTO system_categories (role, category_id) VALUES ('uncategorized', 19);
