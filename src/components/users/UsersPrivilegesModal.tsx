import React, { useEffect, useState } from 'react';
import {
  X,
  Users,
  UserPlus,
  Database,
  Check,
  RefreshCw,
  Save,
  ShieldAlert,
  KeyRound,
} from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useConnectionStore } from '../../store/useConnectionStore';
import { safeInvoke } from '../../core/tauri/ipc';
import { QueryResultData } from '../../core/domain/types';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';

interface DbUser {
  user: string;
  host?: string; // MySQL only
}

function userKey(u: DbUser) {
  return u.host ? `${u.user}@${u.host}` : u.user;
}

function q(engine: string, name: string): string {
  if (engine === 'mysql' || engine === 'mariadb') return `\`${name.replace(/`/g, '``')}\``;
  if (engine === 'mssql') return `[${name.replace(/]/g, ']]')}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

async function runQuery(config: any, sql: string): Promise<QueryResultData> {
  return safeInvoke<QueryResultData>('execute_query', { request: { config, sql }, queryId: `users_priv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` });
}

async function fetchUsers(config: any): Promise<DbUser[]> {
  if (config.engine === 'postgres') {
    const res = await runQuery(config, "SELECT rolname FROM pg_roles WHERE rolcanlogin = true ORDER BY rolname;");
    return res.rows.map((r) => ({ user: String(r[0]) }));
  }
  if (config.engine === 'mysql' || config.engine === 'mariadb') {
    const res = await runQuery(config, "SELECT User, Host FROM mysql.user WHERE User != '' ORDER BY User;");
    return res.rows.map((r) => ({ user: String(r[0]), host: String(r[1]) }));
  }
  if (config.engine === 'mssql') {
    // Server-level logins (SQL auth + Windows auth) — mirrors Postgres roles.
    // `##...##` principals are internal (certificate/asymmetric-key-backed);
    // `NT AUTHORITY\...`/`NT SERVICE\...` are OS-integrated built-ins that
    // exist on every instance and aren't meaningful to manage here.
    // T-SQL's LIKE has no default escape character, so the literal
    // backslash in these two patterns needs no special handling — only `%`
    // is a wildcard here.
    const res = await runQuery(config, "SELECT name FROM sys.server_principals WHERE type IN ('S', 'U') AND name NOT LIKE '##%' AND name NOT LIKE 'NT AUTHORITY\\%' AND name NOT LIKE 'NT SERVICE\\%' ORDER BY name;");
    return res.rows.map((r) => ({ user: String(r[0]) }));
  }
  return [];
}

async function fetchDatabases(config: any): Promise<string[]> {
  if (config.engine === 'postgres') {
    const res = await runQuery(config, "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;");
    return res.rows.map((r) => String(r[0]));
  }
  if (config.engine === 'mysql' || config.engine === 'mariadb') {
    const res = await runQuery(config, 'SHOW DATABASES;');
    return res.rows
      .map((r) => String(r[0]))
      .filter((d) => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(d));
  }
  if (config.engine === 'mssql') {
    const res = await runQuery(config, "SELECT name FROM sys.databases WHERE state = 0 AND name NOT IN ('master', 'tempdb', 'model', 'msdb') ORDER BY name;");
    return res.rows.map((r) => String(r[0]));
  }
  return [];
}

async function fetchUserDatabaseAccess(config: any, user: DbUser, allDbs: string[]): Promise<Set<string>> {
  if (config.engine === 'postgres') {
    const res = await runQuery(
      config,
      `SELECT datname FROM pg_database WHERE datistemplate = false AND has_database_privilege('${user.user.replace(/'/g, "''")}', datname, 'CONNECT');`
    );
    return new Set(res.rows.map((r) => String(r[0])));
  }
  if (config.engine === 'mysql' || config.engine === 'mariadb') {
    const access = new Set<string>();
    try {
      const res = await runQuery(config, `SHOW GRANTS FOR '${user.user.replace(/'/g, "''")}'@'${(user.host || '%').replace(/'/g, "''")}';`);
      res.rows.forEach((r) => {
        const grantText = String(r[0] ?? '');
        if (/ON\s+\*\s*\.\s*\*/i.test(grantText)) {
          allDbs.forEach((d) => access.add(d));
          return;
        }
        const m = grantText.match(/ON\s+`?([^`.\s]+)`?\s*\.\s*\*/i);
        if (m && m[1]) access.add(m[1]);
      });
    } catch {
      // SHOW GRANTS can fail for users with no grants on some MySQL versions; treat as no access.
    }
    return access;
  }
  if (config.engine === 'mssql') {
    if (allDbs.length === 0) return new Set();
    // One TDS session per query (see run_mssql_query) means USE-based
    // context switching doesn't persist between calls — instead, check every
    // candidate database in a single round trip via 3-part cross-database
    // names against sys.database_principals (valid T-SQL on the same server).
    const loginLit = user.user.replace(/'/g, "''");
    const parts = allDbs.map(
      (d) => `SELECT '${d.replace(/'/g, "''")}' AS db_name FROM ${q('mssql', d)}.sys.database_principals WHERE name = '${loginLit}'`
    );
    const res = await runQuery(config, parts.join(' UNION ALL ') + ';');
    return new Set(res.rows.map((r) => String(r[0])));
  }
  return new Set();
}

