-- Source data for DuckDB: ~110k rows, written into a local file by
-- engines.e2e.test.tsx through the app's own driver.

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  email VARCHAR NOT NULL UNIQUE,
  full_name VARCHAR NOT NULL,
  country VARCHAR NOT NULL DEFAULT 'ID',
  tags VARCHAR[],
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'pending',
  placed_at TIMESTAMP NOT NULL,
  note VARCHAR
);

CREATE TABLE order_items (
  order_id BIGINT NOT NULL,
  line_no INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  unit_price DECIMAL(12, 2) NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

CREATE TABLE audit_log (
  logged_at TIMESTAMP NOT NULL,
  actor VARCHAR,
  message VARCHAR
);

CREATE TABLE type_zoo (
  id INTEGER PRIMARY KEY,
  txt VARCHAR,
  big BIGINT,
  hugeint_val HUGEINT,
  f DOUBLE,
  d DATE,
  bin BLOB,
  js JSON,
  u UUID,
  flag BOOLEAN
);

INSERT INTO customers
SELECT n, 'user' || n || '@example.com',
  CASE WHEN n % 50 = 0 THEN 'O''Brien \ "Junior" 🎉 ' || n ELSE 'Customer ' || n END,
  ['ID', 'SG', 'MY', 'US'][1 + n % 4],
  CASE WHEN n % 3 = 0 THEN NULL ELSE ['vip', 'tag,' || (n % 7), 'q"' || n] END,
  TIMESTAMP '2024-01-01 00:00:00' + to_minutes(n)
FROM range(1, 10001) t(n);

INSERT INTO orders
SELECT n, 1 + n % 10000, ['pending', 'paid', 'shipped', 'it''s complicated'][1 + n % 4],
  TIMESTAMP '2025-01-01' + to_seconds(n * 37),
  CASE WHEN n % 9 = 0 THEN 'line one' || chr(10) || 'line two' || chr(9) || 'tab' ELSE NULL END
FROM range(1, 30001) t(n);

INSERT INTO order_items
SELECT o, l, 1 + (o + l) % 5, round(((o + l) % 500) * 1.37 + 0.99, 2)
FROM range(1, 30001) a(o), range(1, 3) b(l);

INSERT INTO audit_log
SELECT TIMESTAMP '2025-01-01' + to_seconds(n), CASE WHEN n % 4 = 0 THEN NULL ELSE 'actor' || (n % 13) END, repeat('x', CAST(n % 40 AS INTEGER))
FROM range(1, 5001) t(n);

INSERT INTO type_zoo
SELECT n,
  CASE WHEN n % 2 = 0 THEN 'tab' || chr(9) || 'here ''quote'' \back ü 中文 ' || n ELSE NULL END,
  9007199254740993 + n,
  CAST(170141183460469231731687303715884105727 AS HUGEINT) - n,
  n / 3,
  DATE '2000-02-29' + CAST(n AS INTEGER),
  CASE WHEN n % 5 = 0 THEN NULL ELSE unhex(md5('zoo' || n) || '00ff') END,
  CASE n % 3 WHEN 0 THEN NULL WHEN 1 THEN '{"k": "it''s \\ \"q\""}' ELSE '[1, "two", null]' END,
  md5('u' || n)::UUID,
  CASE WHEN n % 3 = 0 THEN NULL ELSE n % 2 = 0 END
FROM range(1, 2001) t(n);

CREATE VIEW order_totals AS
SELECT order_id, sum(qty * unit_price) AS total FROM order_items GROUP BY order_id;
