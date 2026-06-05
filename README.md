# Claude Code Clone - AI 编码 Agent 框架

一个使用 TypeScript/Node.js 构建的本地 AI 编码 Agent，架构灵感来自 Claude Code。

## 架构概览

```text
+---------------------------+
| CLI / 多入口               |
| entrypoints/cli.ts        |
| main.ts                   |
+---------------------------+
            |
            v
+---------------------------+
| 初始化与运行环境             |
| init.ts / setup.ts        |
+---------------------------+
      |                |
      v                v
+----------------+   +---------------------------+
| 命令与控制面     |   | TUI / REPL 工作台          |
| commands.ts    |-->| REPL.tsx / AppStateStore   |
+----------------+   +---------------------------+
                             |
                             v
                  +---------------------------+
                  | Query / Agent 执行内核     |
                  | query.ts / QueryEngine.ts |
                  +---------------------------+
                    |           |           |
                    v           v           v
          +---------------+ +--------------------+ +----------------------+
          | Tool/Perm     | | Transcript/Memory  | | 平台扩展层             |
          | Tool.ts       | | sessionStorage     | | MCP/Skills/Remote    |
          | orchestration | | SessionMemory      | |                      |
          +---------------+ +--------------------+ +----------------------+
```

## 目录结构

```text
claude-code-clone/
├── README.md
├── package.json
├── tsconfig.json
├── analysis/                           # 中文分析文档集（10篇）
│   ├── 01-architecture-overview.md     # 第一章：软件架构与程序入口
│   ├── 02-security-analysis.md         # 第二章：安全分析
│   ├── 04-agent-memory.md             # 第三章：Agent Memory 机制
│   ├── 04b-tool-call-implementation.md # 第四章：Tool Call 机制
│   ├── 04c-skills-implementation.md    # 第五章：Skills 技术实现
│   ├── 04d-mcp-implementation.md      # 第六章：MCP 技术实现
│   ├── 04e-sandbox-implementation.md   # 第七章：Sandbox 技术实现
│   ├── 04g-prompt-management.md       # 第八章：Prompt 管理机制
│   ├── 04h-multi-agent.md             # 第九章：Multi-Agent 机制
│   └── 09-final-summary.md            # 第十章：总结结论
└── src/                                # 源代码（17,460 行 TypeScript）
    ├── entrypoints/                    # 入口点
    │   ├── cli.ts                      # CLI 快速路径路由器
    │   └── init.ts                     # 信任分级初始化
    ├── main.ts                         # 主编排器
    ├── setup.ts                        # 运行时环境初始化
    ├── commands.ts                     # 斜杠命令系统（12个内置命令）
    ├── query.ts                        # 核心查询循环（async generator）
    ├── QueryEngine.ts                  # 无头执行引擎
    ├── Tool.ts                         # 工具接口 + buildTool() 工厂
    ├── tools.ts                        # 工具注册与装配
    ├── context.ts                      # 运行时上下文注入
    ├── replLauncher.ts                 # REPL 终端启动器
    ├── tools/                          # 内置工具实现
    │   ├── BashTool/                   # Shell 命令执行
    │   ├── FileEditTool/               # 文件编辑（精确替换）
    │   ├── FileReadTool/               # 文件读取（含图片）
    │   ├── WebFetchTool/               # 网页内容抓取
    │   ├── AskUserQuestionTool/        # 用户交互工具
    │   ├── GlobTool/                   # 文件模式匹配搜索
    │   ├── GrepTool/                   # 内容正则搜索
    │   └── AgentTool/                  # 子 Agent 编排
    ├── services/
    │   ├── api/claude.ts               # Claude API 流式通信
    │   ├── mcp/client.ts              # MCP 客户端管理器
    │   ├── compact/compact.ts          # 上下文压缩引擎
    │   └── SessionMemory/              # 会话记忆管理
    ├── skills/loadSkillsDir.ts         # Skills 发现与解析
    ├── memdir/                         # 记忆目录系统
    │   ├── memdir.ts                   # MEMORY.md 构建器
    │   └── findRelevantMemories.ts     # 相关记忆检索
    ├── utils/
    │   ├── sessionStorage.ts           # JSONL 会话持久化
    │   ├── conversationRecovery.ts     # 会话恢复管道
    │   ├── context.ts                  # 上下文窗口管理
    │   ├── systemPrompt.ts            # 优先级提示词装配
    │   └── sandbox/                    # Sandbox 隔离适配器
    ├── state/AppStateStore.ts          # 应用状态管理（观察者模式）
    ├── components/REPL/REPL.tsx        # React+Ink TUI 界面
    ├── constants/prompts.ts            # 系统提示词定义与缓存
    ├── coordinator/coordinatorMode.ts  # 协调者模式
    └── types/index.ts                  # 全局类型定义
```