function grantSQL(engine: string, user: DbUser, db: string): string[] {
  if (engine === 'postgres') {
    return [
      `GRANT CONNECT ON DATABASE ${q(engine, db)} TO ${q(engine, user.user)};`,
      `GRANT USAGE ON SCHEMA public TO ${q(engine, user.user)};`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${q(engine, user.user)};`,
    ];
  }
  if (engine === 'mssql') {
    // One statement, one connection (see fetchUserDatabaseAccess) — USE only
    // affects the rest of the SAME batch, so it must be combined here rather
    // than sent as a separate array entry. db_datareader/db_datawriter are
    // SQL Server's built-in read+write roles — the closest single-step
    // equivalent to Postgres's ALL TABLES grant above.
    const u = q(engine, user.user);
    return [
      `USE ${q(engine, db)}; ` +
        `IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = '${user.user.replace(/'/g, "''")}') CREATE USER ${u} FOR LOGIN ${u}; ` +
        `ALTER ROLE db_datareader ADD MEMBER ${u}; ` +
        `ALTER ROLE db_datawriter ADD MEMBER ${u};`,
    ];
  }
  return [`GRANT ALL PRIVILEGES ON ${q(engine, db)}.* TO '${user.user.replace(/'/g, "''")}'@'${(user.host || '%').replace(/'/g, "''")}';`, 'FLUSH PRIVILEGES;'];
}

function revokeSQL(engine: string, user: DbUser, db: string): string[] {
  if (engine === 'postgres') {
    return [
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${q(engine, user.user)};`,
      `REVOKE CONNECT ON DATABASE ${q(engine, db)} FROM ${q(engine, user.user)};`,
    ];
  }
  if (engine === 'mssql') {
    const u = q(engine, user.user);
    return [
      `USE ${q(engine, db)}; ` +
        `IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = '${user.user.replace(/'/g, "''")}') BEGIN ` +
        `ALTER ROLE db_datareader DROP MEMBER ${u}; ` +
        `ALTER ROLE db_datawriter DROP MEMBER ${u}; ` +
        `DROP USER ${u}; END;`,
    ];
  }
  return [`REVOKE ALL PRIVILEGES ON ${q(engine, db)}.* FROM '${user.user.replace(/'/g, "''")}'@'${(user.host || '%').replace(/'/g, "''")}';`, 'FLUSH PRIVILEGES;'];
}

