/**
 * Express-based A2A server that exposes a Strands Agent as an A2A-compliant HTTP endpoint.
 *
 * Separated from the base {@link A2AServer} so that importing the core A2A module
 * does not pull in Express as a dependency, keeping it browser-compatible.
 *
 * The A2A protocol is experimental, so breaking changes in the underlying SDK
 * may require breaking changes in this module.
 */

import express, { type Router } from 'express'
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express'
import { A2AServer, type A2AServerConfig } from './server.js'
import { logExperimentalWarning } from './logging.js'
import { logger } from '../logging/logger.js'

/**
 * Configuration options for creating an A2AExpressServer.
 */
export interface A2AExpressServerConfig extends A2AServerConfig {
  /** Host to bind the server to (default: '127.0.0.1') */
  host?: string
  /** Port to listen on (default: 9000) */
  port?: number
  /** User builder for authentication (default: no authentication) */
  userBuilder?: UserBuilder
}

/**
 * Express-based A2A server implementation.
 *
 * Provides two usage modes:
 * - **Standalone**: Call {@link serve} to start a self-contained HTTP server.
 * - **Middleware**: Call {@link createMiddleware} to get an Express Router that
 *   can be mounted in an existing Express application.
 */
export class A2AExpressServer extends A2AServer {
  private _host: string
  private _port: number
  private _userBuilder: UserBuilder | undefined

  /**
   * Creates a new A2AExpressServer.
   *
   * @param config - Configuration for the server
   */
  constructor(config: A2AExpressServerConfig) {
    const host = config.host ?? '127.0.0.1'
    const port = config.port ?? 9000
    const httpUrl = config.httpUrl ?? `http://${host}:${port}`

    super({ ...config, httpUrl })

    this._host = host
    this._port = port
    this._userBuilder = config.userBuilder
  }

  /**
   * Returns the port the server is configured to listen on.
   * After `serve()` resolves, this reflects the actual bound port
   * (useful when configured with port 0 for OS-assigned ports).
   */
  get port(): number {
    return this._port
  }

  /**
   * Creates an Express Router middleware for the A2A endpoints.
   *
   * Mounts:
   * - `GET /.well-known/agent-card.json` — Returns the agent card
   * - `POST /` — Handles A2A JSON-RPC requests
   *
   * @returns An Express Router with A2A endpoints mounted
   */
  createMiddleware(): Router {
    logExperimentalWarning()

    const router = express.Router()

    router.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: this._requestHandler }))

    router.use(
      '/',
      jsonRpcHandler({
        requestHandler: this._requestHandler,
        userBuilder: this._userBuilder ?? UserBuilder.noAuthentication,
      })
    )

    return router
  }

  /**
   * Starts the HTTP server and begins listening for A2A requests.
   *
   * @param options - Optional server options
   */
  async serve(options?: { signal?: AbortSignal }): Promise<void> {
    const app = express()
    app.use(this.createMiddleware())

    return new Promise<void>((resolve, reject) => {
      const server = app.listen(this._port, this._host, () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          this._port = addr.port
          this._agentCard.url = `http://${this._host}:${this._port}`
        }
        logger.info(`a2a server listening on http://${this._host}:${this._port}`)
        resolve()
      })

      server.on('error', reject)

      if (options?.signal) {
        options.signal.addEventListener(
          'abort',
          () => {
            server.close()
          },
          { once: true }
        )
      }
    })
  }
}