## 核心特性

### 执行内核
- **异步生成器管道**: `query()` 函数实现完整的工具调用闭环
- **多运行时形态**: REPL/TUI、Headless/SDK、MCP Server 共享同一内核
- **流式工具执行**: 支持并发安全的工具并行执行

### 工具系统
- **Fail-closed 默认策略**: `buildTool()` 工厂确保新工具默认最安全
- **6 阶段执行管道**: Schema 验证 → 语义验证 → Hook 拦截 → 权限检查 → 执行 → 结果生成
- **并发分区调度**: 自动将工具调用分为安全并行组和非安全串行组
- **8 个内置工具**: Bash、FileRead、FileEdit、WebFetch、AskUserQuestion、Agent、Glob、Grep

### 记忆系统
- **四层记忆架构**: Auto Memory、Session Memory、Agent Memory、Team Memory
- **沙箱化记忆提取**: 子代理只能编辑指定的记忆文件
- **上下文压缩**: 自动检测阈值触发压缩，保留工具链完整性
- **相关记忆召回**: 轻量检索而非全量注入（最多5个文件）
- **MemoryDir 注入**: `.cc-agent/memory/MEMORY.md` 入口点 + 兄弟文件清单自动注入系统提示词
- **SessionMemory 提取**: 三级阈值门控（10k tokens + 5k delta + 3 tool calls）自动提取会话记忆
- **相关记忆搜索**: 每次查询前基于关键词评分，自动发现并提示相关记忆文件

### MCP 集成
- **四种传输协议**: stdio、SSE、WebSocket、HTTP（全部使用 @modelcontextprotocol/sdk 真实传输）
- **统一命名空间**: `mcp__server__tool` 格式
- **认证缓存**: 15分钟 TTL 防"认证雪崩"
- **连接批处理**: 本地 batch=3，远程 batch=20

### Skills 扩展
- **三源加载**: 文件型、内置型、MCP 型
- **条件技能**: `paths` 字段实现 Hook 订阅模式
- **内嵌 Shell 执行**: Markdown 中嵌入的命令自动执行（仅信任来源）
- **MCP 安全切断**: MCP 来源的 Skills 禁止执行内嵌 Shell

### Sandbox 隔离（Command Guard）
- **四层执行链**: 决策 → 配置翻译 → 权限集成 → 执行与清理
- **Git 裸仓库逃逸防护**: 两阶段防御（构建时 deny + 执行后 scrub）
- **双向权限耦合**: Sandbox 白名单反馈到路径验证

> **安全声明**: 本模块提供的是启发式预检命令守卫（heuristic pre-flight command guard），**并非**操作系统级别的沙箱隔离。基于模式的命令检测可以被变量展开、脚本文件或解释器绕过。如需真正的隔离，请使用容器或操作系统级沙箱（如 Docker、Firejail、Seatbelt）。

### Prompt 管理
- **六层运行时系统**: 默认 → 装配 → 注入 → 附录 → 缓存 → 任务专用
- **优先级装配**: override > coordinator > agent > custom > default + append
- **分段缓存**: `systemPromptSection` vs `DANGEROUS_uncachedSystemPromptSection`
- **动态边界哨兵**: 优化 API 层的前缀缓存命中率

### Multi-Agent
- **三种模型**: 普通子代理、协调者模式、Swarm 团队
- **Fork 变体**: 继承父代理的渲染提示词字节以保缓存命中
- **双轨通信**: 文件邮箱 + 本地任务恢复
- **领导者权限桥接**: 子代理权限请求转发到主线程 UI