export const UsersPrivilegesModal: React.FC<{ embedded?: boolean; connectionId?: string }> = ({ embedded = false, connectionId }) => {
  const { isUsersModalOpen, setUsersModalOpen } = useWorkspaceStore();
  useEscapeToClose(isUsersModalOpen && !embedded ? () => setUsersModalOpen(false) : null);
  const { connections, activeConnectionId } = useConnectionStore();
  // When embedded (tab mode), use the tab's connectionId; otherwise use the
  // global active connection.
  const resolvedConnId = embedded ? connectionId : activeConnectionId;
  const activeConn = connections.find((c) => c.id === resolvedConnId);

  const [users, setUsers] = useState<DbUser[]>([]);
  const [databases, setDatabases] = useState<string[]>([]);
  const [selectedUserKey, setSelectedUserKey] = useState<string | null>(null);
  const [access, setAccess] = useState<Set<string>>(new Set());
  const [originalAccess, setOriginalAccess] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadingAccess, setLoadingAccess] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showNewUser, setShowNewUser] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newHost, setNewHost] = useState('%');

  const engine = activeConn?.engine;
  const supported = engine === 'postgres' || engine === 'mysql' || engine === 'mssql';

  useEffect(() => {
    // In embedded mode, fetch on mount; in modal mode, fetch when opened.
    const shouldFetch = embedded ? !!activeConn && supported : (isUsersModalOpen && !!activeConn && supported);
    if (!shouldFetch) return;
    setError(null);
    setLoading(true);
    Promise.all([fetchUsers(activeConn), fetchDatabases(activeConn)])
      .then(([u, d]) => {
        setUsers(u);
        setDatabases(d);
        setSelectedUserKey(u[0] ? userKey(u[0]) : null);
      })
      .catch((err) => setError(err?.message || String(err)))
      .finally(() => setLoading(false));
  }, [isUsersModalOpen, activeConn?.id, embedded]);

  useEffect(() => {
    if (!selectedUserKey || !activeConn || !supported) return;
    const user = users.find((u) => userKey(u) === selectedUserKey);
    if (!user) return;
    setLoadingAccess(true);
    setError(null);
    fetchUserDatabaseAccess(activeConn, user, databases)
      .then((set) => {
        setAccess(new Set(set));
        setOriginalAccess(new Set(set));
      })
      .catch((err) => setError(err?.message || String(err)))
      .finally(() => setLoadingAccess(false));
  }, [selectedUserKey]);

  if (!embedded && !isUsersModalOpen) return null;

  const close = () => {
    setUsersModalOpen(false);
    setShowNewUser(false);
    setError(null);
  };

  const selectedUser = users.find((u) => userKey(u) === selectedUserKey) || null;
  const hasChanges =
    access.size !== originalAccess.size || [...access].some((d) => !originalAccess.has(d));

  const toggleDb = (db: string) => {
    setAccess((prev) => {
      const next = new Set(prev);
      if (next.has(db)) next.delete(db);
      else next.add(db);
      return next;
    });
  };

  const handleSave = async () => {
    if (!activeConn || !selectedUser || !engine) return;
    setSaving(true);
    setError(null);
    try {
      const toGrant = [...access].filter((d) => !originalAccess.has(d));
      const toRevoke = [...originalAccess].filter((d) => !access.has(d));

      for (const db of toGrant) {
        for (const stmt of grantSQL(engine, selectedUser, db)) {
          await runQuery(activeConn, stmt);
        }
      }
      for (const db of toRevoke) {
        for (const stmt of revokeSQL(engine, selectedUser, db)) {
          await runQuery(activeConn, stmt);
        }
      }
      setOriginalAccess(new Set(access));
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCreateUser = async () => {
    if (!activeConn || !engine || !newUsername.trim()) return;
    setSaving(true);
    setError(null);
    try {
      let stmt: string;
      if (engine === 'postgres') {
        stmt = `CREATE ROLE ${q(engine, newUsername)} LOGIN PASSWORD '${newPassword.replace(/'/g, "''")}';`;
      } else if (engine === 'mssql') {
        // A LOGIN is server-level (like a Postgres role) — per-database access
        // is granted separately via grantSQL when the user checks a database.
        stmt = `CREATE LOGIN ${q(engine, newUsername)} WITH PASSWORD = '${newPassword.replace(/'/g, "''")}';`;
      } else {
        stmt = `CREATE USER '${newUsername.replace(/'/g, "''")}'@'${newHost.replace(/'/g, "''")}' IDENTIFIED BY '${newPassword.replace(/'/g, "''")}';`;
      }
      await runQuery(activeConn, stmt);
      const refreshed = await fetchUsers(activeConn);
      setUsers(refreshed);
      const created = engine === 'postgres' || engine === 'mssql' ? { user: newUsername } : { user: newUsername, host: newHost };
      setSelectedUserKey(userKey(created));
      setShowNewUser(false);
      setNewUsername('');
      setNewPassword('');
      setNewHost('%');
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={embedded
      ? "w-full h-full bg-[#0a0f18] overflow-hidden flex flex-col select-none font-sans"
      : "fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 select-none font-sans"
    }>
      <div className={embedded
        ? "w-full h-full bg-[#0a0f18] overflow-hidden flex flex-col"
        : "w-full max-w-2xl h-[560px] bg-[#0a0f18] border border-[#1e293b] rounded-2xl shadow-2xl overflow-hidden flex flex-col"
      }>
        {/* Header */}
        <div className={embedded
          ? "px-5 py-3 border-b border-[#1e293b] flex items-center justify-between bg-[#06090e] shrink-0"
          : "px-5 py-4 border-b border-[#1e293b] flex items-center justify-between bg-[#06090e] shrink-0"
        }>
          <div className="flex items-center gap-2.5">
            <div className={embedded ? "w-7 h-7 rounded-lg bg-blue-600/20 text-blue-400 flex items-center justify-center" : "w-8 h-8 rounded-lg bg-blue-600/20 text-blue-400 flex items-center justify-center"}>
              <Users className={embedded ? "w-3.5 h-3.5" : "w-4 h-4"} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-100">Manage Users & Privileges</h3>
              <p className="text-[11px] text-slate-400">
                {activeConn ? `${activeConn.name} (${activeConn.engine.toUpperCase()})` : 'No active connection'}
              </p>
            </div>
          </div>
          <button
            onClick={close}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-[#1e293b] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {!activeConn ? (
          <div className="flex-1 flex items-center justify-center text-xs text-slate-500">
            Select an active connection first.
          </div>
        ) : !supported ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-xs text-slate-500 px-6 text-center">
            <ShieldAlert className="w-6 h-6 text-amber-400" />
            User & privilege management isn't applicable to {activeConn.engine.toUpperCase()} — it doesn't have a
            server-level user/grant system. This is available for PostgreSQL, MySQL, and SQL Server connections.
          </div>
        ) : (
          <div className="flex-1 flex overflow-hidden">
            {/* User List */}
            <div className="w-56 border-r border-[#1e293b] flex flex-col shrink-0 bg-[#06090e]/40">
              <div className="p-2 border-b border-[#1e293b] flex items-center justify-between">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  Users ({users.length})
                </span>
                <button
                  onClick={() => setShowNewUser((v) => !v)}
                  className="p-1 rounded text-blue-400 hover:text-white hover:bg-[#1e293b] transition-colors"
                  title="Create New User"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                </button>
              </div>

              {showNewUser && (
                <div className="p-2 border-b border-[#1e293b] flex flex-col gap-1.5 bg-[#0f172a]/60">
                  <input
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="username"
                    className="bg-[#0f172a] border border-[#1e293b] rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                  />
                  <input
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    type="password"
                    placeholder="password"
                    className="bg-[#0f172a] border border-[#1e293b] rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                  />
                  {engine === 'mysql' && (
                    <input
                      value={newHost}
                      onChange={(e) => setNewHost(e.target.value)}
                      placeholder="host (e.g. %)"
                      className="bg-[#0f172a] border border-[#1e293b] rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-500 font-mono"
                    />
                  )}
                  <button
                    onClick={handleCreateUser}
                    disabled={saving || !newUsername.trim()}
                    className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-semibold disabled:opacity-50"
                  >
                    Create User
                  </button>
                </div>
              )}

              <div className="flex-1 overflow-y-auto p-1.5">
                {loading ? (
                  <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono p-2">
                    <RefreshCw className="w-3 h-3 animate-spin text-blue-400" />
                    Loading users...
                  </div>
                ) : users.length === 0 ? (
                  <div className="text-[11px] text-slate-500 italic p-2">No users found</div>
                ) : (
                  users.map((u) => {
                    const key = userKey(u);
                    const isSel = key === selectedUserKey;
                    return (
                      <button
                        key={key}
                        onClick={() => setSelectedUserKey(key)}
                        className={`w-full text-left px-2 py-1.5 rounded text-xs font-mono flex items-center gap-1.5 mb-0.5 transition-colors ${
                          isSel ? 'bg-blue-600/20 text-blue-400 font-semibold' : 'text-slate-300 hover:bg-[#141e33]'
                        }`}
                      >
                        <KeyRound className="w-3 h-3 shrink-0" />
                        <span className="truncate">{key}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Database Access */}
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="p-2 border-b border-[#1e293b] flex items-center justify-between shrink-0">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-blue-400" />
                  Database Access {selectedUser ? `for ${userKey(selectedUser)}` : ''}
                </span>
                {hasChanges && (
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {saving ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                    Save Changes
                  </button>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-2">
                {!selectedUser ? (
                  <div className="text-xs text-slate-500 italic p-2">Select a user to manage access.</div>
                ) : loadingAccess ? (
                  <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono p-2">
                    <RefreshCw className="w-3 h-3 animate-spin text-blue-400" />
                    Loading current access...
                  </div>
                ) : databases.length === 0 ? (
                  <div className="text-xs text-slate-500 italic p-2">No databases found on this server.</div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {databases.map((db) => {
                      const checked = access.has(db);
                      return (
                        <label
                          key={db}
                          className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-[#141e33] cursor-pointer text-xs font-mono text-slate-200"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleDb(db)}
                            className="rounded border-[#1e293b] text-blue-600 focus:ring-0 cursor-pointer"
                          />
                          <span className="flex-1 truncate">{db}</span>
                          {checked && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="shrink-0">
            <CopyableErrorBanner message={error} tone="red" parseAsDbError />
          </div>
        )}
      </div>
    </div>
  );
};
