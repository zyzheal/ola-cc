/**
 * 自研 Anthropic API 错误类
 * 替代 @anthropic-ai/sdk/error
 */

export type APIErrorType =
  | 'authentication_error'
  | 'rate_limit_error'
  | 'retry_error'
  | 'server_error'
  | 'invalid_request_error'
  | 'permission_error'
  | 'not_found_error'
  | 'unhandled_error';

/**
 * Anthropic API Error
 * Compatible with @anthropic-ai/sdk APIError
 */
export class APIError extends Error {
  readonly name: string = 'APIError';
  readonly status: number;
  readonly type: APIErrorType;
  readonly isRetryable: boolean;
  readonly headers: Record<string, string>;
  readonly error?: { type: string; message: string };
  readonly requestID?: string;

  constructor(
    status: number,
    message: string,
    type?: APIErrorType,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.type = type ?? this.inferType(status, message);
    this.headers = headers;
    this.isRetryable = this.checkRetryable(status, type);
  }

  private inferType(status: number, message: string): APIErrorType {
    const lowerMessage = message.toLowerCase();

    if (status === 401 || lowerMessage.includes('authentication')) {
      return 'authentication_error';
    }
    if (status === 403 || lowerMessage.includes('permission')) {
      return 'permission_error';
    }
    if (status === 404 || lowerMessage.includes('not found')) {
      return 'not_found_error';
    }
    if (status === 429 || lowerMessage.includes('rate_limit') || lowerMessage.includes('rate limit')) {
      return 'rate_limit_error';
    }
    if (status >= 500) {
      return 'server_error';
    }
    if (status >= 400) {
      return 'invalid_request_error';
    }
    return 'unhandled_error';
  }

  private checkRetryable(status: number, type?: APIErrorType): boolean {
    if (type === 'rate_limit_error' || type === 'server_error' || type === 'retry_error') {
      return true;
    }
    return status >= 500 || status === 429;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      type: this.type,
      isRetryable: this.isRetryable,
    };
  }
}

/**
 * User aborted error - used when user interrupts a request
 */
export class APIUserAbortError extends APIError {
  readonly name: string = 'APIUserAbortError';

  constructor(message: string = 'Request aborted by user') {
    super(499, message, 'unhandled_error');
    this.name = 'APIUserAbortError';
  }
}

/**
 * Rate limit error with additional metadata
 */
export class APIRateLimitError extends APIError {
  readonly retryAfter: number | undefined;
  readonly limit: number | undefined;

  constructor(
    status: number,
    message: string,
    headers: Record<string, string> = {},
  ) {
    super(status, message, 'rate_limit_error', headers);
    // Parse retry-after header
    const retryAfter = headers['retry-after'];
    this.retryAfter = retryAfter ? parseInt(retryAfter, 10) : undefined;

    // Try to extract limit from headers
    const limitHeader = headers['x-ratelimit-limit'];
    this.limit = limitHeader ? parseInt(limitHeader, 10) : undefined;
  }
}

/**
 * Create appropriate error instance based on response
 */
export function createAPIError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): APIError {
  // Special handling for rate limit
  if (status === 429) {
    return new APIRateLimitError(status, message, headers);
  }

  // Special handling for user abort
  if (status === 499 || message.toLowerCase().includes('aborted')) {
    return new APIUserAbortError(message);
  }

  return new APIError(status, message, undefined, headers);
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof APIError) {
    return error.isRetryable;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('rate_limit') ||
      message.includes('rate limit') ||
      message.includes('overloaded') ||
      message.includes('timeout')
    );
  }
  return false;
}