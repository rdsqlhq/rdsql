-- Source data for SQLite: ~110k rows, written into a local file by
-- engines.e2e.test.tsx through the app's own driver.

CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'ID',
  score REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  status TEXT NOT NULL DEFAULT 'pending',
  placed_at TEXT NOT NULL,
  note TEXT
);

CREATE TABLE order_items (
  order_id INTEGER NOT NULL REFERENCES orders (id),
  line_no INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  unit_price NUMERIC NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

CREATE TABLE audit_log (
  at TEXT NOT NULL,
  actor TEXT,
  message TEXT
);

CREATE TABLE type_zoo (
  id INTEGER PRIMARY KEY,
  txt TEXT,
  big INTEGER,
  f REAL,
  bin BLOB,
  flag INTEGER
);

INSERT INTO customers (id, email, full_name, country, score, created_at)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 10000)
SELECT n, 'user' || n || '@example.com',
  CASE WHEN n % 50 = 0 THEN 'O''Brien \ "Junior" 🎉 ' || n ELSE 'Customer ' || n END,
  CASE n % 4 WHEN 0 THEN 'ID' WHEN 1 THEN 'SG' WHEN 2 THEN 'MY' ELSE 'US' END,
  CASE WHEN n % 10 = 0 THEN NULL ELSE n / 7.0 END,
  datetime('2024-01-01 00:00:00', '+' || n || ' minutes')
FROM s;

INSERT INTO orders (id, customer_id, status, placed_at, note)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 30000)
SELECT n, 1 + n % 10000, CASE n % 4 WHEN 0 THEN 'pending' WHEN 1 THEN 'paid' WHEN 2 THEN 'shipped' ELSE 'it''s complicated' END,
  datetime('2025-01-01', '+' || (n * 37) || ' seconds'),
  CASE WHEN n % 9 = 0 THEN 'line one' || char(10) || 'line two' || char(9) || 'tab' ELSE NULL END
FROM s;

INSERT INTO order_items (order_id, line_no, qty, unit_price)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 30000)
SELECT n, l, 1 + (n + l) % 5, round(((n + l) % 500) * 1.37 + 0.99, 2)
FROM s, (SELECT 1 AS l UNION ALL SELECT 2);

INSERT INTO audit_log (at, actor, message)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 5000)
SELECT datetime('2025-01-01', '+' || n || ' seconds'), CASE WHEN n % 4 = 0 THEN NULL ELSE 'actor' || (n % 13) END, substr('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 1, n % 40)
FROM s;

INSERT INTO type_zoo (id, txt, big, f, bin, flag)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 2000)
SELECT n,
  CASE WHEN n % 2 = 0 THEN 'tab' || char(9) || 'here ''quote'' \back ü 中文 ' || n ELSE NULL END,
  9007199254740993 + n,
  n / 3.0,
  CASE WHEN n % 5 = 0 THEN NULL WHEN n % 2 = 0 THEN x'00ff10' ELSE CAST('b' || n AS BLOB) END,
  CASE WHEN n % 3 = 0 THEN NULL ELSE n % 2 END
FROM s;

CREATE VIEW order_totals AS
SELECT order_id, sum(qty * unit_price) AS total FROM order_items GROUP BY order_id;
