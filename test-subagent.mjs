// Quick programmatic test of the sub-agent chain
import { QueryEngine } from './dist/QueryEngine.js'

const engine = new QueryEngine({
  model: process.env['CC_AGENT_MODEL'] || 'LongCat-2.0-Preview',
  systemPrompt: 'You are a helpful assistant. Use tools when needed.',
  tools: [],
  permissionContext: { permissionMode: 'bypassPermissions', allowList: [], denyList: [] },
  cwd: 'E:/claude-code-clone',
  sessionId: 'test-subagent-001',
})

console.log('Testing runIsolated...')
try {
  const result = await engine.runIsolated({
    prompt: 'What is 2+2? Answer in one word.',
    systemPrompt: 'You are a math sub-agent. Answer concisely.',
    toolNames: [],
    maxTurns: 3,
  })
  console.log('Result:', result.text)
  console.log('Stop reason:', result.stopReason)
  console.log('Turns used:', result.turnsUsed)
  console.log('Tokens:', JSON.stringify(result.tokenUsage))
  console.log('SUCCESS: runIsolated works!')
} catch (err) {
  console.error('FAILED:', err.message)
}
