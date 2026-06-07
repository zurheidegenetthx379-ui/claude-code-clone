/**
 * Terminal Markdown Renderer
 *
 * Converts markdown text to ANSI-colored terminal output using `marked`
 * with `marked-terminal` for rich formatting and `cli-highlight` for
 * syntax highlighting in code blocks.
 *
 * Also provides a streaming renderer that replaces the previous output
 * in-place using ANSI cursor control, giving real-time markdown preview
 * during token streaming.
 */

import { marked } from 'marked'
import { markedTerminal } from 'marked-terminal'

// Configure marked with terminal renderer (once, at module load).
// The type assertion is needed because @types/marked-terminal targets an
// older marked API; the runtime extension object is compatible with v15.
marked.use(markedTerminal() as Parameters<typeof marked.use>[0])

/**
 * Render markdown to ANSI-colored terminal string.
 */
export function renderMarkdown(text: string): string {
  try {
    return marked.parse(text) as string
  } catch {
    return text
  }
}

// ── ANSI cursor helpers ─────────────────────────────────────────────

const ESC = '\x1b'
const CSI = `${ESC}[`

/** Save cursor position (DEC private). */
const SAVE_CURSOR = `${CSI}s`

/** Restore cursor position (DEC private). */
const RESTORE_CURSOR = `${CSI}u`

/** Clear from cursor to end of screen. */
const CLEAR_BELOW = `${CSI}J`

/**
 * StreamingMarkdownRenderer — replaces the previous output in-place
 * using ANSI cursor control codes.
 *
 * Usage:
 *   const sr = new StreamingMarkdownRenderer()
 *   sr.start()          // call once before first chunk
 *   sr.update(chunk1)   // for each incoming text delta
 *   sr.update(chunk2)
 *   sr.finalize()       // call when streaming is done
 */
export class StreamingMarkdownRenderer {
  private buffer = ''
  private active = false

  /** Call once before the first chunk to save the cursor position. */
  start(): void {
    this.buffer = ''
    this.active = true
    process.stdout.write(SAVE_CURSOR)
  }

  /** Accumulate a text delta and re-render the markdown in-place. */
  update(chunk: string): void {
    if (!this.active) {
      // If start() was not called, just write raw (fallback).
      process.stdout.write(chunk)
      return
    }
    this.buffer += chunk
    const rendered = renderMarkdown(this.buffer)
    // Restore cursor → clear below → write rendered markdown
    process.stdout.write(RESTORE_CURSOR + CLEAR_BELOW + rendered)
  }

  /** Final render and release the cursor. After this, output stays. */
  finalize(): string {
    if (!this.active) return this.buffer

    this.active = false
    const rendered = renderMarkdown(this.buffer)
    process.stdout.write(RESTORE_CURSOR + CLEAR_BELOW + rendered)
    return rendered
  }

  /** Abort: clear partial output and release cursor. */
  abort(): void {
    if (!this.active) return
    this.active = false
    process.stdout.write(RESTORE_CURSOR + CLEAR_BELOW)
  }

  /** Current accumulated raw text. */
  get text(): string {
    return this.buffer
  }
}
