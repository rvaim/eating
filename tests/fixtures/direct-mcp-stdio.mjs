import { writeFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// Explicit development fixture: never installed or registered as a product service.
const marker = process.argv[2]
if (marker) writeFileSync(marker, String(process.pid), { mode: 0o600 })
process.stderr.write('fixture-private-stderr-key\n')
if (process.env.EATING_DIRECT_MCP_FIXTURE_MODE === 'stall') {
  process.stdin.resume()
  process.stdin.on('end', () => process.exit(0))
} else {
  const server = new Server({ name: 'eating-direct-stdio-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'fixture_echo', title: 'Echo fixture', description: 'Return exact fixture arguments.', inputSchema: { type: 'object', properties: { value: {} } }, annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'fixture_image', inputSchema: { type: 'object' } },
    { name: 'fixture_hang', inputSchema: { type: 'object' } },
    { name: 'fixture_error', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true } },
  ] }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name === 'fixture_hang') return new Promise(() => {})
    if (request.params.name === 'fixture_image') return { content: [{ type: 'text', text: 'fixture image' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }], structuredContent: { fixture: true } }
    if (request.params.name === 'fixture_error') return { content: [{ type: 'text', text: 'fixture tool rejected' }], isError: true }
    return { content: [{ type: 'text', text: JSON.stringify({ args: request.params.arguments, pid: process.pid, argv: process.argv.slice(3), secret: process.env.EATING_DIRECT_MCP_FIXTURE_SECRET, ambient: process.env.EATING_DIRECT_MCP_AMBIENT_SECRET ?? null }) }], structuredContent: { args: request.params.arguments ?? {} } }
  })
  process.stdin.on('end', () => { void server.close().finally(() => process.exit(0)) })
  await server.connect(new StdioServerTransport())
}
