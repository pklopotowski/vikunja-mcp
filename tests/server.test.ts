import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { request } from "node:http";

const MOCK_SESSION_ID = "mock-session-id-abc123";

const mockHandlePostMessage = vi.fn().mockResolvedValue(undefined);
const mockTransportClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/sse.js", () => ({
  SSEServerTransport: class MockSSEServerTransport {
    sessionId = MOCK_SESSION_ID;
    close = mockTransportClose;
    handlePostMessage = mockHandlePostMessage;
    constructor(_path: string, res: ServerResponse) {
      // Write headers and immediately end so test HTTP clients receive a complete response.
      // Use Connection: close to match the client-side Connection: close header and prevent
      // socket reuse after the mock SSE "stream" ends.
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "close",
      });
      res.end();
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class MockMcpServer {
    tool = vi.fn();
    connect = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("../src/vikunja-client.js", () => ({
  getClient: vi.fn(),
  VikunjaClient: class {},
}));

const MCP_TOKEN = "super-secret-test-token";
const VALID_VIKUNJA_TOKEN = "vikunja_api_token_abc123";
const AUTH_HEADER = `Bearer ${MCP_TOKEN}`;

function httpRequest(
  server: Server,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<{ status: number; body: unknown }> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: options.path,
        method: options.method,
        // Force close each connection to avoid keep-alive state bleed between tests
        headers: { Connection: "close", ...(options.headers ?? {}) },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}


describe("HTTP Server", () => {
  let server: Server;

  beforeAll(async () => {
    const { createHttpServer } = await import("../src/index.js");
    server = createHttpServer(MCP_TOKEN);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterAll(() => {
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ============================================================================
  // Health check (unauthenticated)
  // ============================================================================

  describe("GET /healthz", () => {
    it("returns 200 with status ok without auth", async () => {
      const res = await httpRequest(server, { method: "GET", path: "/healthz" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    });
  });

  // ============================================================================
  // Authentication
  // ============================================================================

  describe("Authorization header", () => {
    it("rejects request with no Authorization header", async () => {
      const res = await httpRequest(server, { method: "GET", path: "/sse" });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: "Unauthorized" });
    });

    it("rejects request with wrong token", async () => {
      const res = await httpRequest(server, {
        method: "GET",
        path: "/sse",
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: "Unauthorized" });
    });

    it("rejects request with malformed Authorization header", async () => {
      const res = await httpRequest(server, {
        method: "GET",
        path: "/sse",
        headers: { Authorization: MCP_TOKEN },
      });
      expect(res.status).toBe(401);
    });
  });

  // ============================================================================
  // Payload size guard
  // ============================================================================

  describe("Payload too large", () => {
    it("rejects requests where Content-Length exceeds 1 MiB", async () => {
      const res = await httpRequest(server, {
        method: "POST",
        path: "/messages?sessionId=x",
        headers: {
          Authorization: AUTH_HEADER,
          "Content-Length": String(1_048_577),
          "X-Vikunja-Token": VALID_VIKUNJA_TOKEN,
        },
      });
      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ error: "Payload too large" });
    });
  });

  // ============================================================================
  // GET /sse — X-Vikunja-Token validation
  // ============================================================================

  describe("GET /sse — X-Vikunja-Token", () => {
    it("rejects when X-Vikunja-Token header is missing", async () => {
      const res = await httpRequest(server, {
        method: "GET",
        path: "/sse",
        headers: { Authorization: AUTH_HEADER },
      });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: "Missing X-Vikunja-Token header" });
    });

    it("rejects when X-Vikunja-Token contains invalid characters", async () => {
      const res = await httpRequest(server, {
        method: "GET",
        path: "/sse",
        headers: {
          Authorization: AUTH_HEADER,
          "X-Vikunja-Token": "<script>alert(1)</script>",
        },
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Invalid X-Vikunja-Token format" });
    });

    it("rejects when X-Vikunja-Token exceeds 512 characters", async () => {
      const res = await httpRequest(server, {
        method: "GET",
        path: "/sse",
        headers: {
          Authorization: AUTH_HEADER,
          "X-Vikunja-Token": "a".repeat(513),
        },
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Invalid X-Vikunja-Token format" });
    });

    it("opens SSE stream when token is valid alphanumeric", async () => {
      const res = await httpRequest(server, {
        method: "GET",
        path: "/sse",
        headers: { Authorization: AUTH_HEADER, "X-Vikunja-Token": VALID_VIKUNJA_TOKEN },
      });
      expect(res.status).toBe(200);
    });

    it("token format regex allows base64 special characters and max length", () => {
      const regex = /^[A-Za-z0-9._\-+/=]{1,512}$/;
      expect(regex.test("abc.def-ghi+jkl/mno=pqr")).toBe(true);
      expect(regex.test("a".repeat(512))).toBe(true);
      expect(regex.test("a".repeat(513))).toBe(false);
      expect(regex.test("<script>")).toBe(false);
      expect(regex.test("'; DROP TABLE--")).toBe(false);
      expect(regex.test("")).toBe(false);
    });
  });

  // ============================================================================
  // POST /messages — session routing
  // ============================================================================

  describe("POST /messages", () => {
    it("rejects when X-Vikunja-Token header is missing", async () => {
      const res = await httpRequest(server, {
        method: "POST",
        path: "/messages?sessionId=abc",
        headers: { Authorization: AUTH_HEADER },
      });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: "Missing X-Vikunja-Token header" });
    });

    it("rejects when X-Vikunja-Token contains invalid characters", async () => {
      const res = await httpRequest(server, {
        method: "POST",
        path: "/messages?sessionId=abc",
        headers: {
          Authorization: AUTH_HEADER,
          "X-Vikunja-Token": "'; DROP TABLE tasks; --",
        },
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Invalid X-Vikunja-Token format" });
    });

    it("rejects when sessionId query param is missing", async () => {
      const res = await httpRequest(server, {
        method: "POST",
        path: "/messages",
        headers: {
          Authorization: AUTH_HEADER,
          "X-Vikunja-Token": VALID_VIKUNJA_TOKEN,
        },
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Missing sessionId query parameter" });
    });

    it("returns 404 for unknown sessionId", async () => {
      const res = await httpRequest(server, {
        method: "POST",
        path: "/messages?sessionId=nonexistent-session",
        headers: {
          Authorization: AUTH_HEADER,
          "X-Vikunja-Token": VALID_VIKUNJA_TOKEN,
        },
      });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Session not found" });
    });
  });

  // ============================================================================
  // Unknown routes
  // ============================================================================

  describe("Unknown routes", () => {
    it("returns 404 for unrecognised path", async () => {
      const res = await httpRequest(server, {
        method: "GET",
        path: "/unknown-path",
        headers: { Authorization: AUTH_HEADER },
      });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Not found" });
    });

    it("returns 404 for DELETE method on /sse", async () => {
      const res = await httpRequest(server, {
        method: "DELETE",
        path: "/sse",
        headers: {
          Authorization: AUTH_HEADER,
          "X-Vikunja-Token": VALID_VIKUNJA_TOKEN,
        },
      });
      expect(res.status).toBe(404);
    });
  });
});
