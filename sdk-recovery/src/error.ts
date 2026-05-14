/**
 * Error types — re-export for @anthropic-ai/sdk/error compatibility.
 */
export {
  APIError,
  APIUserAbortError,
  APIRateLimitError,
  createAPIError,
  isRetryableError,
} from './utils/error.js';

// These subclasses are defined in compat.ts
export {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
} from './compat.js';

export type { APIErrorType } from './utils/error.js';
