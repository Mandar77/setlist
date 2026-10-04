/**
 * The YouTube failures that change behaviour, in the shape the real API returns them.
 *
 * Only the ones the adapter has to branch on. A simulator that returned a generic
 * `Error` would let `yt-adapter` pass its tests with no branch at all, and then meet
 * `quotaExceeded` for the first time in production — where PED FR-M-016 says the user
 * must never see it.
 *
 * The distinction that matters most is between the two 403s. `quotaExceeded` means the
 * daily allowance is gone and nothing will change until the Pacific-time reset, so the
 * job is DEFERRED to the 00:05 PT Scheduler run (PED §10.4). `rateLimitExceeded` means
 * too fast, not too much, and the same request will succeed after a backoff. Treating
 * them alike either wastes a day or hammers a rate limit.
 */

export type YouTubeReason =
  | 'quotaExceeded'
  | 'rateLimitExceeded'
  | 'userRateLimitExceeded'
  | 'forbidden'
  | 'playlistNotFound'
  | 'backendError'

export interface YouTubeErrorBody {
  readonly error: {
    readonly code: number
    readonly message: string
    readonly errors: readonly { readonly reason: YouTubeReason; readonly domain: string }[]
  }
}

export class YouTubeApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: YouTubeReason,
    /** Seconds, when the API supplies one. Only rate limits carry it. */
    readonly retryAfter: number | null,
    readonly body: YouTubeErrorBody,
  ) {
    super(`${status} ${reason}`)
    this.name = 'YouTubeApiError'
  }

  /**
   * Whether retrying the identical request could succeed without waiting for the daily
   * reset.
   *
   * `quotaExceeded` is deliberately NOT retryable: the units are gone until midnight
   * Pacific, and a retry loop against it is how a quota outage becomes a thundering herd
   * that is still failing when the quota returns.
   */
  get retryable(): boolean {
    return (
      this.reason === 'rateLimitExceeded' ||
      this.reason === 'userRateLimitExceeded' ||
      this.reason === 'backendError'
    )
  }

  /** Whether the job should be deferred to the next quota window instead of retried. */
  get deferrable(): boolean {
    return this.reason === 'quotaExceeded'
  }
}

function body(code: number, message: string, reason: YouTubeReason): YouTubeErrorBody {
  return {
    error: { code, message, errors: [{ reason, domain: 'youtube.quota' }] },
  }
}

/** 403 with `quotaExceeded`: the daily unit allowance is gone. */
export function quotaExceeded(): YouTubeApiError {
  return new YouTubeApiError(
    403,
    'quotaExceeded',
    null,
    body(
      403,
      'The request cannot be completed because you have exceeded your quota.',
      'quotaExceeded',
    ),
  )
}

/** 429 with `rateLimitExceeded` and a Retry-After, which the adapter must honour. */
export function rateLimited(retryAfterSeconds: number): YouTubeApiError {
  return new YouTubeApiError(
    429,
    'rateLimitExceeded',
    retryAfterSeconds,
    body(429, 'Too many requests.', 'rateLimitExceeded'),
  )
}

/** 404 for a playlist that is gone — the compensation path in the saga. */
export function playlistNotFound(): YouTubeApiError {
  return new YouTubeApiError(
    404,
    'playlistNotFound',
    null,
    body(404, 'Playlist not found.', 'playlistNotFound'),
  )
}

/** 500, which is retryable and carries no Retry-After. */
export function backendError(): YouTubeApiError {
  return new YouTubeApiError(500, 'backendError', null, body(500, 'Backend Error', 'backendError'))
}
