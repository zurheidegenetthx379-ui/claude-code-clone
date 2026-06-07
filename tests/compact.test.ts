import { describe, it, expect } from 'vitest'
import type { Message, ContentBlock } from '../src/types/index.js'
import {
  compactConversation,
  stripImagesFromMessages,
  stripReinjectedAttachments,
  calculateMessagesToKeepIndex,
  adjustIndexToPreserveAPIInvariants,
} from '../src/services/compact/compact.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

let idCounter = 0

function makeMessage(
  role: 'user' | 'assistant' | 'system',
  content: string | ContentBlock[],
  overrides?: Partial<Message>,
): Message {
  idCounter++
  return {
    id: `msg-${idCounter}`,
    uuid: `uuid-${idCounter}`,
    role,
    content,
    timestamp: Date.now() + idCounter,
    ...overrides,
  }
}

// ── stripImagesFromMessages ──────────────────────────────────────────────────

describe('stripImagesFromMessages', () => {
  it('removes image blocks from structured content', () => {
    const messages: Message[] = [
      makeMessage('user', [
        { type: 'text', text: 'Look at this:' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      ]),
    ]
    const result = stripImagesFromMessages(messages)
    expect(result[0]!.content).toEqual([{ type: 'text', text: 'Look at this:' }])
  })

  it('inserts placeholder when all content blocks are images', () => {
    const messages: Message[] = [
      makeMessage('user', [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      ]),
    ]
    const result = stripImagesFromMessages(messages)
    const content = result[0]!.content as ContentBlock[]
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe('text')
    expect((content[0] as any).text).toContain('image removed')
  })

  it('preserves string content unchanged', () => {
    const messages: Message[] = [makeMessage('user', 'Hello world')]
    const result = stripImagesFromMessages(messages)
    expect(result[0]!.content).toBe('Hello world')
  })

  it('does not mutate the original messages', () => {
    const original: Message[] = [
      makeMessage('user', [
        { type: 'text', text: 'hi' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
      ]),
    ]
    const originalContentLength = (original[0]!.content as ContentBlock[]).length
    stripImagesFromMessages(original)
    expect((original[0]!.content as ContentBlock[]).length).toBe(originalContentLength)
  })
})

// ── stripReinjectedAttachments ──────────────────────────────────────────────

describe('stripReinjectedAttachments', () => {
  it('replaces large tool_result string content with a stub', () => {
    const largeContent = 'x'.repeat(5000)
    const messages: Message[] = [
      makeMessage('user', [
        { type: 'tool_result', tool_use_id: 'tu-1', content: largeContent },
      ]),
    ]
    const result = stripReinjectedAttachments(messages)
    const content = result[0]!.content as ContentBlock[]
    const tr = content[0] as any
    expect(tr.content.length).toBeLessThan(largeContent.length)
    expect(tr.content).toContain('attachment stripped')
  })

  it('preserves small tool_result content', () => {
    const messages: Message[] = [
      makeMessage('user', [
        { type: 'tool_result', tool_use_id: 'tu-1', content: 'small result' },
      ]),
    ]
    const result = stripReinjectedAttachments(messages)
    const content = result[0]!.content as ContentBlock[]
    expect((content[0] as any).content).toBe('small result')
  })

  it('strips large text blocks inside tool_result content arrays', () => {
    const messages: Message[] = [
      makeMessage('user', [
        {
          type: 'tool_result',
          tool_use_id: 'tu-1',
          content: [{ type: 'text', text: 'y'.repeat(5000) }],
        },
      ]),
    ]
    const result = stripReinjectedAttachments(messages)
    const content = result[0]!.content as ContentBlock[]
    const tr = content[0] as any
    expect(tr.content[0].text).toContain('attachment stripped')
  })
})

// ── calculateMessagesToKeepIndex ─────────────────────────────────────────────

describe('calculateMessagesToKeepIndex', () => {
  it('returns 0 when all messages fit within the budget', () => {
    const messages: Message[] = [
      makeMessage('user', 'short'),
      makeMessage('assistant', 'reply'),
    ]
    const index = calculateMessagesToKeepIndex(messages, 10000)
    expect(index).toBe(0)
  })

  it('returns a positive index when messages exceed the budget', () => {
    const messages: Message[] = []
    for (let i = 0; i < 10; i++) {
      messages.push(makeMessage('user', 'word '.repeat(100))) // ~125 tokens each
    }
    // Budget allows ~300 tokens = about 2-3 messages
    const index = calculateMessagesToKeepIndex(messages, 300)
    expect(index).toBeGreaterThan(0)
    expect(index).toBeLessThan(messages.length)
  })

  it('returns messages.length when target is 0', () => {
    const messages: Message[] = [makeMessage('user', 'hello')]
    const index = calculateMessagesToKeepIndex(messages, 0)
    expect(index).toBe(messages.length)
  })

  it('returns 0 for an empty message array', () => {
    const index = calculateMessagesToKeepIndex([], 100)
    expect(index).toBe(0)
  })
})

// ── adjustIndexToPreserveAPIInvariants ───────────────────────────────────────

describe('adjustIndexToPreserveAPIInvariants', () => {
  it('returns 0 when index is 0', () => {
    const messages: Message[] = [makeMessage('user', 'hi')]
    expect(adjustIndexToPreserveAPIInvariants(messages, 0)).toBe(0)
  })

  it('returns messages.length when index is at the end', () => {
    const messages: Message[] = [makeMessage('user', 'hi')]
    expect(adjustIndexToPreserveAPIInvariants(messages, 1)).toBe(1)
  })

  it('adjusts backward when the last dropped message is assistant with tool_use', () => {
    const messages: Message[] = [
      makeMessage('user', 'do something'),
      makeMessage('assistant', [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }]),
      makeMessage('user', [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'done' }]),
      makeMessage('assistant', 'done'),
    ]
    // If index=2, the last dropped message (index 1) is assistant with tool_use
    // Should move back to include it
    const adjusted = adjustIndexToPreserveAPIInvariants(messages, 2)
    expect(adjusted).toBeLessThanOrEqual(2)
    // The first kept message should be a user message
    if (adjusted < messages.length) {
      expect(messages[adjusted]!.role).toBe('user')
    }
  })

  it('advances index to ensure first kept message is from user', () => {
    const messages: Message[] = [
      makeMessage('user', 'hello'),
      makeMessage('assistant', 'hi'),
      makeMessage('assistant', 'more text'),
      makeMessage('user', 'next question'),
    ]
    // If index lands on an assistant message, it should advance to user
    const adjusted = adjustIndexToPreserveAPIInvariants(messages, 2)
    expect(messages[adjusted]!.role).toBe('user')
  })
})

