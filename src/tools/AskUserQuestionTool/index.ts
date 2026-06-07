/**
 * AskUserQuestionTool - Present structured questions to the user and collect answers.
 *
 * This tool is marked `requiresUserInteraction: true` because it cannot
 * produce a meaningful result without a human in the loop.  In headless /
 * batch mode the tool returns the first option for each question as a
 * safe fallback so that automated pipelines do not block indefinitely.
 *
 * The `shouldDefer` flag (exposed via the tool's metadata) signals to the
 * orchestrator that this tool should be deferred until the user is
 * available to respond.
 */

import { buildTool } from '../../Tool.js'
import type {
  ToolResult,
  ToolUseContext,
  Message,
  CanUseTool,
  ToolProgressData,
  PermissionResult,
  PermissionContext,
  ToolInstance,
} from '../../types/index.js'

// ─── Type Definitions ───────────────────────────────────────────────────────

interface QuestionOption {
  label: string
  description: string
}

interface Question {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_QUESTIONS = 4
const MAX_OPTIONS_PER_QUESTION = 6
const MAX_LABEL_LENGTH = 60
const MAX_HEADER_LENGTH = 20
const MAX_QUESTION_LENGTH = 500

// ─── Validation helpers ─────────────────────────────────────────────────────

function validateQuestion(q: unknown, index: number): Question | string {
  if (!q || typeof q !== 'object') {
    return `Question ${index}: must be an object.`
  }

  const obj = q as Record<string, unknown>

  // question text
  if (typeof obj.question !== 'string' || obj.question.trim() === '') {
    return `Question ${index}: \`question\` must be a non-empty string.`
  }
  if (obj.question.length > MAX_QUESTION_LENGTH) {
    return `Question ${index}: \`question\` exceeds ${MAX_QUESTION_LENGTH} characters.`
  }

  // header
  if (typeof obj.header !== 'string' || obj.header.trim() === '') {
    return `Question ${index}: \`header\` must be a non-empty string.`
  }
  if (obj.header.length > MAX_HEADER_LENGTH) {
    return `Question ${index}: \`header\` must be at most ${MAX_HEADER_LENGTH} characters.`
  }

  // options
  if (!Array.isArray(obj.options) || obj.options.length < 2) {
    return `Question ${index}: \`options\` must be an array with at least 2 entries.`
  }
  if (obj.options.length > MAX_OPTIONS_PER_QUESTION) {
    return `Question ${index}: \`options\` must have at most ${MAX_OPTIONS_PER_QUESTION} entries.`
  }

  const validatedOptions: QuestionOption[] = []
  for (let i = 0; i < obj.options.length; i++) {
    const opt = obj.options[i] as Record<string, unknown>
    if (!opt || typeof opt !== 'object') {
      return `Question ${index}, option ${i}: must be an object with \`label\` and \`description\`.`
    }
    if (typeof opt.label !== 'string' || (opt.label as string).trim() === '') {
      return `Question ${index}, option ${i}: \`label\` must be a non-empty string.`
    }
    if ((opt.label as string).length > MAX_LABEL_LENGTH) {
      return `Question ${index}, option ${i}: \`label\` exceeds ${MAX_LABEL_LENGTH} characters.`
    }
    if (typeof opt.description !== 'string') {
      return `Question ${index}, option ${i}: \`description\` must be a string.`
    }
    validatedOptions.push({
      label: (opt.label as string).trim(),
      description: opt.description.trim(),
    })
  }

  const multiSelect = obj.multiSelect === true

  return {
    question: obj.question.trim(),
    header: obj.header.trim(),
    options: validatedOptions,
    multiSelect,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Determine whether the current session is headless (no interactive UI).
 * This checks a well-known appState key set by the runtime.
 */
function isHeadless(context: ToolUseContext): boolean {
  return context.appState['headless'] === true ||
    context.appState['ci'] === true ||
    process.env['CLAUDE_CODE_HEADLESS'] === '1' ||
    process.env['CI'] === 'true'
}

/**
 * Build the default answer set for headless mode.
 * For each question, select the first option.
 */
function buildDefaultAnswers(questions: Question[]): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const q of questions) {
    answers[q.header] = q.options[0].label
  }
  return answers
}

/**
 * Format questions for display in the tool result.
 */
function formatQuestionsDisplay(questions: Question[]): string {
  const parts: string[] = []

  for (const q of questions) {
    const selectMode = q.multiSelect ? '(multi-select)' : '(single-select)'
    parts.push(`[${q.header}] ${q.question} ${selectMode}`)
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i]
      parts.push(`  ${i + 1}. ${opt.label} - ${opt.description}`)
    }
    parts.push('')
  }

  return parts.join('\n')
}

