/**
 * Provider presets — pure data used ONLY to prefill the connection form.
 *
 * Every preset resolves to the SAME `s3` provider implementation; selecting a
 * preset never swaps code paths. Presets simply fill in `region`, `endpoint`,
 * and `forcePathStyle` defaults so the user types less. The user can always
 * override any prefilled value (that is the "Custom" preset, effectively).
 */
import type { S3ConnectionConfig, S3ProviderPreset } from './types';

export interface PresetDescriptor {
  id: S3ProviderPreset;
  label: string;
  /** Short help line shown under the preset name in the picker. */
  hint: string;
  /** Prefilled region (the user may change it). */
  region: string;
  /** Prefilled endpoint template (`{account}` substituted for R2). Empty for
   *  AWS S3 where the region derives the endpoint. */
  endpoint: string;
  /** Prefilled addressing mode. */
  forcePathStyle: boolean;
  /** Whether the user is expected to supply a custom endpoint. Drives the
   *  form's "required" indicator only — not behavior. */
  needsEndpoint: boolean;
}

export const STORAGE_PRESETS: PresetDescriptor[] = [
  {
    id: 'aws-s3',
    label: 'AWS S3',
    hint: 'Region required. Endpoint is derived automatically.',
    region: 'us-east-1',
    endpoint: '',
    forcePathStyle: false,
    needsEndpoint: false,
  },
  {
    id: 'cloudflare-r2',
    label: 'Cloudflare R2',
    hint: 'S3-compatible. Endpoint uses your R2 account id.',
    region: 'auto',
    endpoint: 'https://<account-id>.r2.cloudflarestorage.com',
    forcePathStyle: true,
    needsEndpoint: true,
  },
  {
    id: 'minio',
    label: 'MinIO',
    hint: 'Self-hosted S3-compatible. Path-style addressing.',
    region: 'us-east-1',
    endpoint: 'http://localhost:9000',
    forcePathStyle: true,
    needsEndpoint: true,
  },
  {
    id: 'digitalocean-spaces',
    label: 'DigitalOcean Spaces',
    hint: 'Region is the Spaces region (e.g. nyc3).',
    region: 'nyc3',
    endpoint: 'https://<region>.digitaloceanspaces.com',
    forcePathStyle: false,
    needsEndpoint: true,
  },
  {
    id: 'backblaze-b2',
    label: 'Backblaze B2',
    hint: 'S3-compatible API. Region is the B2 region.',
    region: 'us-west-004',
    endpoint: 'https://s3.<region>.backblazeb2.com',
    forcePathStyle: false,
    needsEndpoint: true,
  },
  {
    id: 'wasabi',
    label: 'Wasabi',
    hint: 'Region is the Wasabi region (e.g. us-east-1).',
    region: 'us-east-1',
    endpoint: 'https://s3.<region>.wasabisys.com',
    forcePathStyle: false,
    needsEndpoint: true,
  },
  {
    id: 'custom',
    label: 'Custom S3-Compatible',
    hint: 'Any S3-compatible endpoint. Fill all fields manually.',
    region: 'us-east-1',
    endpoint: '',
    forcePathStyle: true,
    needsEndpoint: true,
  },
];

/** Look up a preset by id; falls back to `custom`. */
export function getPreset(id: S3ProviderPreset): PresetDescriptor {
  return STORAGE_PRESETS.find((p) => p.id === id) ?? STORAGE_PRESETS[STORAGE_PRESETS.length - 1];
}

/** Returns a partial `S3ConnectionConfig` seeded from a preset. Used by the
 *  connection dialog when the user picks a provider; `id`/timestamps/secrets
 *  are filled in by the caller. */
export function presetDefaults(preset: S3ProviderPreset): Pick<
  S3ConnectionConfig,
  'preset' | 'provider' | 'region' | 'endpoint' | 'forcePathStyle' | 'pathPrefix'
> {
  const p = getPreset(preset);
  return {
    preset: p.id,
    provider: 's3',
    region: p.region,
    endpoint: p.needsEndpoint ? p.endpoint : '',
    forcePathStyle: p.forcePathStyle,
    pathPrefix: 'rdsql/',
  };
}
