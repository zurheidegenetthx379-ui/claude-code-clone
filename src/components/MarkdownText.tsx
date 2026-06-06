/**
 * MarkdownText — renders Markdown content as ANSI-formatted text in Ink.
 *
 * Uses `marked` + `marked-terminal` (already configured in terminalRenderer.ts)
 * to convert Markdown to ANSI escape sequences, then passes the result to
 * Ink's <Text> component which natively understands ANSI codes (measurement,
 * wrapping, and compositing are all ANSI-safe).
 *
 * Usage:
 *   <MarkdownText>{message.content}</MarkdownText>
 *
 * Notes:
 *  - Do NOT wrap in <Text color="..."> — the ANSI colors from marked-terminal
 *    would conflict with Ink's chalk-based color prop.
 *  - For non-assistant content (system, tool_use, errors), prefer plain <Text>
 *    since those entries are typically not Markdown.
 */

import React, { useMemo } from 'react'
import { Text } from 'ink'

import { renderMarkdown } from '../utils/terminalRenderer.js'

export interface MarkdownTextProps {
  /** Raw Markdown source text. */
  children: string
  /** Optional fallback color when content is empty. */
  fallbackColor?: string
}

/**
 * Render Markdown children as ANSI-formatted text inside Ink.
 */
export function MarkdownText({ children, fallbackColor }: MarkdownTextProps): React.ReactElement {
  const rendered = useMemo(() => {
    if (!children) return ''
    const result = renderMarkdown(children)
    // marked-terminal adds a trailing newline; strip it to avoid extra blank line
    return result.replace(/\n$/, '')
  }, [children])

  if (!rendered) {
    return <Text color={fallbackColor ?? 'white'}>{children}</Text>
  }

  // Render the ANSI string without any color prop — marked-terminal handles styling.
  return <Text wrap="wrap">{rendered}</Text>
}

export default MarkdownText
