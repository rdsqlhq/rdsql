import React from 'react';
import {
  SiPostgresql, SiMysql, SiMariadbfoundation, SiSqlite, SiTurso, SiCloudflare,
  SiCockroachlabs, SiTidb, SiPlanetscale, SiDuckdb,
} from 'react-icons/si';
import { DiMsqlServer, DiRedis, DiMongodb } from 'react-icons/di';

interface EngineIconProps {
  engine: string;
  className?: string;
  isConnected?: boolean;
}

const ICONS: Record<
  string,
  { Icon: React.ComponentType<{ className?: string; color?: string }>; color: string; scale: number }
> = {
  postgres: { Icon: SiPostgresql, color: '#5A9FD4', scale: 1 },
  postgresql: { Icon: SiPostgresql, color: '#5A9FD4', scale: 1 },
  cockroachdb: { Icon: SiCockroachlabs, color: '#6933FF', scale: 1 },
  // No official react-icon yet — fall back to the Postgres elephant (same wire family).
  yugabytedb: { Icon: SiPostgresql, color: '#2D2D2D', scale: 1 },
  mysql: { Icon: SiMysql, color: '#5B9BD5', scale: 1.18 },
  mariadb: { Icon: SiMariadbfoundation, color: '#3FBDBA', scale: 1.05 },
  tidb: { Icon: SiTidb, color: '#E63946', scale: 1 },
  planetscale: { Icon: SiPlanetscale, color: '#000000', scale: 1 },
  sqlite: { Icon: SiSqlite, color: '#35B8E6', scale: 1 },
  duckdb: { Icon: SiDuckdb, color: '#F59E0B', scale: 1 },
  turso: { Icon: SiTurso, color: '#5CC4C9', scale: 1 },
  'cloudflare-d1': { Icon: SiCloudflare, color: '#FAAE40', scale: 1 },
  mssql: { Icon: DiMsqlServer, color: '#CC2927', scale: 1 },
  redis: { Icon: DiRedis, color: '#DC382D', scale: 1 },
  mongodb: { Icon: DiMongodb, color: '#47A248', scale: 1 },
};

export const EngineIcon: React.FC<EngineIconProps> = ({
  engine,
  className = 'w-3.5 h-3.5',
  isConnected = false,
}) => {
  const normEngine = (engine || 'postgres').toLowerCase();
  const entry = ICONS[normEngine] || ICONS.postgres;
  const { Icon, color, scale } = entry;

  return (
    <span
      className="relative inline-flex items-center justify-center shrink-0"
      style={{ transform: `scale(${scale})` }}
      title={`${engine.toUpperCase()} Database`}
    >
      <Icon className={className} color={color} />
      {isConnected && (
        <span className="absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-500 ring-1 ring-[#0a0f18]" />
      )}
    </span>
  );
};
