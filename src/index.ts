#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getClient } from "./vikunja-client.js";
import { tokenStore } from "./request-context.js";
import { RELATION_KINDS } from "./types.js";
import type {
  Project,
  Task,
  Label,
  TaskComment,
  Bucket,
  Team,
  User,
  Notification,
  TaskRelation,
  ProjectView,
  SavedFilter,
  Message,
} from "./types.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "vikunja",
    version: "1.0.0",
  });

  // Helper to format responses
  function formatResponse(data: unknown): { content: Array<{ type: "text"; text: string }> } {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  // Helper to format error responses
  function formatError(error: unknown): {
    content: Array<{ type: "text"; text: string }>;
    isError: true;
  } {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: true, message }, null, 2),
        },
      ],
      isError: true,
    };
  }

  // Searches all views of a project to find a bucket by ID and return its title and viewId.
  async function findBucketInfo(
    projectId: number,
    bucketId: number
  ): Promise<{ title: string; viewId: number } | null> {
    const client = getClient();
    const viewsResp = await client.get<ProjectView[]>(`/projects/${projectId}/views`);
    for (const view of viewsResp.data) {
      try {
        const bucketsResp = await client.get<Bucket[]>(
          `/projects/${projectId}/views/${view.id}/buckets`
        );
        const bucket = bucketsResp.data.find((b) => b.id === bucketId);
        if (bucket) return { title: bucket.title, viewId: view.id };
      } catch {
        // view may not support buckets
      }
    }
    return null;
  }

  // Vikunja's POST /tasks/{id} does a full replacement, not a partial update.
  // This helper GETs the current task state and merges changes before POSTing.
  async function patchTask(taskId: number, changes: Record<string, unknown>): Promise<Task> {
    const client = getClient();
    const { data: current } = await client.get<Task>(`/tasks/${taskId}`);
    const body: Record<string, unknown> = {
      title: current.title,
      description: current.description ?? "",
      done: current.done ?? false,
      due_date: current.due_date ?? null,
      start_date: current.start_date ?? null,
      end_date: current.end_date ?? null,
      priority: current.priority ?? 0,
      percent_done: current.percent_done ?? 0,
      hex_color: current.hex_color ?? "",
      project_id: current.project_id,
      bucket_id: current.bucket_id ?? 0,
      repeat_after: current.repeat_after ?? 0,
      repeat_mode: current.repeat_mode ?? 0,
      is_favorite: current.is_favorite ?? false,
      assignees: current.assignees ?? [],
      reminders: (current.reminders ?? []).map((r) => ({
        reminder: r.reminder,
        relative_period: r.relative_period,
        relative_to: r.relative_to,
      })),
    };
    Object.assign(body, changes);
    const { data } = await client.post<Task>(`/tasks/${taskId}`, body);
    return data;
  }

  // ============================================================================
  // Ping Tool (for testing)
  // ============================================================================

  server.tool("ping", "Test if the MCP server is working", {}, async () => {
    return formatResponse({
      status: "ok",
      message: "pong",
      timestamp: new Date().toISOString(),
    });
  });

  // ============================================================================
  // Project Tools
  // ============================================================================

  server.tool(
    "projects_list",
    "List all projects the user has access to",
    {
      page: z.number().optional().describe("Page number for pagination (default: 1)"),
      perPage: z.number().optional().describe("Number of items per page (default: 50)"),
      search: z.string().optional().describe("Search projects by title"),
      isArchived: z.boolean().optional().describe("If true, also return archived projects"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.get<Project[]>("/projects", {
          page: args.page,
          per_page: args.perPage,
          s: args.search,
          is_archived: args.isArchived,
        });
        return formatResponse({ projects: response.data, pagination: response.pagination });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "projects_get",
    "Get a single project by ID",
    {
      projectId: z.number().describe("The project ID"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.get<Project>(`/projects/${args.projectId}`);
        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "projects_create",
    "Create a new project",
    {
      title: z.string().describe("Project title (required)"),
      description: z.string().optional().describe("Project description"),
      color: z.string().optional().describe("Hex color (e.g., 'ff0000')"),
      parentProjectId: z.number().optional().describe("Parent project ID for nesting"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.put<Project>("/projects", {
          title: args.title,
          description: args.description,
          hex_color: args.color,
          parent_project_id: args.parentProjectId,
        });
        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "projects_update",
    "Update an existing project",
    {
      projectId: z.number().describe("The project ID (required)"),
      title: z.string().optional().describe("New project title"),
      description: z.string().optional().describe("New project description"),
      color: z.string().optional().describe("New hex color"),
      isArchived: z.boolean().optional().describe("Archive or unarchive the project"),
      isFavorite: z.boolean().optional().describe("Mark as favorite"),
    },
    async (args) => {
      try {
        const client = getClient();
        const body: Record<string, unknown> = {};
        if (args.title !== undefined) body.title = args.title;
        if (args.description !== undefined) body.description = args.description;
        if (args.color !== undefined) body.hex_color = args.color;
        if (args.isArchived !== undefined) body.is_archived = args.isArchived;
        if (args.isFavorite !== undefined) body.is_favorite = args.isFavorite;

        const response = await client.post<Project>(`/projects/${args.projectId}`, body);
        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "projects_delete",
    "Delete a project",
    {
      projectId: z.number().describe("The project ID to delete"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.delete<Message>(`/projects/${args.projectId}`);
        return formatResponse({ ...response.data, success: true, message: "Project deleted" });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // ============================================================================
  // Task Tools
  // ============================================================================

  server.tool(
    "tasks_list",
    "List all tasks (optionally filtered by project)",
    {
      projectId: z
        .number()
        .optional()
        .describe("Filter by project ID (if not provided, returns all tasks)"),
      page: z.number().optional().describe("Page number for pagination (default: 1)"),
      perPage: z.number().optional().describe("Number of items per page (default: 50)"),
      search: z.string().optional().describe("Search tasks by text"),
      sortBy: z
        .string()
        .optional()
        .describe("Sort field: id, title, done, due_date, priority, created, updated"),
      orderBy: z.string().optional().describe("Sort order: asc or desc"),
      filter: z
        .string()
        .optional()
        .describe(
          "Filter query (e.g., 'done = false'). Supports: =, !=, <, >, <=, >=, in, like. Use 'dueDate != null' to exclude tasks with no due date. Date math: now, now+1d, now/d."
        ),
      filterIncludeNulls: z
        .boolean()
        .optional()
        .describe(
          "When false, tasks with no value for the filtered field are excluded. Defaults to true. Set to false to prevent tasks without a due date from matching dueDate filters."
        ),
    },
    async (args) => {
      try {
        const client = getClient();

        const projectFilter =
          args.projectId !== undefined ? `project_id = ${args.projectId}` : undefined;
        const combinedFilter =
          args.filter && projectFilter
            ? `${projectFilter} && ${args.filter}`
            : (projectFilter ?? args.filter);

        const response = await client.get<Task[]>("/tasks", {
          page: args.page,
          per_page: args.perPage,
          s: args.search,
          sort_by: args.sortBy,
          order_by: args.orderBy,
          filter: combinedFilter,
          filter_include_nulls: args.filterIncludeNulls,
        });

        return formatResponse({ tasks: response.data, pagination: response.pagination });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "tasks_get",
    "Get a single task by ID",
    {
      taskId: z.number().describe("The task ID"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.get<Task>(`/tasks/${args.taskId}`);
        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "tasks_create",
    "Create a new task in a project",
    {
      projectId: z.number().describe("Project ID to create the task in (required)"),
      title: z.string().describe("Task title (required)"),
      description: z.string().optional().describe("Task description"),
      dueDate: z
        .string()
        .optional()
        .describe("Due date (ISO 8601 format, e.g., '2024-12-31T23:59:59Z')"),
      startDate: z.string().optional().describe("Start date (ISO 8601 format)"),
      endDate: z.string().optional().describe("End date (ISO 8601 format)"),
      priority: z.number().optional().describe("Priority level (higher = more important)"),
      done: z.boolean().optional().describe("Whether the task is completed"),
      color: z.string().optional().describe("Hex color for the task"),
      percentDone: z.number().optional().describe("Completion percentage (0-1)"),
      assignees: z.array(z.number()).optional().describe("Array of user IDs to assign"),
      labels: z.array(z.number()).optional().describe("Array of label IDs to add"),
      reminders: z
        .array(z.string())
        .optional()
        .describe('Reminders as ISO 8601 datetime strings, e.g. ["2026-06-10T09:00:00Z"]'),
    },
    async (args) => {
      try {
        const client = getClient();
        const body: Record<string, unknown> = {
          title: args.title,
        };
        if (args.description !== undefined) body.description = args.description;
        if (args.dueDate) body.due_date = args.dueDate;
        if (args.startDate) body.start_date = args.startDate;
        if (args.endDate) body.end_date = args.endDate;
        if (args.priority !== undefined) body.priority = args.priority;
        if (args.done !== undefined) body.done = args.done;
        if (args.color !== undefined) body.hex_color = args.color;
        if (args.percentDone !== undefined) body.percent_done = args.percentDone;
        if (args.assignees !== undefined) {
          body.assignees = args.assignees.map((id: number) => ({ id }));
        }
        if (args.labels !== undefined) {
          body.labels = args.labels.map((id: number) => ({ id }));
        }
        if (args.reminders !== undefined) {
          body.reminders = args.reminders.map((r) => ({ reminder: r }));
        }

        const response = await client.put<Task>(`/projects/${args.projectId}/tasks`, body);
        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "tasks_update",
    "Update an existing task",
    {
      taskId: z.number().describe("The task ID (required)"),
      title: z.string().optional().describe("New task title"),
      description: z.string().optional().describe("New task description"),
      dueDate: z
        .string()
        .optional()
        .describe("New due date (ISO 8601 format). Use empty string '' to clear."),
      startDate: z
        .string()
        .optional()
        .describe("New start date (ISO 8601 format). Use empty string '' to clear."),
      endDate: z
        .string()
        .optional()
        .describe("New end date (ISO 8601 format). Use empty string '' to clear."),
      priority: z.number().optional().describe("New priority level"),
      done: z.boolean().optional().describe("Mark as done or not done"),
      color: z.string().optional().describe("New hex color"),
      percentDone: z.number().optional().describe("New completion percentage (0-1)"),
      projectId: z.number().optional().describe("Move task to a different project"),
      bucketId: z.number().optional().describe("Move task to a different kanban bucket"),
      isFavorite: z.boolean().optional().describe("Mark as favorite"),
      repeatAfter: z
        .number()
        .optional()
        .describe(
          "Repeat interval in seconds (e.g. 86400 = daily, 604800 = weekly). Set to 0 to disable."
        ),
      repeatMode: z
        .number()
        .optional()
        .describe("Repeat mode: 0 = from due date, 1 = monthly, 2 = from current date"),
      assignees: z
        .array(z.number())
        .optional()
        .describe("Replace all assignees with this list of user IDs (use [] to remove all)"),
      labels: z
        .array(z.number())
        .optional()
        .describe("Replace all labels with this list of label IDs (use [] to remove all)"),
      reminders: z
        .array(z.string())
        .optional()
        .describe(
          'Replace all reminders with this list of ISO 8601 datetime strings, e.g. ["2026-06-10T09:00:00Z"]. Use [] to remove all.'
        ),
    },
    async (args) => {
      try {
        const changes: Record<string, unknown> = {};
        if (args.title !== undefined) changes.title = args.title;
        if (args.description !== undefined) changes.description = args.description;
        if (args.dueDate !== undefined) changes.due_date = args.dueDate || "0001-01-01T00:00:00Z";
        if (args.startDate !== undefined)
          changes.start_date = args.startDate || "0001-01-01T00:00:00Z";
        if (args.endDate !== undefined) changes.end_date = args.endDate || "0001-01-01T00:00:00Z";
        if (args.priority !== undefined) changes.priority = args.priority;
        if (args.done !== undefined) changes.done = args.done;
        if (args.color !== undefined) changes.hex_color = args.color;
        if (args.percentDone !== undefined) changes.percent_done = args.percentDone;
        if (args.projectId !== undefined) changes.project_id = args.projectId;
        if (args.bucketId !== undefined) changes.bucket_id = args.bucketId;
        if (args.isFavorite !== undefined) changes.is_favorite = args.isFavorite;
        if (args.repeatAfter !== undefined) changes.repeat_after = args.repeatAfter;
        if (args.repeatMode !== undefined) changes.repeat_mode = args.repeatMode;
        if (args.assignees !== undefined) changes.assignees = args.assignees.map((id) => ({ id }));
        if (args.reminders !== undefined)
          changes.reminders = args.reminders.map((r) => ({ reminder: r }));

        const task = await patchTask(args.taskId, changes);

        if (args.bucketId !== undefined && task.project_id !== undefined) {
          try {
            const Q_PATTERN = /^Q[1-4]$/i;
            const client = getClient();
            const [bucketInfo, labelsResp, taskResp] = await Promise.all([
              findBucketInfo(task.project_id, args.bucketId),
              client.get<Label[]>("/labels", { per_page: 100 }),
              client.get<Task>(`/tasks/${args.taskId}`),
            ]);

            if (bucketInfo) {
              await client.post<Task>(
                `/projects/${task.project_id}/views/${bucketInfo.viewId}/buckets/${args.bucketId}/tasks`,
                { task_id: args.taskId }
              );
            }

            const qLabelIds = new Set(
              labelsResp.data.filter((l) => Q_PATTERN.test(l.title)).map((l) => l.id)
            );
            const baseLabels =
              args.labels !== undefined
                ? args.labels.filter((id) => !qLabelIds.has(id)).map((id) => ({ id }))
                : (taskResp.data.labels ?? [])
                    .filter((l) => !qLabelIds.has(l.id))
                    .map((l) => ({ id: l.id }));

            let finalLabels = baseLabels;
            if (bucketInfo && Q_PATTERN.test(bucketInfo.title)) {
              const qLabel = labelsResp.data.find(
                (l) => l.title.toUpperCase() === bucketInfo.title.toUpperCase()
              );
              if (!qLabel) {
                console.error(
                  `[tasks_update] label "${bucketInfo.title.toUpperCase()}" not found — add it manually in Vikunja`
                );
              } else {
                finalLabels = [...baseLabels, { id: qLabel.id }];
              }
            }

            await client.post<{ labels: Label[] }>(`/tasks/${args.taskId}/labels/bulk`, {
              labels: finalLabels,
            });
          } catch (labelErr) {
            console.error(`[tasks_update] Q-label sync failed for task ${args.taskId}:`, labelErr);
          }
        } else if (args.labels !== undefined) {
          try {
            const client = getClient();
            await client.post<{ labels: Label[] }>(`/tasks/${args.taskId}/labels/bulk`, {
              labels: args.labels.map((id) => ({ id })),
            });
          } catch (labelErr) {
            console.error(`[tasks_update] label update failed for task ${args.taskId}:`, labelErr);
          }
        }

        return formatResponse(task);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "tasks_delete",
    "Delete a task",
    {
      taskId: z.number().describe("The task ID to delete"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.delete<Message>(`/tasks/${args.taskId}`);
        return formatResponse({ ...response.data, success: true, message: "Task deleted" });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // ============================================================================
  // Label Tools
  // ============================================================================

  server.tool(
    "labels_list",
    "List all labels the user has access to",
    {
      page: z.number().optional().describe("Page number for pagination"),
      perPage: z.number().optional().describe("Number of items per page"),
      search: z.string().optional().describe("Search labels by title"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.get<Label[]>("/labels", {
          page: args.page,
          per_page: args.perPage,
          s: args.search,
        });
        return formatResponse({ labels: response.data, pagination: response.pagination });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "labels_get",
    "Get a single label by ID",
    {
      labelId: z.number().describe("The label ID"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.get<Label>(`/labels/${args.labelId}`);
        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "labels_create",
    "Create a new label",
    {
      title: z.string().describe("Label title (required)"),
      description: z.string().optional().describe("Label description"),
      color: z.string().optional().describe("Hex color (e.g., 'ff0000')"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.put<Label>("/labels", {
          title: args.title,
          description: args.description,
          hex_color: args.color,
        });
        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "labels_delete",
    "Delete a label",
    {
      labelId: z.number().describe("The label ID to delete"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.delete<Message>(`/labels/${args.labelId}`);
        return formatResponse({ ...response.data, success: true, message: "Label deleted" });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "task_labels_add",
    "Add a label to a task",
    {
      taskId: z.number().describe("The task ID"),
      labelId: z.number().describe("The label ID to add"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.put<Label>(`/tasks/${args.taskId}/labels`, {
          label_id: args.labelId,
        });
        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "task_labels_remove",
    "Remove a label from a task",
    {
      taskId: z.number().describe("The task ID"),
      labelId: z.number().describe("The label ID to remove"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.delete<Message>(
          `/tasks/${args.taskId}/labels/${args.labelId}`
        );
        return formatResponse({
          ...response.data,
          success: true,
          message: "Label removed from task",
        });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // ============================================================================
  // Comment Tools
  // ============================================================================

  server.tool(
    "task_comments_list",
    "List all comments on a task",
    {
      taskId: z.number().describe("The task ID"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.get<TaskComment[]>(`/tasks/${args.taskId}/comments`);
        return formatResponse({ comments: response.data });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "task_comments_add",
    "Add a comment to a task",
    {
      taskId: z.number().describe("The task ID"),
      comment: z.string().describe("The comment text"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.put<TaskComment>(`/tasks/${args.taskId}/comments`, {
          comment: args.comment,
        });
        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "task_comments_update",
    "Update the text of an existing task comment",
    {
      taskId: z.number().describe("The task ID"),
      commentId: z.number().describe("The comment ID"),
      comment: z.string().describe("New comment text"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.post<TaskComment>(
          `/tasks/${args.taskId}/comments/${args.commentId}`,
          { comment: args.comment }
        );
        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "task_comments_delete",
    "Delete a comment from a task",
    {
      taskId: z.number().describe("The task ID"),
      commentId: z.number().describe("The comment ID to delete"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.delete<Message>(
          `/tasks/${args.taskId}/comments/${args.commentId}`
        );
        return formatResponse({ ...response.data, success: true, message: "Comment deleted" });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // ============================================================================
  // Assignee Tools
  // ============================================================================

  server.tool(
    "task_assignees_list",
    "List all assignees on a task",
    {
      taskId: z.number().describe("The task ID"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.get<User[]>(`/tasks/${args.taskId}/assignees`);
        return formatResponse({ assignees: response.data });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "task_assignees_add",
    "Add an assignee to a task",
    {
      taskId: z.number().describe("The task ID"),
      userId: z.number().describe("The user ID to assign"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.put<User>(`/tasks/${args.taskId}/assignees`, {
          user_id: args.userId,
        });
        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "task_assignees_remove",
    "Remove an assignee from a task",
    {
      taskId: z.number().describe("The task ID"),
      userId: z.number().describe("The user ID to remove"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.delete<Message>(
          `/tasks/${args.taskId}/assignees/${args.userId}`
        );
        return formatResponse({
          ...response.data,
          success: true,
          message: "Assignee removed from task",
        });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // ============================================================================
  // Task Relation Tools
  // ============================================================================

  server.tool(
    "task_relations_add",
    "Create a relation between two tasks",
    {
      taskId: z.number().describe("The source task ID"),
      otherTaskId: z.number().describe("The target task ID"),
      relationKind: z.enum(RELATION_KINDS).describe("Relation type"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.put<TaskRelation>(`/tasks/${args.taskId}/relations`, {
          other_task_id: args.otherTaskId,
          relation_kind: args.relationKind,
        });
        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "task_relations_remove",
    "Remove a relation between two tasks",
    {
      taskId: z.number().describe("The source task ID"),
      otherTaskId: z.number().describe("The target task ID"),
      relationKind: z.enum(RELATION_KINDS).describe("Relation type to remove"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.delete<Message>(
          `/tasks/${args.taskId}/relations/${args.relationKind}/${args.otherTaskId}`
        );
        return formatResponse({
          ...response.data,
          success: true,
          message: "Task relation removed",
        });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // ============================================================================
  // Project View Tools
  // ============================================================================

  server.tool(
    "project_views_list",
    "List all views for a project",
    {
      projectId: z.number().describe("The project ID"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.get<ProjectView[]>(`/projects/${args.projectId}/views`);
        return formatResponse({ views: response.data });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // ============================================================================
  server.tool(
    "project_views_get",
    "Get a single project view by ID",
    {
      projectId: z.number().describe("The project ID"),
      viewId: z.number().describe("The view ID"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.get<ProjectView>(
          `/projects/${args.projectId}/views/${args.viewId}`
        );
        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Bucket (Kanban) Tools
  // ============================================================================

  server.tool(
    "buckets_list",
    "List all kanban buckets for a project view",
    {
      projectId: z.number().describe("The project ID"),
      viewId: z.number().describe("The project view ID (must be a kanban view)"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.get<Bucket[]>(
          `/projects/${args.projectId}/views/${args.viewId}/buckets`
        );
        return formatResponse({ buckets: response.data });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "buckets_create",
    "Create a new kanban bucket",
    {
      projectId: z.number().describe("The project ID"),
      viewId: z.number().describe("The project view ID (must be a kanban view)"),
      title: z.string().describe("Bucket title"),
      limit: z.number().optional().describe("Max tasks in bucket (0 = unlimited)"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.put<Bucket>(
          `/projects/${args.projectId}/views/${args.viewId}/buckets`,
          {
            title: args.title,
            limit: args.limit,
          }
        );
        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "buckets_delete",
    "Delete a kanban bucket",
    {
      projectId: z.number().describe("The project ID"),
      viewId: z.number().describe("The project view ID"),
      bucketId: z.number().describe("The bucket ID to delete"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.delete<Message>(
          `/projects/${args.projectId}/views/${args.viewId}/buckets/${args.bucketId}`
        );
        return formatResponse({ ...response.data, success: true, message: "Bucket deleted" });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    "task_move_to_bucket",
    "Move a task to a different kanban bucket (column). Automatically adds the matching Q1–Q4 label when moving to a Q-named bucket. Note: after moving, GET /tasks/{id} will still show bucket_id: 0 — this is a known Vikunja behavior. Verify the move by listing the target bucket's tasks instead.",
    {
      taskId: z.number().describe("The task ID to move"),
      bucketId: z.number().describe("The target bucket ID"),
      viewId: z.number().describe("The project view ID (kanban view containing the bucket)"),
      projectId: z
        .number()
        .optional()
        .describe("The project ID — fetched automatically from the task if not provided"),
      position: z.number().optional().describe("Position within the bucket for ordering"),
    },
    async (args) => {
      try {
        const client = getClient();
        let projectId = args.projectId;
        if (!projectId) {
          const { data: task } = await client.get<Task>(`/tasks/${args.taskId}`);
          projectId = task.project_id;
        }
        const body: Record<string, unknown> = { task_id: args.taskId };
        if (args.position !== undefined) body.position = args.position;
        const response = await client.post<Task>(
          `/projects/${projectId}/views/${args.viewId}/buckets/${args.bucketId}/tasks`,
          body
        );

        try {
          const Q_PATTERN = /^Q[1-4]$/i;
          const [bucketsResp, taskResp, labelsResp] = await Promise.all([
            client.get<Bucket[]>(`/projects/${projectId}/views/${args.viewId}/buckets`),
            client.get<Task>(`/tasks/${args.taskId}`),
            client.get<Label[]>("/labels", { per_page: 100 }),
          ]);
          const targetBucket = bucketsResp.data.find((b) => b.id === args.bucketId);
          const qLabelIds = new Set(
            labelsResp.data.filter((l) => Q_PATTERN.test(l.title)).map((l) => l.id)
          );
          const nonQLabels = (taskResp.data.labels ?? [])
            .filter((l) => !qLabelIds.has(l.id))
            .map((l) => ({ id: l.id }));

          let finalLabels = nonQLabels;
          if (targetBucket && Q_PATTERN.test(targetBucket.title)) {
            const qLabel = labelsResp.data.find(
              (l) => l.title.toUpperCase() === targetBucket.title.toUpperCase()
            );
            if (!qLabel) {
              console.error(
                `[task_move_to_bucket] label "${targetBucket.title.toUpperCase()}" not found — add it manually in Vikunja`
              );
            } else {
              finalLabels = [...nonQLabels, { id: qLabel.id }];
            }
          }

          await client.post<{ labels: Label[] }>(`/tasks/${args.taskId}/labels/bulk`, {
            labels: finalLabels,
          });
        } catch (labelErr) {
          console.error(
            `[task_move_to_bucket] Q-label sync failed for task ${args.taskId}:`,
            labelErr
          );
        }

        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // ============================================================================
  // Team Tools
  // ============================================================================

  server.tool(
    "teams_list",
    "List all teams the user belongs to",
    {
      page: z.number().optional().describe("Page number for pagination"),
      perPage: z.number().optional().describe("Number of items per page"),
      search: z.string().optional().describe("Search teams by name"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.get<Team[]>("/teams", {
          page: args.page,
          per_page: args.perPage,
          s: args.search,
        });
        return formatResponse({ teams: response.data, pagination: response.pagination });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // ============================================================================
  // User Tools
  // ============================================================================

  server.tool(
    "users_search",
    "Search for users by username, name, or email",
    {
      search: z.string().describe("Search term (required)"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.get<User[]>("/users", {
          s: args.search,
        });
        return formatResponse({ users: response.data });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // ============================================================================
  server.tool("user_get", "Get the currently authenticated user's profile", {}, async () => {
    try {
      const client = getClient();
      const response = await client.get<User>("/user");
      return formatResponse(response.data);
    } catch (error) {
      return formatError(error);
    }
  });

  // ============================================================================
  // Saved Filter Tools
  // ============================================================================

  server.tool("filters_list", "List all saved filters for the current user", {}, async () => {
    try {
      const client = getClient();
      const response = await client.get<SavedFilter[]>("/filters");
      return formatResponse({ filters: response.data });
    } catch (error) {
      return formatError(error);
    }
  });

  server.tool(
    "filters_get",
    "Get a single saved filter by ID",
    {
      filterId: z.number().describe("The filter ID"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.get<SavedFilter>(`/filters/${args.filterId}`);
        return formatResponse(response.data);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  // Notification Tools
  // ============================================================================

  server.tool(
    "notifications_list",
    "List all notifications for the current user",
    {
      page: z.number().optional().describe("Page number for pagination"),
      perPage: z.number().optional().describe("Number of items per page"),
    },
    async (args) => {
      try {
        const client = getClient();
        const response = await client.get<Notification[]>("/notifications", {
          page: args.page,
          per_page: args.perPage,
        });
        return formatResponse({ notifications: response.data, pagination: response.pagination });
      } catch (error) {
        return formatError(error);
      }
    }
  );

  return server;
}

// Start the server
export function createHttpServer(mcpToken: string): Server {
  const expectedAuth = Buffer.from(`Bearer ${mcpToken}`);
  const sessions = new Map<string, SSEServerTransport>();
  const MAX_BODY_BYTES = 1_048_576; // 1 MiB

  const httpServer = createServer(async (req, res) => {
    const { pathname, searchParams } = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`
    );

    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payload too large" }));
      return;
    }

    const authHeader = req.headers["authorization"];
    const providedAuth = Buffer.from(typeof authHeader === "string" ? authHeader : "");
    if (
      providedAuth.length !== expectedAuth.length ||
      !timingSafeEqual(providedAuth, expectedAuth)
    ) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // GET /sse — establish SSE stream (old HTTP+SSE protocol used by nanobot)
    if (req.method === "GET" && pathname === "/sse") {
      const vikunjaToken = req.headers["x-vikunja-token"];
      if (!vikunjaToken || typeof vikunjaToken !== "string") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing X-Vikunja-Token header" }));
        return;
      }
      if (!/^[A-Za-z0-9._\-+/=]{1,512}$/.test(vikunjaToken)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid X-Vikunja-Token format" }));
        return;
      }

      const transport = new SSEServerTransport("/messages", res);
      sessions.set(transport.sessionId, transport);

      // SSE comment heartbeat — keeps the TCP connection alive through NAT tables
      // and reverse-proxy idle timeouts. Comment lines are ignored by all SSE clients.
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(": heartbeat\n\n");
        }
      }, 15_000);

      res.on("close", () => {
        clearInterval(heartbeat);
        sessions.delete(transport.sessionId);
        transport.close();
      });

      const server = createMcpServer();
      await server.connect(transport);
      return;
    }

    // POST /messages — receive tool calls, route to the right SSE session
    if (req.method === "POST" && pathname === "/messages") {
      const vikunjaToken = req.headers["x-vikunja-token"];
      if (!vikunjaToken || typeof vikunjaToken !== "string") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing X-Vikunja-Token header" }));
        return;
      }
      if (!/^[A-Za-z0-9._\-+/=]{1,512}$/.test(vikunjaToken)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid X-Vikunja-Token format" }));
        return;
      }

      const sessionId = searchParams.get("sessionId");
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing sessionId query parameter" }));
        return;
      }

      const transport = sessions.get(sessionId);
      if (!transport) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      tokenStore.run(vikunjaToken, () => {
        transport.handlePostMessage(req, res).catch((err: unknown) => {
          console.error("Error handling POST message:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        });
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 60_000;
  httpServer.maxConnections = 100;

  return httpServer;
}

async function main() {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const host = process.env.HOST ?? "0.0.0.0";
  const mcpToken = process.env.VIKUNJA_MCP_TOKEN;
  if (!mcpToken) {
    throw new Error("VIKUNJA_MCP_TOKEN environment variable is required");
  }

  const vikunjaUrl = process.env.VIKUNJA_URL;
  if (!vikunjaUrl) {
    throw new Error("VIKUNJA_URL environment variable is required");
  }
  try {
    new URL(vikunjaUrl);
  } catch {
    throw new Error(`VIKUNJA_URL is not a valid URL: ${vikunjaUrl}`);
  }

  const httpServer = createHttpServer(mcpToken);

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, resolve);
  });

  console.error(`Vikunja MCP server listening on http://${host}:${port}/sse`);

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down gracefully`);
    httpServer.close((err) => {
      if (err) {
        console.error("Error during shutdown:", err);
        process.exit(1);
      }
      process.exit(0);
    });
    setTimeout(() => {
      console.error("Forcing shutdown after 10s timeout");
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
