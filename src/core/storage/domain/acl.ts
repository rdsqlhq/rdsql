/**
 * S3 canned ACL options + the ACL DTO shapes mirrored from Rust.
 *
 * ACLs are object-level and provider-dependent: AWS S3 supports them fully;
 * Cloudflare R2 rejects them (AccessControlNotSupported); MinIO support
 * depends on configuration. Canned ACLs cover the common cases — fine-grained
 * grant construction is intentionally out of scope here.
 */

/**
 * Whether a provider is known to support S3 ACLs. Cloudflare R2 does not
 * implement GetObjectAcl/PutObjectAcl (returns `NotImplemented`), so the
 * Permissions button is hidden for R2 connections to avoid surfacing an
 * unavoidable error. Other providers (AWS S3, MinIO, B2, Wasabi, Spaces)
 * generally support ACLs.
 */
import type { S3ProviderPreset } from './types';

export function providerSupportsAcl(preset: S3ProviderPreset): boolean {
  // R2 is the well-known non-supporter. Add others here as they're discovered.
  return preset !== 'cloudflare-r2';
}

/** The S3 canned-ACL string values + friendly labels for the dropdown. */
export interface CannedAclOption {
  /** The S3 API string value (sent verbatim to `put_object_acl`). */
  value: string;
  /** Human label. */
  label: string;
  /** Short description shown under the dropdown. */
  hint: string;
}

export const CANNED_ACLS: CannedAclOption[] = [
  {
    value: 'private',
    label: 'Private',
    hint: 'Owner gets FULL_CONTROL. No one else has access rights. (Default.)',
  },
  {
    value: 'public-read',
    label: 'Public Read',
    hint: 'Owner gets FULL_CONTROL; the AllUsers group gets READ access.',
  },
  {
    value: 'public-read-write',
    label: 'Public Read & Write',
    hint: 'Owner gets FULL_CONTROL; the AllUsers group gets READ + WRITE. Not recommended.',
  },
  {
    value: 'authenticated-read',
    label: 'Authenticated Read',
    hint: 'Owner gets FULL_CONTROL; any authenticated AWS user gets READ.',
  },
  {
    value: 'aws-exec-read',
    label: 'AWS Exec Read',
    hint: 'Owner gets FULL_CONTROL; AWS reserved. See AWS docs.',
  },
  {
    value: 'bucket-owner-read',
    label: 'Bucket Owner Read',
    hint: 'Owner gets FULL_CONTROL; the bucket owner gets READ.',
  },
  {
    value: 'bucket-owner-full-control',
    label: 'Bucket Owner Full Control',
    hint: 'Owner + bucket owner both get FULL_CONTROL.',
  },
];

/** Look up the hint for a canned value (for the dropdown's helper text). */
export function cannedAclHint(value: string): string {
  return CANNED_ACLS.find((o) => o.value === value)?.hint ?? '';
}

/** The ACL DTO returned by `s3_get_object_acl`. */
export interface AclGrantee {
  type: string;
  id?: string;
  displayName?: string;
  uri?: string;
}
export interface AclGrant {
  grantee: AclGrantee;
  permission: string;
}
export interface AclOwner {
  id?: string;
  displayName?: string;
}
export interface AclDto {
  owner: AclOwner;
  grants: AclGrant[];
}

/** A friendly label for a grantee, collapsing the common cases. */
export function granteeLabel(g: AclGrantee): string {
  if (g.uri?.endsWith('AllUsers')) return 'Everyone (public)';
  if (g.uri?.endsWith('AuthenticatedUsers')) return 'Authenticated users';
  if (g.displayName) return g.displayName;
  if (g.id) return g.id.length > 16 ? `${g.id.slice(0, 8)}…${g.id.slice(-4)}` : g.id;
  if (g.uri) return g.uri.split('/').pop() ?? g.uri;
  return g.type;
}
