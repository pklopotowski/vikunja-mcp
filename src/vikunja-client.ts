import { tokenStore } from "./request-context.js";

/**
 * Vikunja API Client
 * HTTP wrapper for the Vikunja REST API
 */

export interface PaginationInfo {
  page: number;
  perPage: number;
  totalPages: number | null;
  resultCount: number | null;
}

export interface ApiResponse<T> {
  data: T;
  pagination?: PaginationInfo;
}

export interface ApiErrorDetails {
  code: number;
  message: string;
}

/**
 * Custom error class for Vikunja API errors with enhanced details
 */
export class VikunjaApiError extends Error {
  public readonly statusCode: number;
  public readonly endpoint: string;
  public readonly method: string;
  public readonly suggestion?: string;

  constructor(options: {
    message: string;
    statusCode: number;
    endpoint: string;
    method: string;
    suggestion?: string;
  }) {
    super(options.message);
    this.name = "VikunjaApiError";
    this.statusCode = options.statusCode;
    this.endpoint = options.endpoint;
    this.method = options.method;
    this.suggestion = options.suggestion;
  }

  /**
   * Get a formatted error message with all details
   */
  toDetailedString(): string {
    let details = `[${this.method} ${this.endpoint}] ${this.statusCode}: ${this.message}`;
    if (this.suggestion) {
      details += ` (${this.suggestion})`;
    }
    return details;
  }
}

/**
 * Get a helpful suggestion based on the HTTP status code
 */
function getErrorSuggestion(statusCode: number): string | undefined {
  switch (statusCode) {
    case 401:
      return "Check that your Vikunja API token is valid and not expired";
    case 403:
      return "You may not have permission to access this resource";
    case 404:
      return "The requested resource does not exist or has been deleted";
    case 429:
      return "Rate limit exceeded. Please wait before making more requests";
    case 500:
      return "Server error. Please try again later or check Vikunja server logs";
    case 502:
    case 503:
    case 504:
      return "Server is temporarily unavailable. Please try again later";
    default:
      return undefined;
  }
}

/**
 * Build an enhanced error message
 */
function buildErrorMessage(
  method: string,
  path: string,
  statusCode: number,
  statusText: string,
  apiMessage?: string
): VikunjaApiError {
  const baseMessage = apiMessage || `${statusCode} ${statusText}`;
  const suggestion = getErrorSuggestion(statusCode);

  return new VikunjaApiError({
    message: baseMessage,
    statusCode,
    endpoint: path,
    method,
    suggestion,
  });
}

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 4000,
};

// Per-attempt timeout for outbound requests to Vikunja
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable
 * - Network errors (fetch throws)
 * - 5xx server errors
 * - 429 Too Many Requests
 */
function isRetryableError(error: unknown, status?: number): boolean {
  // Network errors (fetch throws an error)
  if (error instanceof TypeError) {
    return true;
  }

  // Server errors (5xx) and rate limiting (429)
  if (status !== undefined) {
    return status >= 500 || status === 429;
  }

  return false;
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function getRetryDelay(attempt: number): number {
  const baseDelay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
  // Add jitter (0-25% of base delay)
  const jitter = baseDelay * 0.25 * Math.random();
  return Math.min(baseDelay + jitter, RETRY_CONFIG.maxDelayMs);
}

export class VikunjaClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  /**
   * Make an authenticated request to the Vikunja API with retry logic
   */
  async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
    } = {}
  ): Promise<ApiResponse<T>> {
    // Build URL with query parameters
    let url = `${this.baseUrl}/api/v1${path}`;

    if (options.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null && value !== "") {
          params.append(key, String(value));
        }
      }
      const queryString = params.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (options.body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, { ...fetchOptions, signal: controller.signal });

        // Extract pagination headers
        const pagination: PaginationInfo = {
          page: 1,
          perPage: 50,
          totalPages: response.headers.get("x-pagination-total-pages")
            ? parseInt(response.headers.get("x-pagination-total-pages")!, 10)
            : null,
          resultCount: response.headers.get("x-pagination-result-count")
            ? parseInt(response.headers.get("x-pagination-result-count")!, 10)
            : null,
        };

        if (!response.ok) {
          // Check if this is a retryable error (5xx or 429)
          if (isRetryableError(null, response.status) && attempt < RETRY_CONFIG.maxRetries) {
            const delay = getRetryDelay(attempt);
            await sleep(delay);
            continue;
          }

          let apiMessage: string | undefined;
          try {
            const errorBody = await response.json();
            if (errorBody.message) {
              apiMessage = errorBody.message;
            }
          } catch {
            // Ignore JSON parse errors for error responses
          }

          throw buildErrorMessage(method, path, response.status, response.statusText, apiMessage);
        }

        // Handle empty responses (204 No Content, etc.)
        if (response.status === 204 || response.headers.get("content-length") === "0") {
          return { data: {} as T };
        }

        const data = await response.json();

        return {
          data,
          pagination: pagination.totalPages !== null ? pagination : undefined,
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          lastError = new VikunjaApiError({
            message: `Request timed out after ${REQUEST_TIMEOUT_MS}ms`,
            statusCode: 504,
            endpoint: path,
            method,
            suggestion: "Vikunja did not respond in time. Try again later.",
          });
          throw lastError;
        }

        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if this is a retryable network error
        if (isRetryableError(error) && attempt < RETRY_CONFIG.maxRetries) {
          const delay = getRetryDelay(attempt);
          await sleep(delay);
          continue;
        }

        throw lastError;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // Should never reach here, but TypeScript needs it
    throw lastError ?? new Error("Request failed after retries");
  }

  // Convenience methods
  async get<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<ApiResponse<T>> {
    return this.request<T>("GET", path, { query });
  }

  async post<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>("POST", path, { body });
  }

  async put<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>("PUT", path, { body });
  }

  async delete<T>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>("DELETE", path);
  }
}

export function getClient(): VikunjaClient {
  const baseUrl = process.env.VIKUNJA_URL;
  if (!baseUrl) {
    throw new Error("VIKUNJA_URL environment variable is required");
  }

  const token = tokenStore.getStore();
  if (!token) {
    throw new Error("No Vikunja API token in request context");
  }

  return new VikunjaClient(baseUrl, token);
}
