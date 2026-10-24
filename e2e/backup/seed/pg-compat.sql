-- Source data for the Postgres-compatible servers (CockroachDB, YugabyteDB):
-- ~110k rows. Sticks to types both of them support.
-- Run by engines.e2e.test.tsx through the app's own driver.

CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'it''s complicated');

CREATE TABLE customers (
  id INT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  "fullName" TEXT NOT NULL,
  country CHAR(2) NOT NULL DEFAULT 'ID',
  tags TEXT[],
  profile JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers (id),
  status order_status NOT NULL DEFAULT 'pending',
  placed_at TIMESTAMP NOT NULL,
  note TEXT
);

CREATE TABLE order_items (
  order_id BIGINT NOT NULL REFERENCES orders (id),
  line_no INT NOT NULL,
  qty INT NOT NULL,
  unit_price NUMERIC(12, 2) NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

CREATE TABLE audit_log (
  at TIMESTAMP NOT NULL,
  actor TEXT,
  message TEXT
);

CREATE TABLE "TypeZoo" (
  id INT PRIMARY KEY,
  "MixedCase" TEXT,
  status order_status,
  j_obj JSONB,
  j_scalar JSONB,
  bin BYTEA,
  dur INTERVAL,
  ip INET,
  t_tz TIMETZ,
  d DATE,
  bits BIT(4),
  ints INT[],
  texts TEXT[],
  u UUID,
  big BIGINT,
  num NUMERIC,
  f DOUBLE PRECISION,
  flag BOOLEAN
);

INSERT INTO customers (id, email, "fullName", country, tags, profile, created_at)
SELECT g, 'user' || g::text || '@example.com',
  CASE WHEN g % 50 = 0 THEN e'O''Brien \\ "Junior" \U0001F389 ' || g::text ELSE 'Customer ' || g::text END,
  (ARRAY['ID', 'SG', 'MY', 'US'])[1 + g % 4],
  CASE WHEN g % 3 = 0 THEN NULL ELSE ARRAY['vip', 'tag,' || (g % 7)::text, 'q"' || g::text] END,
  jsonb_build_object('age', 18 + g % 60, 'newsletter', g % 2 = 0),
  TIMESTAMPTZ '2024-01-01 00:00:00+00' + (g::text || ' minutes')::INTERVAL
FROM generate_series(1, 10000) AS g;

INSERT INTO orders (id, customer_id, status, placed_at, note)
SELECT g, 1 + g % 10000, (ARRAY['pending', 'paid', 'shipped', 'it''s complicated'])[1 + g % 4]::order_status,
  TIMESTAMP '2025-01-01' + (g * 37)::text::INTERVAL,
  CASE WHEN g % 9 = 0 THEN e'line one\nline two\ttab' ELSE NULL END
FROM generate_series(1, 30000) AS g;

INSERT INTO order_items (order_id, line_no, qty, unit_price)
SELECT o, l, 1 + (o + l) % 5, round((((o + l) % 500) * 1.37 + 0.99)::NUMERIC, 2)
FROM generate_series(1, 30000) AS o, generate_series(1, 2) AS l;

INSERT INTO audit_log (at, actor, message)
SELECT TIMESTAMP '2025-01-01' + g::text::INTERVAL, CASE WHEN g % 4 = 0 THEN NULL ELSE 'actor' || (g % 13)::text END, repeat('x', g % 40)
FROM generate_series(1, 5000) AS g;

INSERT INTO "TypeZoo" (id, "MixedCase", status, j_obj, j_scalar, bin, dur, ip, t_tz, d, bits, ints, texts, u, big, num, f, flag)
SELECT g,
  CASE WHEN g % 2 = 0 THEN e'tab\there ''quote'' \\back ü 中文' ELSE NULL END,
  (ARRAY['paid', 'it''s complicated'])[1 + g % 2]::order_status,
  jsonb_build_object('n', g, 'arr', jsonb_build_array(1, NULL, 'x')),
  CASE WHEN g % 3 = 0 THEN 'null'::JSONB ELSE to_jsonb('str ' || g::text) END,
  CASE WHEN g % 5 = 0 THEN NULL ELSE decode(md5(g::text) || '00ff', 'hex') END,
  (g % 30)::text::INTERVAL * 86400 + '0.25 seconds'::INTERVAL,
  ('10.' || (g % 255)::text || '.0.1')::INET,
  '23:59:59.5+07'::TIMETZ,
  DATE '2000-02-29' + g,
  CASE g % 4 WHEN 0 THEN B'0000' WHEN 1 THEN B'0101' WHEN 2 THEN B'1010' ELSE B'1111' END,
  ARRAY[g, NULL, -g],
  ARRAY['a', e'b,"c', NULL, 'd}', ''],
  md5('zoo' || g::text)::UUID,
  9007199254740993 + g,
  g::NUMERIC / 7,
  g::FLOAT8 / 3,
  CASE WHEN g % 3 = 0 THEN NULL ELSE g % 2 = 0 END
FROM generate_series(1, 2000) AS g;

CREATE VIEW order_totals AS
SELECT order_id, sum(qty * unit_price) AS total FROM order_items GROUP BY order_id;
