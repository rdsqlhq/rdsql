-- Source data for SQL Server (azure-sql-edge): ~110k rows.
-- Run by engines.e2e.test.tsx through the app's own driver, one statement
-- at a time, inside the rdsql_src database.

CREATE TABLE digits (d INT PRIMARY KEY);
INSERT INTO digits VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9);
CREATE TABLE seq (n INT PRIMARY KEY);
INSERT INTO seq
SELECT 1 + a.d + 10 * b.d + 100 * c.d + 1000 * e.d + 10000 * f.d
FROM digits a, digits b, digits c, digits e, digits f;

CREATE TABLE customers (
  id INT IDENTITY(1, 1) PRIMARY KEY,
  email NVARCHAR(190) NOT NULL UNIQUE,
  full_name NVARCHAR(255) NOT NULL,
  country CHAR(2) NOT NULL DEFAULT 'ID',
  created_at DATETIME2(6) NOT NULL
);

CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers (id),
  status NVARCHAR(32) NOT NULL DEFAULT 'pending',
  placed_at DATETIME NOT NULL,
  note NVARCHAR(MAX)
);

CREATE TABLE order_items (
  order_id BIGINT NOT NULL REFERENCES orders (id),
  line_no INT NOT NULL,
  qty INT NOT NULL,
  unit_price DECIMAL(12, 2) NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

CREATE TABLE audit_log (
  at DATETIME2 NOT NULL,
  actor NVARCHAR(64),
  message NVARCHAR(400)
);

CREATE TABLE type_zoo (
  id INT PRIMARY KEY,
  txt NVARCHAR(MAX),
  vc VARCHAR(100),
  tiny TINYINT,
  small SMALLINT,
  big BIGINT,
  dec_val DECIMAL(20, 6),
  dbl FLOAT,
  rl REAL,
  money_val MONEY,
  d DATE,
  dt DATETIME2(3),
  dto DATETIMEOFFSET,
  tm TIME,
  bin VARBINARY(32),
  u UNIQUEIDENTIFIER,
  flag BIT
);

SET IDENTITY_INSERT customers ON;
INSERT INTO customers (id, email, full_name, country, created_at)
SELECT n, CONCAT('user', n, '@example.com'),
  CASE WHEN n % 50 = 0 THEN CONCAT(N'O''Brien \ "Junior" 🎉 ', n) ELSE CONCAT(N'Customer ', n) END,
  CHOOSE(1 + n % 4, 'ID', 'SG', 'MY', 'US'),
  DATEADD(MINUTE, n, CAST('2024-01-01 00:00:00.123456' AS DATETIME2(6)))
FROM seq WHERE n <= 10000;
SET IDENTITY_INSERT customers OFF;

INSERT INTO orders (id, customer_id, status, placed_at, note)
SELECT n, 1 + n % 10000, CHOOSE(1 + n % 4, 'pending', 'paid', 'shipped', 'it''s complicated'),
  DATEADD(SECOND, n * 37, CAST('2025-01-01' AS DATETIME)),
  CASE WHEN n % 9 = 0 THEN CONCAT(N'line one', CHAR(10), N'line two', CHAR(9), N'tab') ELSE NULL END
FROM seq WHERE n <= 30000;

INSERT INTO order_items (order_id, line_no, qty, unit_price)
SELECT o.n, l.n, 1 + (o.n + l.n) % 5, ROUND(((o.n + l.n) % 500) * 1.37 + 0.99, 2)
FROM seq o JOIN seq l ON l.n <= 2
WHERE o.n <= 30000;

INSERT INTO audit_log (at, actor, message)
SELECT DATEADD(SECOND, n, CAST('2025-01-01' AS DATETIME2)), CASE WHEN n % 4 = 0 THEN NULL ELSE CONCAT('actor', n % 13) END, REPLICATE('x', n % 40)
FROM seq WHERE n <= 5000;

INSERT INTO type_zoo (id, txt, vc, tiny, small, big, dec_val, dbl, rl, money_val, d, dt, dto, tm, bin, u, flag)
SELECT n,
  CASE WHEN n % 2 = 0 THEN CONCAT(N'tab', CHAR(9), N'here ''quote'' \back ü 中文 ', n) ELSE NULL END,
  CONCAT('vc', n),
  n % 255,
  n % 32000,
  9007199254740993 + n,
  CAST(n AS DECIMAL(20, 6)) / 7,
  CAST(n AS FLOAT) / 3,
  CAST(n AS REAL) / 3,
  n * 3.5,
  DATEADD(DAY, n, CAST('2000-02-29' AS DATE)),
  DATEADD(SECOND, n, CAST('2025-03-01 10:00:00.250' AS DATETIME2(3))),
  TODATETIMEOFFSET(DATEADD(SECOND, n, CAST('2025-03-01 10:00:00' AS DATETIME2)), '+07:00'),
  CAST(DATEADD(SECOND, n * 13 % 86400, CAST('00:00:00' AS TIME)) AS TIME),
  CASE WHEN n % 5 = 0 THEN NULL ELSE HASHBYTES('MD5', CONCAT('zoo', n)) END,
  CAST(HASHBYTES('MD5', CONCAT('u', n)) AS UNIQUEIDENTIFIER),
  CASE WHEN n % 3 = 0 THEN NULL ELSE n % 2 END
FROM seq WHERE n <= 2000;

DROP TABLE seq;
DROP TABLE digits;
