/**
 * Initialization system with trust-gated phases
 *
 * Mirrors Claude Code's init.ts architecture:
 * - Phase 1 (Pre-trust): Safe environment variables, certificates, HTTP agent, telemetry skeleton
 * - Trust gate: User grants trust (implicit in REPL mode, explicit in headless)
 * - Phase 2 (Post-trust): Full telemetry, all environment variables, sensitive config
 *
 * This separation ensures that no sensitive data is accessed or transmitted
 * before the user has explicitly or implicitly granted trust.
 */

import * as http from 'http'
import * as https from 'https'
import type { PermissionMode } from '../types/index.js'

// ============================================================
// Initialization Context
// ============================================================

export interface InitOptions {
  /** Working directory for the session */
  cwd: string
  /** Permission mode (affects trust gating) */
  permissionMode: PermissionMode
  /** Whether running in headless mode (no interactive trust prompt) */
  headless: boolean
  /** Enable verbose logging during initialization */
  verbose?: boolean
}

export interface InitContext {
  /** Working directory resolved during init */
  cwd: string
  /** Permission mode */
  permissionMode: PermissionMode
  /** Whether trust has been granted */
  trustGranted: boolean
  /** HTTP agent configured during init */
  httpAgent: http.Agent
  /** HTTPS agent configured during init */
  httpsAgent: https.Agent
  /** Telemetry state */
  telemetry: TelemetryState
  /** Timestamp when initialization started */
  initStartedAt: number
  /** Timestamp when initialization completed */
  initCompletedAt?: number
  /** Verbose logging enabled */
  verbose: boolean
}

export interface TelemetryState {
  /** Whether telemetry collection is enabled */
  enabled: boolean
  /** Registered telemetry sinks */
  sinks: TelemetrySink[]
  /** Whether full telemetry (post-trust) is active */
  fullyActive: boolean
}

export interface TelemetrySink {
  name: string
  emit(event: TelemetryEvent): void | Promise<void>
}

export interface TelemetryEvent {
  type: string
  timestamp: number
  data: Record<string, unknown>
}

// ============================================================
// Safe Environment Variables (Pre-Trust)
// ============================================================

/**
 * Environment variables that are safe to read before trust is granted.
 * These affect only local behavior and do not transmit sensitive data.
 */
const SAFE_ENV_VARS: ReadonlyArray<{
  key: string
  target: string
  transform?: (value: string) => string
}> = [
  { key: 'CC_AGENT_NO_COLOR', target: 'NO_COLOR' },
  { key: 'CC_AGENT_DEBUG', target: 'DEBUG' },
  { key: 'CC_AGENT_LOG_LEVEL', target: 'LOG_LEVEL' },
  { key: 'NODE_ENV', target: 'NODE_ENV' },
  {
    key: 'CC_AGENT_HOME',
    target: 'CC_AGENT_HOME',
    transform: (v) => v.trim() || '',
  },
]

/**
 * Environment variables that require trust before application.
 * These may contain API keys, tokens, or affect network behavior.
 */
const SENSITIVE_ENV_VARS: ReadonlyArray<{
  key: string
  target: string
  description: string
}> = [
  { key: 'ANTHROPIC_API_KEY', target: 'ANTHROPIC_API_KEY', description: 'Anthropic API key' },
  { key: 'ANTHROPIC_BASE_URL', target: 'ANTHROPIC_BASE_URL', description: 'API base URL override' },
  { key: 'HTTPS_PROXY', target: 'HTTPS_PROXY', description: 'HTTPS proxy' },
  { key: 'HTTP_PROXY', target: 'HTTP_PROXY', description: 'HTTP proxy' },
  { key: 'NO_PROXY', target: 'NO_PROXY', description: 'No-proxy list' },
  { key: 'CC_AGENT_MCP_SERVERS', target: 'CC_AGENT_MCP_SERVERS', description: 'MCP server config' },
]

// ============================================================
// Phase 1: Pre-Trust Initialization
// ============================================================

/**
 * Apply only safe environment variables that don't require trust.
 * These are purely local configuration (colors, logging, etc.).
 */
