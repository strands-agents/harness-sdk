/**
 * Input parameters for HTTP request.
 */
export interface HttpRequestInput {
  /**
   * HTTP method to use for the request.
   */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'

  /**
   * URL to send the request to.
   */
  url: string

  /**
   * Optional HTTP headers as key-value pairs.
   */
  headers?: Record<string, string>

  /**
   * Optional request body as a string.
   */
  body?: string

  /**
   * Optional timeout in seconds (default: 30).
   */
  timeout?: number
}

/**
 * Output from HTTP request containing response details.
 */
export interface HttpRequestOutput {
  /**
   * HTTP status code.
   */
  status: number

  /**
   * HTTP status text.
   */
  statusText: string

  /**
   * Response headers as key-value pairs.
   */
  headers: Record<string, string>

  /**
   * Response body as text.
   */
  body: string
}
