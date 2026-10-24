-- MySQL / MariaDB source for the backup e2e tests (the same file seeds both):
-- an e-commerce shaped schema with ~450k rows, plus one table holding every
-- awkward column type. Deterministic, so two seeded servers hold identical data.
-- Numbers come from a digits cross join rather than a recursive CTE, which
-- would need a different recursion-limit setting on each server.

SET NAMES utf8mb4;
ALTER DATABASE rdsql_src CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE rdsql_src;

CREATE TABLE digits (d INT PRIMARY KEY);
INSERT INTO digits VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9);
CREATE TABLE seq (n INT PRIMARY KEY);
INSERT INTO seq
SELECT 1 + a.d + 10 * b.d + 100 * c.d + 1000 * e.d + 10000 * f.d + 100000 * g.d
FROM digits a, digits b, digits c, digits e, digits f, digits g;

CREATE TABLE customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  full_name VARCHAR(255) NOT NULL,
  country CHAR(2) NOT NULL DEFAULT 'ID',
  profile JSON,
  created_at DATETIME(6) NOT NULL
);

CREATE TABLE products (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  price DECIMAL(12, 2) NOT NULL,
  weight_kg DOUBLE,
  active TINYINT(1) NOT NULL DEFAULT 1
);

CREATE TABLE orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  status ENUM('pending', 'paid', 'shipped', 'cancelled', 'it''s complicated') NOT NULL DEFAULT 'pending',
  placed_at DATETIME NOT NULL,
  note TEXT,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
);

CREATE TABLE order_items (
  order_id BIGINT NOT NULL,
  line_no INT NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  qty INT NOT NULL,
  unit_price DECIMAL(12, 2) NOT NULL,
  PRIMARY KEY (order_id, line_no),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products (id)
);

-- No primary key: read with OFFSET paging.
CREATE TABLE audit_log (
  at DATETIME NOT NULL,
  actor VARCHAR(64),
  message TEXT
);

CREATE TABLE type_zoo (
  id INT AUTO_INCREMENT PRIMARY KEY,
  txt TEXT,
  vc VARCHAR(100),
  ch CHAR(5),
  tiny TINYINT,
  small SMALLINT,
  medium MEDIUMINT,
  big BIGINT,
  ubig BIGINT UNSIGNED,
  dec_val DECIMAL(20, 6),
  dbl DOUBLE,
  flt FLOAT,
  d DATE,
  dt DATETIME(3),
  ts TIMESTAMP NULL,
  tm TIME,
  yr YEAR,
  st SET('a', 'b', 'c'),
  en ENUM('x', 'y', 'it''s'),
  js JSON,
  bin VARBINARY(32),
  bl BLOB,
  bits BIT(8),
  flag TINYINT(1)
);

INSERT INTO customers (email, full_name, country, profile, created_at)
SELECT
  CONCAT('user', n, '@example.com'),
  CASE WHEN n % 50 = 0 THEN CONCAT('O''Brien \\ "Junior" 🎉 ', n) ELSE CONCAT('Customer ', n) END,
  ELT(1 + n % 4, 'ID', 'SG', 'MY', 'US'),
  CASE WHEN n % 3 = 0 THEN NULL ELSE JSON_OBJECT('age', 18 + n % 60, 'newsletter', n % 2 = 0, 'city', CONCAT('City ', n % 97)) END,
  TIMESTAMPADD(MINUTE, n, '2024-01-01 00:00:00.123456')
FROM seq WHERE n <= 20000;

INSERT INTO products (sku, name, price, weight_kg, active)
SELECT CONCAT('SKU-', LPAD(n, 6, '0')), CONCAT('Product ', n), ROUND((n % 500) * 1.37 + 0.99, 2),
  CASE WHEN n % 10 = 0 THEN NULL ELSE n / 13 END, n % 17 <> 0
FROM seq WHERE n <= 2000;

INSERT INTO orders (customer_id, status, placed_at, note)
SELECT 1 + n % 20000, ELT(1 + n % 5, 'pending', 'paid', 'shipped', 'cancelled', 'it''s complicated'),
  TIMESTAMPADD(SECOND, n * 37, '2025-01-01 00:00:00'),
  CASE WHEN n % 9 = 0 THEN 'line one\nline two\ttab \\ end' ELSE NULL END
FROM seq WHERE n <= 100000;

INSERT INTO order_items (order_id, line_no, product_id, qty, unit_price)
SELECT o.n, l.n, 1 + (o.n * 7 + l.n) % 2000, 1 + (o.n + l.n) % 5, ROUND(((o.n + l.n) % 500) * 1.37 + 0.99, 2)
FROM seq o JOIN seq l ON l.n <= 3
WHERE o.n <= 100000;

INSERT INTO audit_log (at, actor, message)
SELECT TIMESTAMPADD(SECOND, n, '2025-01-01 00:00:00'), CASE WHEN n % 4 = 0 THEN NULL ELSE CONCAT('actor', n % 13) END, REPEAT('x', n % 40)
FROM seq WHERE n <= 5000;

INSERT INTO type_zoo (txt, vc, ch, tiny, small, medium, big, ubig, dec_val, dbl, flt, d, dt, ts, tm, yr, st, en, js, bin, bl, bits, flag)
SELECT
  CASE WHEN n % 2 = 0 THEN CONCAT('tab\there ''quote'' \\back ü 中文 ', n) ELSE NULL END,
  CONCAT('vc', n),
  'abc',
  n % 127,
  n % 32000,
  n * 3,
  9007199254740993 + n,
  18446744073709551000 + n % 600,
  n / 7,
  n / 3,
  n / 3,
  DATE_ADD('2000-02-29', INTERVAL n DAY),
  TIMESTAMPADD(SECOND, n, '2025-03-01 10:00:00.250'),
  CASE WHEN n % 4 = 0 THEN NULL ELSE TIMESTAMPADD(SECOND, n, '2025-03-01 10:00:00') END,
  SEC_TO_TIME(n * 13 % 86400),
  1901 + n % 254,
  ELT(1 + n % 3, 'a', 'a,b', 'a,b,c'),
  ELT(1 + n % 3, 'x', 'y', 'it''s'),
  CASE n % 3 WHEN 0 THEN JSON_ARRAY(n, 'two', NULL) WHEN 1 THEN JSON_OBJECT('k', 'it''s \\ "q"') ELSE NULL END,
  UNHEX(CONCAT(MD5(n), '00FF')),
  CASE WHEN n % 5 = 0 THEN NULL ELSE UNHEX(MD5(n)) END,
  n % 256,
  CASE WHEN n % 3 = 0 THEN NULL ELSE n % 2 END
FROM seq WHERE n <= 10000;

DROP TABLE seq;
DROP TABLE digits;

-- Views are not backed up (only base tables); this one checks that.
CREATE VIEW order_totals AS
SELECT order_id, SUM(qty * unit_price) AS total FROM order_items GROUP BY order_id;

ANALYZE TABLE customers, products, orders, order_items, audit_log, type_zoo;
