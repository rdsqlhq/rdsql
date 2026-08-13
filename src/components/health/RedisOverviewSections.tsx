import React from 'react';
import { Cpu, Database as KeyspaceIcon, Save, GitBranch } from 'lucide-react';
import type { DatabaseOverview } from '../../core/domain/health';
import { SectionCard } from './primitives';
import { formatBytes, formatNumber, formatRatio, formatRelativeTime } from './format';

const Detail: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-center justify-between border-b border-[#1e293b]/40 pb-1.5">
    <dt className="text-slate-500">{label}</dt>
    <dd className="text-slate-300 font-medium truncate ml-2 max-w-[60%] text-right">{value}</dd>
  </div>
);

/** Redis-only Overview detail cards — Memory & Clients, Keyspace,
 *  Persistence, Replication. Additive to the shared "Connection"/"Health
 *  Score" cards in `OverviewPanel.tsx`; reuses the same `SectionCard`/`dl`
 *  visual language rather than a bespoke layout, per the design spec's "feel
 *  like part of RDSQL, not a different app" requirement. Rendered only when
 *  `overview.redisInfo` is present (i.e. the connection is Redis). */
export const RedisOverviewSections: React.FC<{ overview: DatabaseOverview }> = ({ overview }) => {
  const info = overview.redisInfo;
  if (!info) return null;
  const { keyspace, replication, persistence, detail } = info;

  return (
    <>
      <SectionCard title="Memory & Clients" icon={Cpu}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <Detail label="Used memory" value={overview.memoryUsedBytes != null ? formatBytes(overview.memoryUsedBytes) : '—'} />
          <Detail label="Peak memory" value={formatBytes(detail.memoryPeakBytes)} />
          <Detail label="RSS memory" value={formatBytes(detail.memoryRssBytes)} />
          <Detail label="Max memory" value={overview.memoryLimitBytes != null ? formatBytes(overview.memoryLimitBytes) : 'No limit'} />
          <Detail label="Fragmentation ratio" value={detail.memoryFragmentationRatio.toFixed(2)} />
          <Detail label="Hit rate" value={formatRatio(overview.hitRatio)} />
          <Detail label="Blocked clients" value={formatNumber(detail.blockedClients)} />
          <Detail label="Max clients" value={formatNumber(detail.maxClients)} />
          <Detail label="Expired keys" value={formatNumber(detail.expiredKeys)} />
          <Detail label="Evicted keys" value={formatNumber(detail.evictedKeys)} />
          {detail.rejectedConnections > 0 && (
            <Detail label="Rejected connections" value={formatNumber(detail.rejectedConnections)} />
          )}
        </dl>
      </SectionCard>

      <SectionCard title="Keyspace" icon={KeyspaceIcon}>
        {keyspace.length === 0 ? (
          <div className="text-xs text-slate-500">No keys in any database.</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 text-left">
                <th className="font-medium pb-1.5">Database</th>
                <th className="font-medium pb-1.5 text-right">Keys</th>
                <th className="font-medium pb-1.5 text-right">Expires</th>
              </tr>
            </thead>
            <tbody>
              {keyspace.map((db) => (
                <tr key={db.dbIndex} className="border-t border-[#1e293b]/40">
                  <td className="py-1.5 text-slate-300">DB {db.dbIndex}</td>
                  <td className="py-1.5 text-right text-slate-300">{formatNumber(db.keys)}</td>
                  <td className="py-1.5 text-right text-slate-500">{formatNumber(db.expires)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <SectionCard title="Persistence" icon={Save}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <Detail label="RDB last save" value={formatRelativeTime(persistence.rdbLastSaveTime != null ? persistence.rdbLastSaveTime * 1000 : undefined)} />
          <Detail label="Changes since save" value={persistence.rdbChangesSinceLastSave != null ? formatNumber(persistence.rdbChangesSinceLastSave) : '—'} />
          <Detail label="Last save status" value={persistence.rdbLastBgsaveStatus ?? '—'} />
          <Detail label="AOF" value={persistence.aofEnabled ? 'Enabled' : 'Disabled'} />
          {persistence.aofEnabled && (
            <>
              <Detail label="AOF size" value={persistence.aofCurrentSizeBytes != null ? formatBytes(persistence.aofCurrentSizeBytes) : '—'} />
              <Detail label="AOF rewrite" value={persistence.aofRewriteInProgress ? 'In progress' : 'Idle'} />
            </>
          )}
        </dl>
      </SectionCard>

      <SectionCard title="Replication" icon={GitBranch}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <Detail label="Role" value={replication.role} />
          <Detail label="Connected replicas" value={formatNumber(replication.connectedSlaves)} />
          {replication.masterReplOffset != null && (
            <Detail label="Replication offset" value={formatNumber(replication.masterReplOffset)} />
          )}
        </dl>
      </SectionCard>
    </>
  );
};
