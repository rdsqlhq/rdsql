import { SchemaTableNode } from '../domain/types';

export type RelationshipKind = 'fk' | 'self' | 'many-to-many' | 'polymorphic';

export interface GraphEdgeModel {
  id: string;
  /** Table that owns the referenced (usually primary) key. */
  source: string;
  /** Table that owns the foreign key column. */
  target: string;
  sourceColumn: string;
  targetColumn: string;
  kind: RelationshipKind;
}

export interface SchemaGraphModel {
  tableNames: string[];
  tablesByName: Map<string, SchemaTableNode>;
  edges: GraphEdgeModel[];
  /** Undirected neighbor map — used for BFS/focus/layout, direction doesn't matter there. */
  adjacency: Map<string, Set<string>>;
}

export type LayoutKind = 'hierarchical' | 'radial' | 'force' | 'elk' | 'dagre';

export interface LayoutOption {
  id: LayoutKind;
  label: string;
  /** false = recognized but not implemented in this environment (e.g. needs an
   *  external package we can't install offline). Kept in the registry so the
   *  UI/architecture is ready to wire up a real implementation later. */
  available: boolean;
  unavailableReason?: string;
}

export type ViewMode = 'diagram' | 'graph';

export interface Point {
  x: number;
  y: number;
}
