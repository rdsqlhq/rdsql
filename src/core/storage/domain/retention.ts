/**
 * Backup retention policy evaluation — pure, safe-by-construction.
 *
 * Given a candidate list of RDSQL-managed backup objects and a policy, returns
 * the partition into `keep` and `delete`. The caller (UI) MUST confirm the
 * `delete` set before issuing any S3 delete — this module never deletes
 * anything, it only computes eligibility.
 *
 * Selection rules (applied in order; an object kept by any rule is kept):
 *   keepLast    — keep the N newest objects overall
 *   keepDaily   — keep the newest object per UTC day, for the N most recent days
 *   keepWeekly  — keep the newest object per ISO week, for the N most recent weeks
 *   keepMonthly — keep the newest object per UTC month, for the N most recent months
 *
 * An empty/all-zero policy keeps everything (returns `delete: []`).
 */
import type { RetentionPolicy, RetentionSelection, StorageObject } from './types';

/** Parse an object's lastModified into a UTC epoch ms. Objects with no/bad
 *  dates are treated as epoch 0 so they sort oldest (and thus are eligible for
 *  deletion under `keepLast`). */
function ts(obj: StorageObject): number {
  const t = Date.parse(obj.lastModified || '');
  return Number.isNaN(t) ? 0 : t;
}

/** Return the ISO week number [1..53] for a date (ISO 8601, week starts Monday). */
function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Monday of this week.
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  // Thursday in current week decides the year.
  const firstThursday = date.getTime();
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  // Week 1 is the week with the year's first Thursday.
  return 1 + Math.round((firstThursday - yearStart.getTime()) / (7 * 24 * 60 * 60 * 1000));
}

/** Evaluate a retention policy over a candidate set. Returns `{ keep, delete }`.
 *  Input objects are never mutated; the output partitions the input set. */
export function evaluateRetention(
  objects: StorageObject[],
  policy: RetentionPolicy,
): RetentionSelection {
  // SAFETY: an inactive policy keeps everything. Without this short-circuit an
  // empty/all-zero policy would mark the entire candidate set for deletion,
  // which is the opposite of "retention disabled". This is a deliberate,
  // load-bearing guard — do not remove.
  if (!isRetentionActive(policy)) {
    const sorted = [...objects].sort((a, b) => ts(b) - ts(a));
    return { keep: sorted, delete: [] };
  }

  const sorted = [...objects].sort((a, b) => ts(b) - ts(a)); // newest first

  const keepIds = new Set<string>();

  // keepLast: the N newest overall.
  if (policy.keepLast && policy.keepLast > 0) {
    for (const obj of sorted.slice(0, policy.keepLast)) keepIds.add(obj.key);
  }

  const keepByBucket = (count: number | undefined, bucketFn: (d: Date) => string) => {
    if (!count || count <= 0) return;
    const seen = new Map<string, StorageObject>(); // bucket → newest object
    for (const obj of sorted) {
      const b = bucketFn(new Date(ts(obj)));
      if (!seen.has(b)) seen.set(b, obj);
    }
    // The N most recent buckets (by the bucket's representative timestamp,
    // which is the newest object within it — already first-seen).
    const newestBuckets = [...seen.values()].sort((a, b) => ts(b) - ts(a)).slice(0, count);
    for (const obj of newestBuckets) keepIds.add(obj.key);
  };

  // keepDaily / keepMonthly use calendar buckets.
  keepByBucket(policy.keepDaily, (d) => `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`);
  keepByBucket(policy.keepMonthly, (d) => `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`);
  // keepWeekly uses ISO year-week.
  keepByBucket(policy.keepWeekly, (d) => `${d.getUTCFullYear()}-W${isoWeek(d)}`);

  const keep = sorted.filter((o) => keepIds.has(o.key));
  const del = sorted.filter((o) => !keepIds.has(o.key));
  return { keep, delete: del };
}

/** True when the policy has at least one non-zero arm. Used by the UI to
 *  decide whether retention is "enabled". */
export function isRetentionActive(policy: RetentionPolicy): boolean {
  return (
    (!!policy.keepLast && policy.keepLast > 0) ||
    (!!policy.keepDaily && policy.keepDaily > 0) ||
    (!!policy.keepWeekly && policy.keepWeekly > 0) ||
    (!!policy.keepMonthly && policy.keepMonthly > 0)
  );
}