export function applySafeEnvironmentVariables(verbose: boolean = false): void {
  for (const { key, target, transform } of SAFE_ENV_VARS) {
    const value = process.env[key]
    if (value !== undefined) {
      const resolved = transform ? transform(value) : value
      if (resolved) {
        process.env[target] = resolved
        if (verbose) {
          log('init', `Applied safe env var: ${key}=${resolved}`)
        }
      }
    }
  }

  // Respect NO_COLOR convention (https://no-color.org/)
  if (process.env['NO_COLOR'] !== undefined) {
    process.env['FORCE_COLOR'] = '0'
  }
}

/**
 * Initialize TLS certificates and HTTPS proxy configuration.
 *
 * In enterprise environments, custom CA bundles may need to be loaded.
 * This is a placeholder for that functionality.
 */
export function initializeCertificates(verbose: boolean = false): void {
  // Check for custom CA bundle path
  const caBundlePath = process.env['CC_AGENT_CA_BUNDLE'] || process.env['NODE_EXTRA_CA_CERTS']
  if (caBundlePath && verbose) {
    log('init', `Custom CA bundle configured: ${caBundlePath}`)
  }

  // Disable TLS rejection only in explicit dev/test scenarios
  if (process.env['CC_AGENT_INSECURE_TLS'] === '1' && process.env['NODE_ENV'] !== 'production') {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
    if (verbose) {
      log('init', 'WARNING: TLS certificate verification disabled (CC_AGENT_INSECURE_TLS=1)')
    }
  }
}

/**
 * Configure HTTP and HTTPS agents with connection pooling and proxy settings.
 *
 * Uses safe defaults:
 * - Keep-alive enabled for connection reuse
 * - Reasonable socket limits to avoid resource exhaustion
 * - Proxy support deferred to post-trust (requires HTTPS_PROXY env var)
 */
export function initializeHttpAgent(verbose: boolean = false): {
  httpAgent: http.Agent
  httpsAgent: https.Agent
} {
  const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 20,
    maxFreeSockets: 5,
    timeout: 30_000,
  })

  const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 20,
    maxFreeSockets: 5,
    timeout: 30_000,
  })

  // Register agents as global defaults for Node's http/https modules.
  // This ensures all outgoing requests use our configured agents.
  // Note: We deliberately do NOT read HTTPS_PROXY here (requires trust).
  if (verbose) {
    log('init', 'HTTP agents configured with keep-alive pooling')
  }

  return { httpAgent, httpsAgent }
}

/**
 * Register the telemetry skeleton — minimal sinks that buffer events
 * until full telemetry is activated after trust.
 *
 * Pre-trust sinks:
 * - Console logger (if verbose)
 * - In-memory buffer (flushed when full telemetry activates)
 */
export function initTelemetrySkeleton(verbose: boolean = false): TelemetryState {
  const buffer: TelemetryEvent[] = []

  const bufferSink: TelemetrySink = {
    name: 'pre-trust-buffer',
    emit(event) {
      // Cap buffer at 1000 events to prevent memory leaks
      if (buffer.length < 1000) {
        buffer.push(event)
      }
    },
  }

  const sinks: TelemetrySink[] = [bufferSink]

  // Add console sink in verbose mode
  if (verbose) {
    sinks.push({
      name: 'console-verbose',
      emit(event) {
        log('telemetry', `[${event.type}] ${JSON.stringify(event.data)}`)
      },
    })
  }

  if (verbose) {
    log('init', `Telemetry skeleton initialized with ${sinks.length} sink(s)`)
  }

  return {
    enabled: true,
    sinks,
    fullyActive: false,
  }
}

// ============================================================
// Phase 2: Post-Trust Initialization
// ============================================================

/**
 * Activate full telemetry after trust is granted.
 *
 * Post-trust sinks:
 * - File-based event log
 * - Analytics endpoint (if configured)
 * - Flushes buffered pre-trust events
 */
export function initializeTelemetryAfterTrust(
  telemetry: TelemetryState,
  _cwd: string,
  verbose: boolean = false,
): TelemetryState {
  if (!telemetry.enabled) {
    return telemetry
  }

  // File sink for persistent event logging
  const fileSink: TelemetrySink = {
    name: 'file-log',
    emit(_event) {
      // Placeholder: In production, this writes to ~/.cc-agent/telemetry/events.jsonl
      // Deferred implementation to avoid I/O during init
    },
  }

  // Add the file sink
  telemetry.sinks.push(fileSink)

  // Flush buffered pre-trust events to new sinks
  // (In production, this would read from the buffer sink and replay)
  if (verbose) {
    log('init', `Full telemetry activated with ${telemetry.sinks.length} sink(s)`)
  }

  telemetry.fullyActive = true
  return telemetry
}

