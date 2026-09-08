import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createTaskHttpHandler } from '../src/http.js'
import { MemoryTaskTable } from './helpers.js'

async function request(
  handler: ReturnType<typeof createTaskHttpHandler>,
  method: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(raw) as IncomingMessage
  req.method = method
  req.headers = method === 'POST'
    ? { 'content-type': 'application/json', 'x-dsh-scheduled-tasks': '1', host: '127.0.0.1:3080' }
    : { host: '127.0.0.1:3080' }
  let status = 0
  let payload = ''
  const res = {
    writeHead(code: number) { status = code; return this },
    end(value?: string) { payload = value ?? '' },
  } as unknown as ServerResponse
  await handler(req, res)
  return { status, body: JSON.parse(payload) as unknown }
}

describe('HTTP composition', () => {
  it('creates a task through POST and returns it through GET', async () => {
    const table = new MemoryTaskTable()
    let wakes = 0
    const handler = createTaskHttpHandler(table, () => { wakes += 1 })

    const create = await request(handler, 'POST', {
      prompt: 'check project tests',
      schedule: { type: 'once', scheduledAt: new Date(Date.now() + 60_000).toISOString() },
      mode: 'on_time',
    })
    expect(create.status).toBe(201)
    expect(wakes).toBe(1)

    const list = await request(handler, 'GET')
    expect(list.status).toBe(200)
    expect(list.body).toMatchObject({
      tasks: [{
        prompt: 'check project tests',
        state: 'pending',
        schedule: { type: 'once' },
      }],
    })
  })

  it('returns the active task for repeated identical creation', async () => {
    const table = new MemoryTaskTable()
    const handler = createTaskHttpHandler(table, () => {})
    const input = {
      prompt: 'check project tests',
      schedule: { type: 'cron', expression: '0 0 8 * * *' },
      mode: 'on_time',
    }
    const first = await request(handler, 'POST', input)
    const second = await request(handler, 'POST', input)
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({ id: (first.body as { id: string }).id })
    expect([...table.records]).toHaveLength(1)
  })
})
