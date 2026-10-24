# Connect to PostgreSQL (and Neon / CockroachDB / YugabyteDB)

## Purpose

Add a PostgreSQL-compatible connection. This flow also covers Neon, CockroachDB
and YugabyteDB, which use the same connection form (pick the matching engine).

## Requirements

- Host, port (default `5432`), database name, username, and password
- Network access from your machine to the database (VPN, SSH tunnel, or a
  publicly reachable host)

## Steps

1. Click **New Connection**.
2. In the **Connection** tab, set a **Connection Name** and choose
   **PostgreSQL** (or **Neon** / **CockroachDB** / **YugabyteDB**) as the
   **Database Engine**. Picking **Neon** turns on `SSL Mode: require`, which
   Neon needs. You can also paste a connection URL instead of filling in the
   fields; a `*.neon.tech` URL selects **Neon** by itself.
3. Fill in **Host**, **Port**, **Database**, **Username**, **Password**.
4. If your provider requires TLS, set **SSL Mode** accordingly.
5. If the database is only reachable through a bastion host, open the
   **Security & SSH** tab and fill in **SSH Host**, **SSH User**, and either
   a **Private Key Path** or password.
6. Click **Test** to verify, then **Save**.

## Expected result

The connection appears in the sidebar; expanding it lists schemas and tables.

## Troubleshooting

- **Connection timed out** — check firewall rules and that the host/port are
  correct; if the DB is on a private network, use the SSH tunnel fields.
- **SSL required** — most managed Postgres providers (RDS, Supabase, Neon,
  CockroachDB Cloud) require `SSL Mode` to be enabled.
- **Auth failed** — verify the username/password and that the user has
  `CONNECT` privilege on the target database.
