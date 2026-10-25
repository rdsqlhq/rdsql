-- Postgres source for the backup e2e tests: an e-commerce shaped schema with
-- ~450k rows (~120 MB), plus one table holding every awkward column type.
-- Deterministic (no random()), so two seeded servers hold identical data.

CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled', 'it''s complicated');

CREATE TABLE customers (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  "fullName" text NOT NULL,
  country char(2) NOT NULL DEFAULT 'ID',
  tags text[],
  profile jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku varchar(32) NOT NULL UNIQUE,
  name text NOT NULL,
  price numeric(12, 2) NOT NULL,
  weight_kg double precision,
  active boolean NOT NULL DEFAULT true,
  attrs jsonb
);

CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES customers (id),
  status order_status NOT NULL DEFAULT 'pending',
  placed_at timestamp NOT NULL,
  ship_window tstzrange,
  note text
);

CREATE TABLE order_items (
  order_id bigint NOT NULL REFERENCES orders (id),
  line_no int NOT NULL,
  product_id bigint NOT NULL REFERENCES products (id),
  qty int NOT NULL,
  unit_price numeric(12, 2) NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

CREATE TABLE events (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  raw json,
  at timestamptz NOT NULL
);

-- No primary key: read with OFFSET paging.
CREATE TABLE audit_log (
  at timestamp NOT NULL,
  actor text,
  message text
);

-- One of every type the driver has to get right.
CREATE TABLE "TypeZoo" (
  id serial PRIMARY KEY,
  "MixedCase" text,
  status order_status,
  statuses order_status[],
  j_obj jsonb,
  j_scalar jsonb,
  j_plain json,
  bin bytea,
  dur interval,
  ip inet,
  net cidr,
  mac macaddr,
  money_val money,
  t_tz timetz,
  t time,
  d date,
  bits bit(4),
  vbits varbit(8),
  ints int[],
  texts text[],
  u uuid DEFAULT gen_random_uuid(),
  x xml,
  big bigint,
  num numeric,
  r real,
  f double precision,
  small smallint,
  flag boolean
);

INSERT INTO customers (email, "fullName", country, tags, profile, created_at)
SELECT
  'user' || g || '@example.com',
  CASE WHEN g % 50 = 0 THEN E'O''Brien \\ "Junior" 🎉 ' || g ELSE 'Customer ' || g END,
  (ARRAY['ID', 'SG', 'MY', 'US'])[1 + g % 4],
  CASE WHEN g % 3 = 0 THEN NULL ELSE ARRAY['vip', 'tag,' || (g % 7), 'q"' || g] END,
  jsonb_build_object('age', 18 + g % 60, 'newsletter', g % 2 = 0, 'addr', jsonb_build_object('city', 'City ' || g % 97)),
  timestamptz '2024-01-01 00:00:00+00' + (g || ' minutes')::interval
FROM generate_series(1, 20000) g;

INSERT INTO products (sku, name, price, weight_kg, active, attrs)
SELECT
  'SKU-' || lpad(g::text, 6, '0'),
  'Product ' || g,
  round((g % 500) * 1.37 + 0.99, 2),
  CASE WHEN g % 10 = 0 THEN NULL ELSE g / 13.0 END,
  g % 17 <> 0,
  CASE WHEN g % 4 = 0 THEN NULL ELSE jsonb_build_object('color', (ARRAY['red', 'blue', 'green'])[1 + g % 3], 'sizes', jsonb_build_array('S', 'M', 'L')) END
FROM generate_series(1, 2000) g;

INSERT INTO orders (customer_id, status, placed_at, ship_window, note)
SELECT
  1 + g % 20000,
  (ARRAY['pending', 'paid', 'shipped', 'cancelled', 'it''s complicated']::order_status[])[1 + g % 5],
  timestamp '2025-01-01' + (g * 37 || ' seconds')::interval,
  CASE WHEN g % 6 = 0 THEN NULL ELSE tstzrange(timestamptz '2025-02-01 00:00+00' + (g || ' hours')::interval, timestamptz '2025-02-03 00:00+00' + (g || ' hours')::interval) END,
  CASE WHEN g % 9 = 0 THEN E'line one\nline two\ttab' ELSE NULL END
FROM generate_series(1, 100000) g;

INSERT INTO order_items (order_id, line_no, product_id, qty, unit_price)
SELECT o, l, 1 + (o * 7 + l) % 2000, 1 + (o + l) % 5, round(((o + l) % 500) * 1.37 + 0.99, 2)
FROM generate_series(1, 100000) o, generate_series(1, 3) l;

INSERT INTO events (id, kind, payload, raw, at)
SELECT
  md5('event' || g)::uuid,
  (ARRAY['click', 'view', 'purchase'])[1 + g % 3],
  CASE g % 4
    WHEN 0 THEN '"a bare string"'::jsonb
    WHEN 1 THEN '12.5'::jsonb
    WHEN 2 THEN jsonb_build_array(g, 'two', NULL, jsonb_build_object('k', E'it''s \\ "quoted"'))
    ELSE jsonb_build_object('session', md5(g::text), 'path', '/p/' || g)
  END,
  CASE WHEN g % 5 = 0 THEN NULL ELSE '{"v": 1, "dup": 1, "dup": 2}'::json END,
  timestamptz '2025-06-01 00:00+00' + (g || ' seconds')::interval
FROM generate_series(1, 30000) g;

INSERT INTO audit_log (at, actor, message)
SELECT timestamp '2025-01-01' + (g || ' seconds')::interval, CASE WHEN g % 4 = 0 THEN NULL ELSE 'actor' || g % 13 END, repeat('x', g % 40)
FROM generate_series(1, 5000) g;

INSERT INTO "TypeZoo" ("MixedCase", status, statuses, j_obj, j_scalar, j_plain, bin, dur, ip, net, mac, money_val, t_tz, t, d, bits, vbits, ints, texts, x, big, num, r, f, small, flag)
SELECT
  CASE WHEN g % 2 = 0 THEN E'tab\there ''quote'' \\back ü 中文' ELSE NULL END,
  (ARRAY['paid', 'it''s complicated']::order_status[])[1 + g % 2],
  ARRAY['pending', 'it''s complicated']::order_status[],
  jsonb_build_object('n', g, 'arr', jsonb_build_array(1, NULL, 'x')),
  CASE WHEN g % 3 = 0 THEN 'null'::jsonb ELSE to_jsonb('str ' || g) END,
  '[1, 2, {"a": "b"}]'::json,
  CASE WHEN g % 5 = 0 THEN NULL ELSE decode(md5(g::text) || '00ff', 'hex') END,
  make_interval(years => g % 3, days => g % 30, secs => g % 60 + 0.25),
  ('10.' || g % 255 || '.0.1')::inet,
  ('10.' || g % 255 || '.0.0/16')::cidr,
  '08:00:2b:01:02:03'::macaddr,
  (g * 3.5)::numeric::money,
  '23:59:59.5+07'::timetz,
  '08:30:00'::time,
  date '2000-02-29' + g,
  (g % 16)::bit(4),
  (g % 256)::bit(8)::varbit,
  ARRAY[g, NULL, -g],
  ARRAY['a', E'b,"c', NULL, 'd}', ''],
  ('<row n="' || g || '">&amp;</row>')::xml,
  9007199254740993 + g,
  g / 7.0,
  (g / 3.0)::real,
  g / 3.0,
  (g % 32000)::smallint,
  CASE WHEN g % 3 = 0 THEN NULL ELSE g % 2 = 0 END
FROM generate_series(1, 10000) g;

-- Secondary objects a backup has to recreate: plain, partial, expression
-- and multi-column indexes, a CHECK constraint, and a UNIQUE constraint on
-- top of the ones (and the foreign keys) declared with the tables.
CREATE INDEX orders_customer_idx ON orders (customer_id);
CREATE INDEX orders_open_idx ON orders (placed_at) WHERE status = 'pending';
CREATE INDEX customers_email_lower_idx ON customers (lower(email));
CREATE INDEX order_items_product_qty_idx ON order_items (product_id, qty DESC);
ALTER TABLE products ADD CONSTRAINT products_price_positive CHECK (price > 0);
ALTER TABLE events ADD CONSTRAINT events_kind_at_key UNIQUE (kind, at);

-- Views are not backed up (only base tables); this one checks that.
CREATE VIEW order_totals AS
SELECT order_id, sum(qty * unit_price) AS total FROM order_items GROUP BY order_id;

ANALYZE;
