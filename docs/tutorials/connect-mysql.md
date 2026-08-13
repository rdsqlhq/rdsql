# Connect to MySQL, MariaDB, TiDB, or PlanetScale

## Purpose

Add a MySQL-protocol connection. TiDB and PlanetScale are MySQL-wire-compatible
and use the same form — pick the matching engine so rdSQL applies the right
dialect quirks.

## Requirements

- Host, port (default `3306`), username, and password
- Optionally a specific database/schema name

## Steps

1. Click **New Connection**.
2. Set a **Connection Name** and choose **MySQL**, **MariaDB**, **TiDB**, or
   **PlanetScale** as the **Database Engine**. Use **Provider Preset** if one
   matches your host.
3. Fill in **Host**, **Port**, **Database**, **Username**, **Password**.
4. PlanetScale and many managed MySQL hosts require TLS — set **SSL Mode**
   accordingly.
5. For databases behind a bastion, use the **Security & SSH** tab.
6. Click **Test**, then **Save**.

## Expected result

The connection appears in the sidebar; MySQL's one-connection-many-databases
model means you can switch between databases on the same server from within
the connection.

## Troubleshooting

- **Access denied for user** — confirm the user has privileges from your
  connecting IP (`'user'@'%'` vs `'user'@'specific-host'`).
- **PlanetScale connection fails without SSL** — PlanetScale requires TLS;
  make sure **SSL Mode** is on.
- **Unknown database** — the **Database** field is optional on multi-database
  engines; leave it blank to connect to the server and pick a database after.
