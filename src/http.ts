import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TaskTable } from './types.js'
import { MAX_PROMPT_BYTES } from './types.js'
import { createScheduledTask, listTasks, parseCreateTaskInput, RequestError } from './domain.js'

export const API_PATH = '/dsh-scheduled-tasks/api/v1/tasks'
// JSON may escape each saved byte as `\u00XX`; keep that worst case bounded
// while still allowing every prompt accepted by the 64 KiB domain limit.
const MAX_BODY_BYTES = MAX_PROMPT_BYTES * 6 + 4 * 1024

interface ErrorBody {
  error: { code: string; message: string }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  })
  res.end(payload)
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } } satisfies ErrorBody)
}

function mediaType(value: string | undefined): string {
  return (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function assertTrustedOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin
  if (origin === undefined) return
  const host = req.headers.host
  try {
    const parsed = new URL(origin)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.host !== host) throw new Error()
  } catch {
    throw new RequestError('untrusted_origin', 'The request Origin is not trusted.', 403)
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw new RequestError('body_too_large', 'Request body is too large.', 413)
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new RequestError('invalid_json', 'Request body is not valid JSON.')
  }
}

export function createTaskHttpHandler(table: TaskTable, onCreated: () => void) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method === 'GET') {
        sendJson(res, 200, { tasks: listTasks(table) })
        return
      }
      if (req.method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', 'Only GET and POST are supported.')
        return
      }
      assertTrustedOrigin(req)
      if (mediaType(req.headers['content-type']) !== 'application/json') {
        throw new RequestError('invalid_content_type', 'Content-Type must be application/json.', 415)
      }
      if (req.headers['x-dsh-scheduled-tasks'] !== '1') {
        throw new RequestError('missing_request_header', 'X-DSH-Scheduled-Tasks: 1 is required.', 403)
      }
      const input = parseCreateTaskInput(await readJson(req))
      const task = createScheduledTask(input)
      await table.put(task.id, task)
      onCreated()
      sendJson(res, 201, task)
    } catch (error) {
      if (error instanceof RequestError) {
        sendError(res, error.status, error.code, error.message)
        return
      }
      sendError(res, 500, 'internal_error', 'The scheduled task request failed.')
    }
  }
}
