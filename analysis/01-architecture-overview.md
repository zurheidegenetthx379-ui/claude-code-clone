# 第一章：软件架构与程序入口

## 1.1 六层架构设计

Claude Code 采用严格的六层分层架构，每一层只依赖其下一层，形成清晰的职责边界：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Layer 6: Extension Layer                      │
│         MCP Servers · Plugins · Custom Tools · Hooks             │
├─────────────────────────────────────────────────────────────────┤
│                 Layer 5: Tool & Permission Layer                 │
│     Tool Registry · Permission System · Sandbox · Approval       │
├─────────────────────────────────────────────────────────────────┤
│                  Layer 4: Execution Kernel                       │
│    Agent Loop · Streaming Executor · Transcript Manager          │
├─────────────────────────────────────────────────────────────────┤
│                  Layer 3: TUI / REPL Layer                       │
│      Ink UI · Input Handling · Output Rendering · Pager          │
├─────────────────────────────────────────────────────────────────┤
│                 Layer 2: Initialization Layer                    │
│    Config Loading · Trust Check · Feature Flags · Auth           │
├─────────────────────────────────────────────────────────────────┤
│                 Layer 1: CLI Bootstrap Layer                     │
│      Argument Parsing · Entry Routing · Quick Paths             │
└─────────────────────────────────────────────────────────────────┘
```

**第一层（CLI Bootstrap）** 负责解析命令行参数并决定执行路径。**第二层（Initialization）** 完成配置加载、信任等级判定、特性开关读取和认证初始化。**第三层（TUI/REPL）** 是用户交互层，基于 Ink（React for CLI）构建终端 UI。**第四层（Execution Kernel）** 是整个系统的核心——Agent Loop 在此运行，流式执行器在此调度工具调用。**第五层（Tool & Permission）** 管理所有内置工具和 MCP 外部工具的注册、权限校验、沙箱隔离。**第六层（Extension）** 提供 MCP Server 托管、插件加载和 Hook 回调等扩展能力。

## 1.2 多入口设计与快速路径分流

项目有两个主入口文件：`cli.ts` 和 `main.ts`。

```
cli.ts  ──→  解析 argv
  │
  ├─ 快速路径（Quick Path）
  │   ├─ --version       → 直接输出版本号，退出
  │   ├─ --help          → 直接输出帮助信息，退出
  │   └─ --config        → 输出/修改配置，退出
  │
  └─ 常规路径
      └─ main.ts ──→ 完整初始化 → 进入运行形态
```

快速路径的设计目标是**零延迟响应**——不加载任何不必要的模块，不初始化 Agent 内核，甚至在某些路径上不触发认证流程。这是通过 `lazy import`（动态 `import()`）实现的：只有在确认需要某个子系统时才加载对应模块。

## 1.3 信任分级初始化

系统在启动时执行**信任等级判定**，分为两个阶段：

- **Pre-Trust 阶段**：在任何用户交互之前执行。加载系统级配置，检查当前目录是否在已信任列表（`.claude/trusted`）中，判断是否处于 CI/CD 环境（自动信任模式）。
- **Post-Trust 阶段**：在用户明确授权（或已被判定为可信环境）之后执行。此时才会加载项目级配置、启动 MCP Server 连接、注册文件系统操作工具。

```typescript
// 伪代码：信任分级
if (trustLevel === 'untrusted') {
  // 只加载只读工具（Read, Glob, Grep）
  // 禁用所有写入类工具（Write, Edit, Bash）
  // 提示用户进行信任授权
} else if (trustLevel === 'project-trusted') {
  // 加载项目配置 .claude/settings.json
  // 启动项目级 MCP Server
  // 注册所有工具，但写入类需逐次确认
} else { // fully-trusted
  // 完整加载，写入类工具按策略自动执行
}
```

## 1.4 四种运行时形态共享一个内核

Claude Code 的设计哲学是**一个内核，多种形态**：

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   REPL/TUI   │  │  Headless    │  │  MCP Server  │  │   Remote/    │
│  (交互式)     │  │  /SDK 模式   │  │   模式       │  │   Bridge    │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │                  │
       └─────────────────┴─────────────────┴──────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │   Execution Kernel  │
                    │   (Agent Loop +     │
                    │    Tool Executor +  │
                    │    Transcript)      │
                    └────────────────────┘
```

| 运行时形态 | 输入来源 | 输出目标 | 典型场景 |
|-----------|---------|---------|---------|
| REPL/TUI | 终端 stdin | Ink 渲染 | 开发者日常交互 |
| Headless/SDK | JSON-RPC stdin | JSON stdout | IDE 集成、脚本调用 |
| MCP Server | MCP 协议请求 | MCP 协议响应 | 被其他 Agent 作为工具调用 |
| Remote/Bridge | WebSocket | WebSocket | 远程服务器执行 |

每种形态的**输入适配层**和**输出适配层**不同，但核心的 Agent Loop、工具执行器、权限系统完全复用。

## 1.5 主执行流程

从用户输入到 Agent 响应的完整流程：

```
用户输入 "帮我重构这个函数"
    │
    ▼
[1] CLI 解析 → 识别为对话模式
    │
    ▼
[2] 初始化 → 加载配置、认证、信任检查
    │
    ▼
[3] 构建 System Prompt → 注入工具列表、记忆、项目上下文
    │
    ▼
[4] Agent Loop 启动
    │
    ├─→ [4a] 调用 LLM API（流式）
    │       │
    │       ▼
    │   [4b] 解析流式响应
    │       ├─ 纯文本 → 直接渲染给用户
    │       └─ Tool Call → 进入工具执行管道
    │               │
    │               ▼
    │           [5] 权限检查 → 沙箱执行 → 结果收集
    │               │
    │               ▼
    │           [6] 工具结果注入对话历史
    │               │
    │               ▼
    │           [7] 回到 [4a]，继续下一轮
    │
    └─→ 直到 LLM 返回纯文本（无 Tool Call），循环结束
```

## 1.6 关键设计模式

### 异步生成器管道

Agent Loop 使用 `async function*` 生成器实现流式处理。LLM 的流式输出被逐 chunk yield 给上层，上层再逐 chunk 渲染或解析。这避免了将整个响应缓冲在内存中。

```typescript
async function* runAgentLoop(prompt: Message): AsyncGenerator<StreamEvent> {
  while (true) {
    const stream = await llm.createStream(messages);
    for await (const chunk of stream) {
      yield chunk; // 流式向上层传递
      if (chunk.type === 'tool_call') {
        const result = await executeTool(chunk);
        messages.push(result);
      }
    }
    if (lastResponseHasNoToolCalls) break;
  }
}
```

### 特性开关（Feature Flags）

所有实验性功能通过特性开关控制，开关来源有三个层级：硬编码默认值 → 服务端远程配置 → 本地环境变量覆盖。开关在运行时惰性求值（lazy evaluation），只在功能首次被调用时才读取。

### 懒加载策略

项目的模块加载采用**按需加载**模式。`import()` 动态导入确保 Node.js 只在真正需要某个子系统时才加载其代码。这使得 `--version` 和 `--help` 等快速路径的响应时间控制在 50ms 以内，即使整个项目有数百个模块。

---

> **小结**：Claude Code 的架构核心是"分层解耦 + 内核复用"。六层架构确保了关注点分离，多入口快速路径优化了启动性能，信任分级保障了安全性，而四种运行时形态通过共享执行内核实现了代码最大化复用。