### 会话持久化
- **JSONL 事件流**: 追加写入，读取路径吸收所有复杂性
- **UUID 去重**: 主链去重，侧链保留副本
- **轻量读取**: 头尾 64KB 窗口用于会话列表展示
- **恢复管道**: 图重建 + 链修复 + 中断检测 + 状态恢复

## 快速开始

```bash
# 安装依赖
npm install

# 配置 API（复制模板并填入你的密钥）
cp .env.example .env
# 编辑 .env 填入 API 密钥和模型

# 构建
npm run build

# 启动交互 REPL
npm start

# Headless 模式（管道友好）
node dist/entrypoints/cli.js -p "解释这个项目的架构"

# React+Ink 全屏 TUI
node dist/entrypoints/cli.js --ink

# 指定模型（覆盖 .env 配置）
node dist/entrypoints/cli.js --model claude-sonnet-4-20250514
```

## 配置

在项目根目录创建 `.env` 文件（参考 `.env.example`），启动时自动加载：

```ini
# LongCat API (Anthropic 兼容)
ANTHROPIC_API_KEY=ak_your_key_here
ANTHROPIC_BASE_URL=https://api.longcat.chat/anthropic
ANTHROPIC_AUTH_HEADER=Bearer ak_your_key_here
CC_AGENT_MODEL=LongCat-2.0-Preview

# 或直接使用 Anthropic API
# ANTHROPIC_API_KEY=sk-ant-xxxxx
# CC_AGENT_MODEL=claude-sonnet-4-20250514
```

CLI 参数（`--model` 等）优先级高于 `.env`，`.env` 优先级高于系统环境变量。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ANTHROPIC_API_KEY` | API 密钥 | 必需 |
| `ANTHROPIC_BASE_URL` | API 基础 URL（兼容第三方代理） | https://api.anthropic.com |
| `ANTHROPIC_AUTH_HEADER` | 自定义 Authorization 头（用于 Bearer 认证的第三方 API） | - |
| `CC_AGENT_MODEL` | 默认模型 | claude-sonnet-4-20250514 |
| `CC_AGENT_CONFIG_DIR` | 配置目录 | ~/.cc-agent |
| `CLAUDE_CODE_COORDINATOR_MODE` | 启用协调者模式 | false |

## 内置命令

| 命令 | 说明 |
|------|------|
| `/help` | 列出所有可用命令 |
| `/clear` | 清除对话历史 |
| `/compact` | 压缩上下文 |
| `/model [name]` | 查看/切换模型 |
| `/permissions` | 显示权限设置 |
| `/tools` | 列出可用工具 |
| `/skills` | 列出已加载技能 |
| `/memory` | 显示记忆状态 |
| `/resume [id]` | 恢复之前的会话 |
| `/cost` | 显示 Token 用量和费用 |
| `/exit` | 退出 |

## 技术栈

- **运行时**: Node.js 20+
- **语言**: TypeScript 5.x
- **AI API**: Anthropic Claude (via @anthropic-ai/sdk)
- **协议**: Model Context Protocol (via @modelcontextprotocol/sdk)
- **TUI**: React 18 + Ink 5
- **验证**: Zod
- **配置**: YAML + JSON

## 与原版 Claude Code 的差异

本复刻项目在忠实还原 Claude Code 核心架构的同时，有以下设计调整：

1. **项目名**: 使用 `cc-agent` 替代 `claude-code`，配置目录使用 `~/.cc-agent`
2. **简化 TUI**: 使用 readline 作为基础 REPL 循环，Ink 组件作为可选的高级界面
3. **MCP 传输层**: 提供架构骨架，实际协议集成需要接入 `@modelcontextprotocol/sdk`
4. **Command Guard (Sandbox)**: 提供启发式预检命令守卫（配置适配层），实际隔离依赖平台能力。**注意**：这是基于模式的检测，非操作系统级沙箱，可被变量展开、脚本等方式绕过。
5. **去遥测**: 移除了原版的数据收集和遥测上报逻辑

## 许可证

MIT - 仅供学术研究与技术学习使用。Claude Code 的所有权利归 Anthropic 所有。