// ── compactConversation ──────────────────────────────────────────────────────

describe('compactConversation', () => {
  it('returns all messages (plus summary) when they fit within the token budget', () => {
    const messages: Message[] = [
      makeMessage('user', 'Hello'),
      makeMessage('assistant', 'Hi there!'),
    ]

    const { result, keptMessages } = compactConversation(messages, { targetTokens: 10000 })

    expect(result.messagesRemoved).toBe(0)
    expect(result.messagesKept).toBe(2)
    // keptMessages includes the summary message + kept messages
    expect(keptMessages.length).toBeGreaterThanOrEqual(messages.length)
  })

  it('handles empty messages array', () => {
    const { result, keptMessages } = compactConversation([], { targetTokens: 100 })
    expect(result.messagesRemoved).toBe(0)
    expect(result.messagesKept).toBe(0)
    // Should still have the summary message
    expect(keptMessages.length).toBeGreaterThanOrEqual(1)
  })

  it('uses a custom summary when provided', () => {
    const messages: Message[] = [
      makeMessage('user', 'Do something'),
      makeMessage('assistant', 'Done'),
      makeMessage('user', 'Do more'),
      makeMessage('assistant', 'All done'),
    ]

    const { result, keptMessages } = compactConversation(messages, {
      targetTokens: 10,
      summary: 'Custom summary of prior work',
    })

    // The first message should be the custom summary
    expect(keptMessages[0]!.content).toBe('Custom summary of prior work')
    expect(result.summary).toBe('Custom summary of prior work')
  })

  it('drops older messages when they exceed the token budget', () => {
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      messages.push(makeMessage(i % 2 === 0 ? 'user' : 'assistant', 'word '.repeat(100)))
    }

    const { result } = compactConversation(messages, { targetTokens: 200 })

    expect(result.messagesRemoved).toBeGreaterThan(0)
    expect(result.messagesKept).toBeLessThan(messages.length)
    expect(result.tokenCountBefore).toBeGreaterThan(result.tokenCountAfter)
  })

  it('produces a summary message with role user and isMeta flag', () => {
    const messages: Message[] = [
      makeMessage('user', 'First question'),
      makeMessage('assistant', 'First answer'),
      makeMessage('user', 'Second question'),
      makeMessage('assistant', 'Second answer'),
    ]

    const { keptMessages } = compactConversation(messages, { targetTokens: 10 })

    const summary = keptMessages[0]!
    expect(summary.role).toBe('user')
    expect(summary.isMeta).toBe(true)
    expect(summary.id).toContain('compact-summary')
  })

  it('uses custom token estimator when provided', () => {
    const messages: Message[] = [
      makeMessage('user', 'hello'),
      makeMessage('assistant', 'world'),
    ]

    // Custom estimator: every message = 1000 tokens
    const { result } = compactConversation(messages, {
      targetTokens: 500,
      estimateTokens: () => 1000,
    })

    // With every message at 1000 tokens and budget of 500, most should be dropped
    expect(result.messagesRemoved).toBeGreaterThan(0)
  })

  it('default summary includes compaction_summary tag', () => {
    const messages: Message[] = [
      makeMessage('user', 'Please fix the bug'),
      makeMessage('assistant', 'I will look into it'),
      makeMessage('user', 'Any progress?'),
      makeMessage('assistant', 'Working on it'),
    ]

    const { result } = compactConversation(messages, { targetTokens: 10 })
    expect(result.summary).toContain('<compaction_summary>')
    expect(result.summary).toContain('</compaction_summary>')
  })

  it('default summary for zero dropped messages says no prior messages', () => {
    const messages: Message[] = [makeMessage('user', 'hi')]

    const { result } = compactConversation(messages, { targetTokens: 100000 })
    expect(result.summary).toContain('No prior messages to summarise')
  })

  it('strips images before computing token counts', () => {
    const messages: Message[] = [
      makeMessage('user', [
        { type: 'text', text: 'Look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
      ]),
      makeMessage('assistant', 'I see it'),
    ]

    const { result } = compactConversation(messages, { targetTokens: 100000 })
    // Token count before should NOT include the image overhead (100 tokens)
    // since images are stripped before counting
    expect(result.tokenCountBefore).toBeLessThan(200) // text is small
  })
})
