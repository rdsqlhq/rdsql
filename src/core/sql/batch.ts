import type { QueryResultData } from '../domain/types';

/** One statement's outcome from the `execute_batch` command. */
export interface BatchItem {
  statement: string;
  result?: QueryResultData | null;
  error?: string | null;
  /** More rows came back than the row limit allowed. */
  truncated: boolean;
  duration_ms: number;
}
