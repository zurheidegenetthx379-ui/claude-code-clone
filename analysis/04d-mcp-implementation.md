# 第五章：MCP 技术实现细节与运行机制

## 5.1 四种传输协议

MCP（Model Context Protocol）支持四种传输协议，适配不同的部署场景：

```
┌──────────────────────────────────────────────────────────────────┐
│                     MCP 传输协议矩阵                              │
├──────────┬───────────────────┬──────────────┬────────────────────┤
│  协议     │  适用场景          │  通信方式     │  典型部署          │
├──────────┼───────────────────┼──────────────┼────────────────────┤
│ stdio    │ 本地进程           │ 标准输入/输出  │ 本地 MCP Server   │
│ SSE      │ HTTP 长连接        │ 单向流+POST   │ 远程只读服务       │
│ WebSocket│ 双向实时           │ 全双工帧      │ 远程交互式服务      │
│ HTTP     │ 无状态请求         │ 请求/响应      │ 无状态微服务       │
└──────────┴───────────────────┴──────────────┴────────────────────┘
```

### stdio 传输（本地首选）

```typescript
// stdio 传输的生命周期
const server = spawn('node', ['mcp-server.js'], {
  stdio: ['pipe', 'pipe', 'inherit']  // stdin=输入, stdout=输出, stderr=继承
});

// 通信格式：JSON-RPC 2.0 over newline-delimited JSON
// 请求 →
server.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'search', arguments: { query: 'TODO' } }
}) + '\n');

// ← 响应
server.stdout.on('data', (chunk) => {
  const response = JSON.parse(chunk.toString().trim());
  // { jsonrpc: '2.0', id: 1, result: { ... } }
});
```

### SSE 传输（远程长连接）

```
客户端                              MCP Server
  │                                    │
  │── GET /sse ──────────────────────→│
  │                                    │
  │←── data: {endpoint: "/messages"} ─│  (SSE 推送 endpoint 信息)
  │                                    │
  │── POST /messages (JSON-RPC) ────→│  (通过 HTTP POST 发送请求)
  │                                    │
  │←── data: {jsonrpc result} ───────│  (通过 SSE 流接收响应)
  │                                    │
```

### WebSocket 传输（双向实时）

WebSocket 提供全双工通信，适合需要服务端主动推送通知的场景（如文件变更通知、长时间运行的任务进度）。

### HTTP 传输（无状态）

最简单的传输方式，每个请求独立，不维护连接状态。适合部署在 Serverless 环境（如 AWS Lambda）中的 MCP Server。

## 5.2 工具命名统一：mcp__server__tool

为避免不同 MCP Server 提供的工具名称冲突，Claude Code 对所有 MCP 工具执行**命名空间统一**：

```
原始 MCP Server 注册的工具：
  Server "filesystem":  { tools: ["read_file", "write_file", "list_dir"] }
  Server "github":      { tools: ["search", "create_issue", "read_file"] }
                                        ↑ 名称冲突！

统一命名后：
  mcp__filesystem__read_file
  mcp__filesystem__write_file
  mcp__filesystem__list_dir
  mcp__github__search
  mcp__github__create_issue
  mcp__github__read_file       ← 不再冲突
```

命名格式为 `mcp__{serverName}__{toolName}`，双下划线作为分隔符。这个命名在以下所有环节保持一致：

- System Prompt 中的工具列表
- LLM 输出的 `tool_use` 块中的工具名
- Transcript 中的工具调用记录
- 权限规则中的工具匹配模式

## 5.3 连接管理与并发控制

MCP 连接的并发控制根据传输类型区分策略：

```
┌─────────────────────────────────────────────────┐
│              并发控制策略                          │
├─────────────────┬───────────────────────────────┤
│  本地 (stdio)    │  远程 (SSE/WS/HTTP)           │
├─────────────────┼───────────────────────────────┤
│  batch = 3      │  batch = 20                   │
│  原因：          │  原因：                        │
│  - 本地进程资源   │  - 网络 I/O 非 CPU 密集        │
│    有限          │  - 远程服务通常有负载均衡         │
│  - 避免本地      │  - 更高并发可充分利用            │
│    I/O 争用      │    网络带宽                    │
│  - 文件操作需要   │  - 请求间无本地资源争用          │
│    磁盘锁协调     │                               │
└─────────────────┴───────────────────────────────┘
```

### 并发调度实现

```typescript
class MCPConnectionPool {
  private semaphore: Semaphore;
  
  constructor(transport: 'stdio' | 'remote') {
    const batchSize = transport === 'stdio' ? 3 : 20;
    this.semaphore = new Semaphore(batchSize);
  }

  async callTool(toolName: string, args: any): Promise<ToolResult> {
    // 获取信号量（如果已达并发上限则等待）
    await this.semaphore.acquire();
    try {
      return await this.connection.call(toolName, args);
    } finally {
      // 释放信号量
      this.semaphore.release();
    }
  }
}
```

## 5.4 认证缓存防"认证雪崩"

远程 MCP Server 需要认证。当多个工具调用同时触发时，如果不加控制，会产生大量并发认证请求（"认证雪崩"）。Claude Code 通过认证缓存解决这个问题：

```
工具调用 1 ──→ 需要认证 ──→ 发起 OAuth 流程 ──→ 获取 Token ──→ 缓存
工具调用 2 ──→ 需要认证 ──→ 发现缓存中有 Token（未过期）──→ 直接使用
工具调用 3 ──→ 需要认证 ──→ 发现缓存中有 Token（未过期）──→ 直接使用
   ...
工具调用 N ──→ 缓存 Token 过期 ──→ 重新认证 ──→ 更新缓存
```

