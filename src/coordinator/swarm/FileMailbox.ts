/**
 * File Mailbox -- file-based asynchronous message passing between agents.
 *
 * Each agent has a mailbox file at `.cc-agent/mailbox/{agentId}.jsonl`.
 * Messages are stored in JSONL format (one JSON object per line) to support
 * atomic append writes without requiring a lock.
 *
 * Design notes:
 *  - JSONL was chosen over JSON because appending a line to a file is an
 *    atomic operation on most filesystems (when the line is smaller than
 *    the pipe buffer size, typically 4-8 KB).  This avoids the need for
 *    file locking when multiple agents write to the same mailbox.
 *  - Reading marks messages as "read" by rewriting the file.  This is an
 *    O(n) operation but mailboxes are typically small (dozens of messages).
 *  - The `broadcast()` helper sends a message to every agent in a list,
 *    which is useful for coordinator -> all-workers notifications.
 */

import path from 'node:path'
import { randomUUID } from 'node:crypto'

// ============================================================
// Message Interface
// ============================================================

/**
 * A single message in an agent's mailbox.
 */
export interface MailboxMessage {
  /** Unique message identifier. */
  id: string
  /** Sender agent ID. */
  from: string
  /** Recipient agent ID. */
  to: string
  /** Message type -- used by consumers to dispatch handling logic. */
  type: 'task' | 'result' | 'status' | 'error' | 'ping'
  /** Arbitrary payload (structure depends on `type`). */
  payload: unknown
  /** Unix timestamp (ms) when the message was sent. */
  timestamp: number
  /** Whether the recipient has read this message. */
  read: boolean
}

// ============================================================
// FileMailbox
// ============================================================

export class FileMailbox {
  /** Base directory for mailbox files: `{projectDir}/.cc-agent/mailbox/`. */
  private baseDir: string

  constructor(projectDir: string) {
    this.baseDir = path.join(projectDir, '.cc-agent', 'mailbox')
  }

  // ----------------------------------------------------------
  // Send
  // ----------------------------------------------------------

  /**
   * Send a message to an agent's mailbox.
   *
   * The message is appended as a single JSON line to the recipient's
   * mailbox file.  The directory and file are created if they do not
   * exist.
   *
   * @returns The generated message ID.
   */
  async send(
    message: Omit<MailboxMessage, 'id' | 'timestamp' | 'read'>,
  ): Promise<string> {
    const { mkdir, appendFile } = await import('node:fs/promises')

    try {
      await mkdir(this.baseDir, { recursive: true })
    } catch {
      // Directory creation is best-effort.
    }

    const fullMessage: MailboxMessage = {
      ...message,
      id: randomUUID(),
      timestamp: Date.now(),
      read: false,
    }

    const filePath = this.getMailboxPath(message.to)
    try {
      await appendFile(filePath, JSON.stringify(fullMessage) + '\n', 'utf-8')
    } catch {
      // Write failure is best-effort -- the caller should handle retries.
    }

    return fullMessage.id
  }

  // ----------------------------------------------------------
  // Receive
  // ----------------------------------------------------------

  /**
   * Read all unread messages for an agent and mark them as read.
   *
   * The mailbox file is rewritten with all messages marked `read: true`.
   * Returns an empty array if the mailbox does not exist or has no unread
   * messages.
   */
  async receive(agentId: string): Promise<MailboxMessage[]> {
    const messages = await this.readAll(agentId)
    const unread = messages.filter((m) => !m.read)

    if (unread.length > 0) {
      // Mark all as read and rewrite the file.
      for (const m of messages) {
        m.read = true
      }
      await this.rewrite(agentId, messages)
    }

    return unread
  }

  // ----------------------------------------------------------
  // Peek
  // ----------------------------------------------------------

  /**
   * Peek at all messages (including already-read) without marking anything.
   */
  async peek(agentId: string): Promise<MailboxMessage[]> {
    return this.readAll(agentId)
  }

  // ----------------------------------------------------------
  // Queries
  // ----------------------------------------------------------

  /**
   * Get the mailbox file path for an agent.
   */
  getMailboxPath(agentId: string): string {
    return path.join(this.baseDir, `${agentId}.jsonl`)
  }

  /**
   * Check whether an agent has unread messages.
   */
  async hasUnread(agentId: string): Promise<boolean> {
    const messages = await this.readAll(agentId)
    return messages.some((m) => !m.read)
  }

  // ----------------------------------------------------------
  // Clear
  // ----------------------------------------------------------

  /**
   * Clear all messages for an agent by removing the mailbox file.
   */
  async clear(agentId: string): Promise<void> {
    const { unlink } = await import('node:fs/promises')
    try {
      await unlink(this.getMailboxPath(agentId))
    } catch {
      // File may not exist -- that's fine.
    }
  }

  // ----------------------------------------------------------
  // List agents
  // ----------------------------------------------------------

  /**
   * List all agents that have mailbox files.
   *
   * Scans the mailbox directory for `.jsonl` files and returns the
   * agent IDs (file basenames without extension).
   */
  async listAgents(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises')
    try {
      const entries = await readdir(this.baseDir)
      return entries
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.replace(/\.jsonl$/, ''))
    } catch {
      // Directory does not exist -- no agents.
      return []
    }
  }

  // ----------------------------------------------------------
  // Broadcast
  // ----------------------------------------------------------

  /**
   * Broadcast a message to all agents in a list.
   *
   * Sends the same message (with unique IDs) to each agent's mailbox.
   * Useful for coordinator -> all-workers notifications like phase
   * transitions or shutdown signals.
   *
   * @returns Array of message IDs (one per recipient).
   */
  async broadcast(
    from: string,
    agentIds: string[],
    type: MailboxMessage['type'],
    payload: unknown,
  ): Promise<string[]> {
    const ids: string[] = []
    for (const agentId of agentIds) {
      const id = await this.send({ from, to: agentId, type, payload })
      ids.push(id)
    }
    return ids
  }

  // ----------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------

  /**
   * Read all messages from an agent's mailbox file.
   *
   * Returns an empty array if the file does not exist or is empty.
   * Malformed lines are silently skipped.
   */
  private async readAll(agentId: string): Promise<MailboxMessage[]> {
    const { readFile } = await import('node:fs/promises')
    const filePath = this.getMailboxPath(agentId)

    try {
      const raw = await readFile(filePath, 'utf-8')
      const lines = raw.split('\n').filter((line) => line.trim().length > 0)
      const messages: MailboxMessage[] = []

      for (const line of lines) {
        try {
          messages.push(JSON.parse(line) as MailboxMessage)
        } catch {
          // Skip malformed lines.
        }
      }

      return messages
    } catch {
      // File does not exist -- no messages.
      return []
    }
  }

  /**
   * Rewrite the entire mailbox file with the given messages.
   *
   * Used after marking messages as read.  The file is overwritten
   * atomically (writeFile truncates then writes).
   */
  private async rewrite(
    agentId: string,
    messages: MailboxMessage[],
  ): Promise<void> {
    const { writeFile } = await import('node:fs/promises')
    const filePath = this.getMailboxPath(agentId)
    const content = messages.map((m) => JSON.stringify(m)).join('\n')
    try {
      await writeFile(filePath, content + (content ? '\n' : ''), 'utf-8')
    } catch {
      // Write failure is best-effort.
    }
  }
}
