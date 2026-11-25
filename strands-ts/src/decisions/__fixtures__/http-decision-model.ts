import { Sha256 } from '@smithy/core/checksum'
import { SignatureV4 } from '@smithy/signature-v4'
import { expect, vi } from 'vitest'

import { ModelError } from '../../errors.js'
import { HttpDecisionModel, type HttpDecisionModelOptions } from '../http-decision-model.js'

export const LOCAL_ENDPOINT = 'http://localhost:8000/v1/systemone'
export const LAMBDA_ENDPOINT = 'https://abc123.lambda-url.us-east-1.on.aws/v1/systemone'
export const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session-token' }
export const QUESTIONS = { urgent: { question: 'Is this urgent?', choices: 'boolean' } } as const

export interface CapturedRequest {
  url: string
  headers: Record<string, string>
  rawBody: string
  body: Record<string, unknown>
  redirect: RequestRedirect | undefined
}

export function systemOneBody(noul = 0.9): unknown {
  return { model: 'resolved-model', answers: { urgent: { type: 'noul', noul } } }
}

export function fakeFetch(
  payload: unknown = systemOneBody(),
  options: { status?: number; captured?: CapturedRequest[] } = {}
): typeof globalThis.fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const rawBody = await request.text()
    options.captured?.push({
      url: request.url,
      headers: Object.fromEntries(request.headers),
      rawBody,
      body: JSON.parse(rawBody) as Record<string, unknown>,
      redirect: request.redirect,
    })
    return new Response(JSON.stringify(payload), {
      status: options.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof globalThis.fetch
}

/** A fetch that never answers and rejects when its signal aborts, like a real network call. */
export function hangingFetch(): typeof globalThis.fetch {
  return ((_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })) as typeof globalThis.fetch
}

/** A fetch that answers with headers at once and then streams a body that fails or stalls, like a dropped connection. */
export function brokenBodyFetch(mode: 'reset' | 'stall'): typeof globalThis.fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = new ReadableStream({
      start(controller): void {
        if (mode === 'reset') controller.error(new TypeError('terminated'))
        else init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason))
      },
    })
    return new Response(body, { status: 200 })
  }) as typeof globalThis.fetch
}

export function create(options: Partial<HttpDecisionModelOptions> = {}): HttpDecisionModel {
  return new HttpDecisionModel({ endpoint: LOCAL_ENDPOINT, ...options })
}

/** Asserts that `pending` rejects with a ModelError that has exactly `message`. */
export async function expectModelError(pending: Promise<unknown>, message: string): Promise<void> {
  const error = await pending.then(
    () => undefined,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(ModelError)
  expect((error as Error).message).toBe(message)
}

/** Signs the captured request again with the same credentials and signing time; a match proves what was sent is what was signed. */
export async function expectedSignature(request: CapturedRequest, service: string, region: string): Promise<string> {
  const url = new URL(request.url)
  const signer = new SignatureV4({ service, region, sha256: Sha256, credentials: CREDENTIALS })
  const signingDate = new Date(
    request.headers['x-amz-date']!.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')
  )
  const staticHeaders = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name === 'x-api-key'))
  const signed = await signer.sign(
    {
      method: 'POST',
      protocol: url.protocol,
      hostname: url.hostname,
      ...(url.port !== '' && { port: Number(url.port) }),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...staticHeaders, host: url.host, 'content-type': 'application/json' },
      body: request.rawBody,
    },
    { signingDate }
  )
  return signed.headers['authorization']!
}