### 缓存策略

```typescript
interface AuthCacheEntry {
  token: string;
  expiresAt: number;      // Token 过期时间
  cachedAt: number;       // 缓存时间
  ttl: 15 * 60 * 1000;   // 固定 15 分钟 TTL
}

function isTokenValid(entry: AuthCacheEntry): boolean {
  const now = Date.now();
  // 双重检查：既要看 Token 自身是否过期，也要看缓存 TTL
  return now < entry.expiresAt && (now - entry.cachedAt) < entry.ttl;
}
```

**15 分钟 TTL 的设计考量**：
- 太短（如 1 分钟）：频繁重新认证，增加延迟和认证服务负载
- 太长（如 1 小时）：Token 撤销后仍被使用的时间窗口过大
- 15 分钟：在安全性和性能之间取得平衡

### 并发认证请求去重

```typescript
class AuthManager {
  private pendingAuth: Map<string, Promise<Token>> = new Map();
  
  async authenticate(serverUrl: string): Promise<Token> {
    // 如果已有进行中的认证请求，复用其 Promise
    if (this.pendingAuth.has(serverUrl)) {
      return this.pendingAuth.get(serverUrl)!;
    }
    
    const authPromise = this.doAuthenticate(serverUrl);
    this.pendingAuth.set(serverUrl, authPromise);
    
    try {
      const token = await authPromise;
      this.cache.set(serverUrl, { token, cachedAt: Date.now(), ... });
      return token;
    } finally {
      this.pendingAuth.delete(serverUrl);
    }
  }
}
```

当 10 个工具调用同时需要认证时，只有**一个**认证请求被发出，其余 9 个等待复用结果。

## 5.5 会话过期检测与重连

MCP 连接可能因网络中断、服务端重启等原因断开。Claude Code 实现了自动检测与重连机制：

```
正常通信
    │
    ▼
[心跳检测 / 请求超时]
    │
    ├─ 响应正常 → 继续
    │
    └─ 超时或连接错误
        │
        ▼
    [标记连接为 STALE]
        │
        ▼
    [指数退避重连]
        ├─ 第 1 次：等待 1s
        ├─ 第 2 次：等待 2s
        ├─ 第 3 次：等待 4s
        ├─ 第 4 次：等待 8s
        └─ 第 5 次：等待 16s（上限）
            │
            ├─ 重连成功 → 恢复通信，重新注册工具
            │
            └─ 重连失败（超过最大重试次数）
                │
                ▼
            [标记 Server 为 OFFLINE]
                │
                ▼
            [从工具列表中移除该 Server 的工具]
                │
                ▼
            [通知用户 MCP Server 不可用]
```

## 5.6 IDE 工具白名单

当 Claude Code 作为 IDE 插件（如 VS Code 扩展）运行时，MCP 工具的可用性受到**白名单**限制：

```json
{
  "ide": {
    "allowedMCPServers": ["filesystem", "search"],
    "allowedTools": [
      "mcp__filesystem__read_file",
      "mcp__filesystem__list_dir",
      "mcp__search__code_search"
    ],
    "blockedTools": [
      "mcp__*__shell_execute",
      "mcp__*__delete_file"
    ]
  }
}
```

白名单机制的优先级：
1. IDE 白名单（最高优先级，不可被项目配置覆盖）
2. 用户配置的工具权限
3. 项目配置的工具权限
4. 系统默认权限（最低优先级）

## 5.7 描述长度限制

MCP 工具的描述信息会被注入到 System Prompt 中，过长的描述会浪费 Token 预算。Claude Code 对此执行硬截断：

```typescript
const MAX_DESCRIPTION_LENGTH = 2048; // 字符数

function normalizeToolDescription(desc: string): string {
  if (desc.length <= MAX_DESCRIPTION_LENGTH) {
    return desc;
  }
  
  // 智能截断：在句子边界处截断，而非硬切
  const truncated = desc.substring(0, MAX_DESCRIPTION_LENGTH - 20);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf('。'),
    truncated.lastIndexOf('\n')
  );
  
  if (lastSentenceEnd > MAX_DESCRIPTION_LENGTH * 0.7) {
    return truncated.substring(0, lastSentenceEnd + 1) + ' [truncated]';
  }
  
  return truncated + '... [truncated]';
}
```

### Token 预算分析

```
假设 System Prompt 中工具描述总预算 = 10,000 tokens
平均每个工具描述 ≈ 200 tokens（约 800 字符）
最多支持 ≈ 50 个工具的描述

若某 MCP Server 注册了 20 个工具，每个描述 5000 字符：
  未截断: 20 × 5000 = 100,000 字符 ≈ 25,000 tokens → 严重超预算!
  截断后: 20 × 2048 = 40,960 字符 ≈ 10,240 tokens → 可接受范围
```

2048 字符的截断阈值确保了即使注册了大量 MCP 工具，工具描述也不会挤占对话上下文的 Token 空间。

---

> **小结**：MCP 的技术实现围绕"连接可靠性"和"资源效率"两个核心目标。四种传输协议覆盖从本地进程到远程服务的完整场景，统一命名避免工具冲突，差异化并发策略适配本地和远程的资源特征，认证缓存和去重机制防止认证雪崩，而描述长度限制则守护了 System Prompt 的 Token 预算。
