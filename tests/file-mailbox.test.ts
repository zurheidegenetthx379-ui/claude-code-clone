import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { FileMailbox } from '../src/coordinator/swarm/FileMailbox.js'

describe('FileMailbox', () => {
  let tmpDir: string
  let mailbox: FileMailbox

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `mailbox-test-${randomUUID()}`)
    mailbox = new FileMailbox(tmpDir)
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  // ── send / receive ─────────────────────────────────────────────────────

  describe('send / receive', () => {
    it('sends a message and receives it', async () => {
      const msgId = await mailbox.send({
        from: 'agent-a',
        to: 'agent-b',
        type: 'task',
        payload: { instruction: 'Fix bug #42' },
      })
      expect(typeof msgId).toBe('string')
      expect(msgId.length).toBeGreaterThan(0)

      const messages = await mailbox.receive('agent-b')
      expect(messages).toHaveLength(1)
      expect(messages[0]!.from).toBe('agent-a')
      expect(messages[0]!.to).toBe('agent-b')
      expect(messages[0]!.type).toBe('task')
      expect(messages[0]!.payload).toEqual({ instruction: 'Fix bug #42' })
      // receive() marks messages as read before returning them, so read is true
      expect(messages[0]!.read).toBe(true)
      expect(typeof messages[0]!.timestamp).toBe('number')
    })

    it('marks messages as read after receiving', async () => {
      await mailbox.send({ from: 'a', to: 'b', type: 'ping', payload: null })

      // First receive returns unread
      const first = await mailbox.receive('b')
      expect(first).toHaveLength(1)

      // Second receive returns nothing (all read)
      const second = await mailbox.receive('b')
      expect(second).toHaveLength(0)
    })

    it('sends multiple messages and receives all', async () => {
      await mailbox.send({ from: 'a', to: 'b', type: 'task', payload: 'task-1' })
      await mailbox.send({ from: 'a', to: 'b', type: 'status', payload: 'update' })
      await mailbox.send({ from: 'c', to: 'b', type: 'result', payload: 'done' })

      const messages = await mailbox.receive('b')
      expect(messages).toHaveLength(3)
    })

    it('each message gets a unique ID', async () => {
      const id1 = await mailbox.send({ from: 'a', to: 'b', type: 'ping', payload: null })
      const id2 = await mailbox.send({ from: 'a', to: 'b', type: 'ping', payload: null })
      expect(id1).not.toBe(id2)
    })

    it('returns empty array when receiving from a non-existent mailbox', async () => {
      const messages = await mailbox.receive('nonexistent')
      expect(messages).toEqual([])
    })
  })

  // ── peek ───────────────────────────────────────────────────────────────

  describe('peek', () => {
    it('returns messages without marking them as read', async () => {
      await mailbox.send({ from: 'a', to: 'b', type: 'task', payload: 'hello' })

      const peeked = await mailbox.peek('b')
      expect(peeked).toHaveLength(1)
      expect(peeked[0]!.read).toBe(false)

      // peek again should still show unread
      const peekedAgain = await mailbox.peek('b')
      expect(peekedAgain).toHaveLength(1)
      expect(peekedAgain[0]!.read).toBe(false)
    })

    it('receive still works after peek', async () => {
      await mailbox.send({ from: 'a', to: 'b', type: 'task', payload: 'hello' })

      await mailbox.peek('b')
      const received = await mailbox.receive('b')
      expect(received).toHaveLength(1)
      // receive() returns messages and marks them as read, so read is true
      expect(received[0]!.read).toBe(true)
    })

    it('returns empty array for non-existent mailbox', async () => {
      const messages = await mailbox.peek('nonexistent')
      expect(messages).toEqual([])
    })
  })

  // ── broadcast ──────────────────────────────────────────────────────────

  describe('broadcast', () => {
    it('sends a message to multiple agents', async () => {
      const ids = await mailbox.broadcast('coordinator', ['agent-1', 'agent-2', 'agent-3'], 'status', {
        phase: 'implementation',
      })

      expect(ids).toHaveLength(3)
      // All IDs should be unique
      expect(new Set(ids).size).toBe(3)

      // Each agent should have the message
      for (const agentId of ['agent-1', 'agent-2', 'agent-3']) {
        const messages = await mailbox.receive(agentId)
        expect(messages).toHaveLength(1)
        expect(messages[0]!.from).toBe('coordinator')
        expect(messages[0]!.type).toBe('status')
        expect(messages[0]!.payload).toEqual({ phase: 'implementation' })
      }
    })

    it('returns empty array when broadcasting to no agents', async () => {
      const ids = await mailbox.broadcast('coordinator', [], 'ping', null)
      expect(ids).toEqual([])
    })

    it('does not send to agents not in the list', async () => {
      await mailbox.broadcast('coord', ['agent-1'], 'ping', null)
      const messages = await mailbox.receive('agent-2')
      expect(messages).toEqual([])
    })
  })

  // ── hasUnread ──────────────────────────────────────────────────────────

  describe('hasUnread', () => {
    it('returns false when mailbox is empty or non-existent', async () => {
      expect(await mailbox.hasUnread('agent-x')).toBe(false)
    })

    it('returns true when there are unread messages', async () => {
      await mailbox.send({ from: 'a', to: 'b', type: 'ping', payload: null })
      expect(await mailbox.hasUnread('b')).toBe(true)
    })

    it('returns false after all messages have been read', async () => {
      await mailbox.send({ from: 'a', to: 'b', type: 'ping', payload: null })
      await mailbox.receive('b') // marks as read
      expect(await mailbox.hasUnread('b')).toBe(false)
    })

    it('returns true when new messages arrive after reading', async () => {
      await mailbox.send({ from: 'a', to: 'b', type: 'ping', payload: null })
      await mailbox.receive('b')
      await mailbox.send({ from: 'a', to: 'b', type: 'task', payload: 'new task' })
      expect(await mailbox.hasUnread('b')).toBe(true)
    })
  })

  // ── clear / listAgents ─────────────────────────────────────────────────

  describe('clear / listAgents', () => {
    it('clear removes all messages for an agent', async () => {
      await mailbox.send({ from: 'a', to: 'b', type: 'ping', payload: null })
      await mailbox.send({ from: 'a', to: 'b', type: 'task', payload: 'hello' })

      await mailbox.clear('b')

      const messages = await mailbox.receive('b')
      expect(messages).toEqual([])
      expect(await mailbox.hasUnread('b')).toBe(false)
    })

    it('clear does not throw for non-existent mailbox', async () => {
      await expect(mailbox.clear('nonexistent')).resolves.toBeUndefined()
    })

    it('listAgents returns all agents with mailboxes', async () => {
      await mailbox.send({ from: 'coord', to: 'agent-1', type: 'task', payload: null })
      await mailbox.send({ from: 'coord', to: 'agent-2', type: 'task', payload: null })
      await mailbox.send({ from: 'coord', to: 'agent-3', type: 'task', payload: null })

      const agents = await mailbox.listAgents()
      expect(agents.sort()).toEqual(['agent-1', 'agent-2', 'agent-3'])
    })

    it('listAgents returns empty array when no mailboxes exist', async () => {
      const agents = await mailbox.listAgents()
      expect(agents).toEqual([])
    })

    it('listAgents does not include cleared agents', async () => {
      await mailbox.send({ from: 'coord', to: 'agent-1', type: 'task', payload: null })
      await mailbox.send({ from: 'coord', to: 'agent-2', type: 'task', payload: null })
      await mailbox.clear('agent-1')

      const agents = await mailbox.listAgents()
      expect(agents).toEqual(['agent-2'])
    })
  })

  // ── getMailboxPath ─────────────────────────────────────────────────────

  describe('getMailboxPath', () => {
    it('returns the expected path for an agent', () => {
      const mailboxPath = mailbox.getMailboxPath('agent-1')
      expect(mailboxPath).toBe(path.join(tmpDir, '.cc-agent', 'mailbox', 'agent-1.jsonl'))
    })
  })
})