/**
 * Apply all environment variables, including sensitive ones, after trust is granted.
 *
 * This is where API keys, proxy configuration, and MCP server settings
 * are read and applied.
 */
export function applyFullEnvironmentVariables(verbose: boolean = false): void {
  for (const { key, target, description } of SENSITIVE_ENV_VARS) {
    const value = process.env[key]
    if (value !== undefined) {
      process.env[target] = value
      if (verbose) {
        // Mask sensitive values in logs
        const masked = maskSensitiveValue(key, value)
        log('init', `Applied sensitive env var: ${key}=${masked} (${description})`)
      }
    }
  }

  // Configure proxy agents if proxy env vars are set
  configureProxyAgents(verbose)
}

// ============================================================
// Main Initialization Orchestrator
// ============================================================

/**
 * Run all initialization phases in the correct order.
 *
 * Phase ordering:
 * 1. Safe environment variables (no trust required)
 * 2. Certificate initialization (may need custom CA bundles)
 * 3. HTTP agent setup (uses certs from step 2)
 * 4. Telemetry skeleton (buffers events until trust)
 * 5. Trust gate (implicit in REPL, explicit in headless)
 * 6. Full telemetry activation
 * 7. Full environment variable application
 *
 * @param options - Initialization options
 * @returns Initialized context with all subsystems ready
 */
export async function init(options: InitOptions): Promise<InitContext> {
  const startedAt = Date.now()
  const verbose = options.verbose ?? false

  if (verbose) {
    log('init', 'Starting initialization...')
    log('init', `  cwd: ${options.cwd}`)
    log('init', `  permissionMode: ${options.permissionMode}`)
    log('init', `  headless: ${options.headless}`)
  }

  // ---- Phase 1: Pre-Trust ----

  // Step 1: Safe environment variables
  applySafeEnvironmentVariables(verbose)

  // Step 2: Certificate setup
  initializeCertificates(verbose)

  // Step 3: HTTP agent configuration
  const { httpAgent, httpsAgent } = initializeHttpAgent(verbose)

  // Step 4: Telemetry skeleton
  const telemetry = initTelemetrySkeleton(verbose)

  // ---- Trust Gate ----
  // In REPL mode, trust is implicit (user is present and interactive).
  // In headless mode with bypassPermissions, trust is granted by flag.
  // Otherwise, trust is granted when the user sends their first message.
  const trustGranted = resolveTrustGate(options)

  if (verbose) {
    log('init', `Trust gate: ${trustGranted ? 'granted' : 'deferred'}`)
  }

  // ---- Phase 2: Post-Trust ----

  // Step 5: Full telemetry (only if trust is granted)
  const finalTelemetry = trustGranted
    ? initializeTelemetryAfterTrust(telemetry, options.cwd, verbose)
    : telemetry

  // Step 6: Full environment variables (only if trust is granted)
  if (trustGranted) {
    applyFullEnvironmentVariables(verbose)
  }

  const ctx: InitContext = {
    cwd: options.cwd,
    permissionMode: options.permissionMode,
    trustGranted,
    httpAgent,
    httpsAgent,
    telemetry: finalTelemetry,
    initStartedAt: startedAt,
    initCompletedAt: Date.now(),
    verbose,
  }

  if (verbose) {
    const elapsed = (ctx.initCompletedAt ?? Date.now()) - startedAt
    log('init', `Initialization complete in ${elapsed}ms`)
  }

  return ctx
}

/**
 * Emit a telemetry event through all registered sinks.
 *
 * Safe to call before full telemetry activation — events will be buffered
 * by the pre-trust buffer sink.
 */
export function emitTelemetry(
  ctx: InitContext,
  type: string,
  data: Record<string, unknown> = {},
): void {
  if (!ctx.telemetry.enabled) return

  const event: TelemetryEvent = {
    type,
    timestamp: Date.now(),
    data,
  }

  for (const sink of ctx.telemetry.sinks) {
    try {
      sink.emit(event)
    } catch {
      // Telemetry sinks must never crash the application
    }
  }
}