/**
 * Format the collected answers for display.
 */
function formatAnswersDisplay(
  questions: Question[],
  answers: Record<string, string>,
): string {
  const parts: string[] = []

  for (const q of questions) {
    const answer = answers[q.header] ?? '(no answer)'
    parts.push(`[${q.header}] -> ${answer}`)
  }

  return parts.join('\n')
}

// ─── Tool Definition ────────────────────────────────────────────────────────

const AskUserQuestionTool = buildTool({
  name: 'AskUserQuestion',

  description:
    'Present one or more structured questions to the user and collect their answers. ' +
    'Each question includes a header, question text, a list of selectable options, ' +
    'and a multiSelect flag. ' +
    'In headless/CI mode, the first option is selected automatically. ' +
    'Users can always choose "Other" to provide free-text input.',

  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: `Array of questions (1-${MAX_QUESTIONS}).`,
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The question text to display to the user.',
            },
            header: {
              type: 'string',
              description: `A short label for this question (max ${MAX_HEADER_LENGTH} chars). Used as the answer key.`,
            },
            options: {
              type: 'array',
              description: 'Available choices for the user to select.',
              minItems: 2,
              maxItems: MAX_OPTIONS_PER_QUESTION,
              items: {
                type: 'object',
                properties: {
                  label: {
                    type: 'string',
                    description: `Display text for the option (max ${MAX_LABEL_LENGTH} chars).`,
                  },
                  description: {
                    type: 'string',
                    description: 'Explanation of what this option means or what happens if chosen.',
                  },
                },
                required: ['label', 'description'],
                additionalProperties: false,
              },
            },
            multiSelect: {
              type: 'boolean',
              description:
                'When true, the user can select multiple options instead of just one.',
            },
          },
          required: ['question', 'header', 'options', 'multiSelect'],
          additionalProperties: false,
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },

  // ── Safety flags ──────────────────────────────────────────────────────────
  isConcurrencySafe: true,
  isReadOnly: true,

  // ── Interaction flags ─────────────────────────────────────────────────────
  requiresUserInteraction: () => true,

  // ── shouldDefer metadata ──────────────────────────────────────────────────
  // This is exposed as a custom property so the orchestrator can check it.
  // The buildTool factory doesn't have a first-class `shouldDefer` field,
  // so we attach it via the prompt method and use appState at call time.

  // ── Permission check ──────────────────────────────────────────────────────
  async checkPermissions(
    _input: Record<string, unknown>,
    _context?: PermissionContext,
  ): Promise<PermissionResult> {
    // Asking questions is always safe; no permission needed.
    return { behavior: 'allow' }
  },

  // ── Core execution ────────────────────────────────────────────────────────
  async call(
    input: Record<string, unknown>,
    context: ToolUseContext,
    _canUseTool: CanUseTool,
    _parentMessage: Message,
    onProgress?: (progress: ToolProgressData) => void,
  ): Promise<ToolResult> {
    // ── Validate top-level input ──────────────────────────────────────────
    const rawQuestions = input.questions
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return {
        content: 'Error: `questions` must be a non-empty array.',
        isError: true,
      }
    }

    if (rawQuestions.length > MAX_QUESTIONS) {
      return {
        content: `Error: Too many questions (${rawQuestions.length}). Maximum is ${MAX_QUESTIONS}.`,
        isError: true,
      }
    }

    // ── Validate each question ────────────────────────────────────────────
    const validatedQuestions: Question[] = []
    const seenHeaders = new Set<string>()

    for (let i = 0; i < rawQuestions.length; i++) {
      const result = validateQuestion(rawQuestions[i], i + 1)
      if (typeof result === 'string') {
        return { content: `Error: ${result}`, isError: true }
      }

      // Check for duplicate headers
      if (seenHeaders.has(result.header)) {
        return {
          content: `Error: Duplicate header "${result.header}". Each question must have a unique header.`,
          isError: true,
        }
      }
      seenHeaders.add(result.header)
      validatedQuestions.push(result)
    }

    onProgress?.({ status: 'awaiting_user_input' })

    // ── Headless / CI mode ────────────────────────────────────────────────
    if (isHeadless(context)) {
      const defaultAnswers = buildDefaultAnswers(validatedQuestions)

      const display = formatQuestionsDisplay(validatedQuestions)
      const answerDisplay = formatAnswersDisplay(validatedQuestions, defaultAnswers)

      return {
        content:
          `[Headless mode - auto-selected first option for each question]\n\n` +
          `${display}\n` +
          `Answers:\n${answerDisplay}`,
        output: { answers: defaultAnswers, mode: 'headless' },
      }
    }

    // ── Interactive mode ──────────────────────────────────────────────────
    // In a real implementation the tool would signal the UI layer to render
    // the question card and block until the user responds.  The answers
    // arrive via appState or a callback registered by the UI framework.
    //
    // Here we check if answers have been pre-populated in appState (set by
    // the UI layer after the user responds).  If not, we store the
    // questions and return a "pending" result that the orchestrator will
    // replace once the user answers.

    const pendingKey = `askUserQuestion_${context.sessionId}`
    const existingAnswers = context.appState[pendingKey] as
      | Record<string, string>
      | undefined

    if (existingAnswers && typeof existingAnswers === 'object') {
      // Answers were provided by the UI layer
      const answers: Record<string, string> = {}

      for (const q of validatedQuestions) {
        const raw = existingAnswers[q.header]
        if (typeof raw === 'string' && raw.trim() !== '') {
          answers[q.header] = raw.trim()
        } else {
          // Fall back to first option if answer is missing
          answers[q.header] = q.options[0].label
        }
      }

      // Clean up appState
      delete context.appState[pendingKey]

      const answerDisplay = formatAnswersDisplay(validatedQuestions, answers)

      return {
        content: `User responses:\n${answerDisplay}`,
        output: { answers, mode: 'interactive' },
      }
    }

    // ── No answers yet - signal pending state ─────────────────────────────
    // Store the questions in appState so the UI layer can pick them up.
    context.appState[pendingKey] = {
      questions: validatedQuestions,
      timestamp: Date.now(),
    }

    const display = formatQuestionsDisplay(validatedQuestions)

    return {
      content:
        `[Awaiting user input]\n\n${display}\n` +
        'The user has been presented with these questions. ' +
        'Answers will be collected when the user responds.',
      output: {
        mode: 'pending',
        questions: validatedQuestions,
      },
    }
  },

  // ── Rendering helpers ─────────────────────────────────────────────────────

  userFacingName: () => 'AskUserQuestion',

  renderToolUseMessage(input: Record<string, unknown>): string {
    const rawQuestions = input.questions
    if (!Array.isArray(rawQuestions)) return 'Ask user questions'

    const headers = rawQuestions
      .map((q) => {
        if (q && typeof q === 'object' && 'header' in q && typeof q.header === 'string') {
          return q.header
        }
        return '?'
      })
      .join(', ')

    return `Ask: ${headers}`
  },

  renderToolResultMessage(result: ToolResult): string {
    if (typeof result.content === 'string') {
      // Show first few lines
      const lines = result.content.split('\n')
      return lines.slice(0, 6).join('\n')
    }
    return '(question response)'
  },

  // ── Prompt addition ───────────────────────────────────────────────────────
  prompt: () =>
    'Use AskUserQuestion to clarify requirements, gather preferences, or ' +
    'confirm implementation choices with the user. Always provide clear, ' +
    'concise options with descriptive labels. The user can always choose ' +
    '"Other" for free-text input.',
})

/**
 * Metadata extension: shouldDefer flag.
 *
 * The standard ToolInstance interface does not include `shouldDefer`,
 * but the orchestrator can check for it via property access:
 *
 *   const tool = AskUserQuestionTool
 *   if ((tool as any).shouldDefer?.()) { ... }
 *
 * We attach it post-build to avoid modifying the shared ToolInstance type.
 */
;(AskUserQuestionTool as ToolInstance & { shouldDefer?: () => boolean }).shouldDefer = () => true

export default AskUserQuestionTool
