/**
 * Vikunja API Types
 * Based on the OpenAPI spec from /api/v1/docs.json
 */

// ============================================================================
// User Types
// ============================================================================

export interface User {
  id: number;
  username: string;
  email?: string;
  name?: string;
  created?: string;
  updated?: string;
}

// ============================================================================
// Project Types
// ============================================================================

export interface Project {
  id: number;
  title: string;
  description?: string;
  identifier?: string;
  hex_color?: string;
  parent_project_id?: number;
  position?: number;
  is_archived?: boolean;
  is_favorite?: boolean;
  background_blur_hash?: string;
  background_information?: unknown;
  owner?: User;
  subscription?: Subscription;
  views?: ProjectView[];
  created?: string;
  updated?: string;
}

export interface ProjectView {
  id: number;
  title: string;
  project_id: number;
  view_kind: "list" | "gantt" | "table" | "kanban";
  position?: number;
  filter?: string;
  bucket_configuration_mode?: "none" | "manual" | "filter";
  bucket_configuration?: ProjectViewBucketConfiguration[];
  default_bucket_id?: number;
  done_bucket_id?: number;
  created?: string;
  updated?: string;
}

export interface ProjectViewBucketConfiguration {
  title: string;
  filter?: string;
}

// ============================================================================
// Task Types
// ============================================================================

export interface Task {
  id: number;
  title: string;
  description?: string;
  done?: boolean;
  done_at?: string;
  due_date?: string;
  start_date?: string;
  end_date?: string;
  priority?: number;
  percent_done?: number;
  hex_color?: string;
  project_id?: number;
  bucket_id?: number;
  position?: number;
  repeat_after?: number;
  repeat_mode?: TaskRepeatMode;
  is_favorite?: boolean;
  is_unread?: boolean;
  identifier?: string;
  index?: number;
  cover_image_attachment_id?: number;
  assignees?: User[];
  labels?: Label[];
  attachments?: TaskAttachment[];
  reminders?: TaskReminder[];
  related_tasks?: Record<RelationKind, Task[]>;
  created_by?: User;
  subscription?: Subscription;
  reactions?: Record<string, User[]>;
  comments?: TaskComment[];
  comment_count?: number;
  buckets?: Bucket[];
  created?: string;
  updated?: string;
}

export enum TaskRepeatMode {
  Default = 0,
  Month = 1,
  FromCurrentDate = 2,
}

export interface TaskReminder {
  reminder?: string;
  relative_period?: number;
  relative_to?: "due_date" | "start_date" | "end_date";
}

export interface TaskAttachment {
  id: number;
  task_id: number;
  file?: File;
  created_by?: User;
  created?: string;
}

export interface File {
  id: number;
  name: string;
  mime: string;
  size: number;
  created?: string;
}

// ============================================================================
// Label Types
// ============================================================================

export interface Label {
  id: number;
  title: string;
  description?: string;
  hex_color?: string;
  created_by?: User;
  created?: string;
  updated?: string;
}

// ============================================================================
// Comment Types
// ============================================================================

export interface TaskComment {
  id: number;
  comment: string;
  author?: User;
  reactions?: Record<string, User[]>;
  created?: string;
  updated?: string;
}

// ============================================================================
// Bucket Types (Kanban)
// ============================================================================

export interface Bucket {
  id: number;
  title: string;
  project_view_id: number;
  position?: number;
  limit?: number;
  count?: number;
  tasks?: Task[];
  created_by?: User;
  created?: string;
  updated?: string;
}

// ============================================================================
// Team Types
// ============================================================================

export interface Team {
  id: number;
  name: string;
  description?: string;
  is_public?: boolean;
  members?: TeamMember[];
  created_by?: User;
  created?: string;
  updated?: string;
}

export interface TeamMember {
  id: number;
  username?: string;
  admin?: boolean;
}

// ============================================================================
// Relation Types
// ============================================================================

export const RELATION_KINDS = [
  "subtask",
  "parenttask",
  "related",
  "duplicateof",
  "duplicates",
  "blocking",
  "blocked",
  "precedes",
  "follows",
  "copiedfrom",
  "copiedto",
] as const;

export type RelationKind = (typeof RELATION_KINDS)[number];

export interface TaskRelation {
  task_id: number;
  other_task_id: number;
  relation_kind: RelationKind;
  created_by?: User;
  created?: string;
}

// ============================================================================
// Subscription Types
// ============================================================================

export interface Subscription {
  id: number;
  entity: string;
  entity_id: number;
  created?: string;
}

// ============================================================================
// Notification Types
// ============================================================================

export interface Notification {
  id: number;
  name: string;
  notification: unknown;
  read?: boolean;
  read_at?: string;
  created?: string;
}

// ============================================================================
// Message Types (API Responses)
// ============================================================================

export interface Message {
  message: string;
}