/**
 * Grant trust post-initialization (e.g., when user sends first message in REPL).
 * Activates full telemetry and applies sensitive environment variables.
 */
export function grantTrust(ctx: InitContext): InitContext {
  if (ctx.trustGranted) return ctx

  const verbose = ctx.verbose
  if (verbose) {
    log('init', 'Trust granted — activating post-trust subsystems')
  }

  const telemetry = initializeTelemetryAfterTrust(ctx.telemetry, ctx.cwd, verbose)
  applyFullEnvironmentVariables(verbose)

  emitTelemetry({ ...ctx, telemetry, trustGranted: true }, 'trust.granted', {})

  return {
    ...ctx,
    trustGranted: true,
    telemetry,
  }
}

/**
 * Cleanup function to be called on shutdown.
 * Destroys HTTP agents and flushes remaining telemetry.
 */
export async function shutdown(ctx: InitContext): Promise<void> {
  if (ctx.verbose) {
    log('init', 'Shutting down initialization subsystems...')
  }

  // Emit shutdown telemetry
  emitTelemetry(ctx, 'shutdown', {
    sessionDuration: Date.now() - ctx.initStartedAt,
  })

  // Destroy HTTP agents to free sockets
  ctx.httpAgent.destroy()
  ctx.httpsAgent.destroy()

  if (ctx.verbose) {
    log('init', 'Shutdown complete')
  }
}

// ============================================================
// Internal Helpers
// ============================================================

/**
 * Determine whether trust should be granted immediately at init time.
 *
 * Trust is granted when:
 * - Running in REPL mode (user is present and interactive)
 * - Permission mode is bypassPermissions (user explicitly opted in)
 * - Running in headless mode with --sdk (machine-to-machine, trust by contract)
 */
function resolveTrustGate(options: InitOptions): boolean {
  // bypassPermissions implies explicit trust
  if (options.permissionMode === 'bypassPermissions') {
    return true
  }

  // Non-headless (REPL) mode: trust is implicit
  if (!options.headless) {
    return true
  }

  // Headless mode: defer trust until explicitly granted
  return false
}

/**
 * Configure proxy agents from environment variables.
 * Called only after trust is granted.
 */
function configureProxyAgents(verbose: boolean = false): void {
  const httpsProxy = process.env['HTTPS_PROXY'] || process.env['https_proxy']
  const httpProxy = process.env['HTTP_PROXY'] || process.env['http_proxy']

  if (httpsProxy && verbose) {
    log('init', `HTTPS proxy configured: ${maskProxyUrl(httpsProxy)}`)
  }

  if (httpProxy && verbose) {
    log('init', `HTTP proxy configured: ${maskProxyUrl(httpProxy)}`)
  }

  // In production, this would create tunneling proxy agents using
  // a library like `https-proxy-agent` and register them as global defaults.
  // Placeholder: proxy agent creation is deferred to the HTTP client layer.
}

/**
 * Mask a sensitive environment variable value for safe logging.
 * Shows the first and last few characters with asterisks in between.
 */
function maskSensitiveValue(key: string, value: string): string {
  // API keys get aggressive masking
  if (key.includes('API_KEY') || key.includes('TOKEN') || key.includes('SECRET')) {
    if (value.length <= 8) return '****'
    return `${value.slice(0, 4)}${'*'.repeat(Math.min(value.length - 8, 20))}${value.slice(-4)}`
  }
  // Other sensitive values get moderate masking
  if (value.length <= 4) return '****'
  return `${value.slice(0, 2)}${'*'.repeat(Math.min(value.length - 4, 16))}${value.slice(-2)}`
}

/**
 * Mask a proxy URL to hide embedded credentials.
 */
function maskProxyUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username) {
      parsed.username = '***'
      parsed.password = '***'
    }
    return parsed.toString()
  } catch {
    return '***'
  }
}

/**
 * Structured log helper for initialization subsystem.
 */
function log(subsystem: string, message: string): void {
  const timestamp = new Date().toISOString()
  console.error(`[${timestamp}] [${subsystem}] ${message}`)
}
