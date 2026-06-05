# 第四章：Tool Call 机制实现细节

## 4.1 工具调用不是"模型直接调函数"

一个常见的误解是：LLM 输出一个函数调用，系统直接执行。实际上，从模型输出 `tool_use` 块到最终结果回流，中间经过一条**多层运行时管道**：

```
LLM 输出 tool_use 块
    │
    ▼
[1] Schema 解析与验证
    │  ← 解析 JSON 参数，校验是否符合工具定义的 Schema
    │
    ▼
[2] 语义验证
    │  ← 检查参数值的合理性（路径是否存在、命令是否安全）
    │
    ▼
[3] Hook 拦截 (Pre-Execution)
    │  ← 触发用户配置的 pre-hook，可修改参数或拒绝执行
    │
    ▼
[4] 权限检查
    │  ← 查询权限系统：allow / deny / ask-user
    │
    ▼
[5] 并发分区调度
    │  ← 多个工具调用按依赖关系分区，区内并行、区间串行
    │
    ▼
[6] 沙箱执行
    │  ← 在受限环境中执行工具逻辑
    │
    ▼
[7] 结果收集与标准化
    │  ← 统一输出格式（text / image / error）
    │
    ▼
[8] Hook 回调 (Post-Execution)
    │  ← 触发 post-hook，可审计或转换结果
    │
    ▼
[9] Transcript 记录
    │  ← 写入完整执行记录（唯一真相来源）
    │
    ▼
[10] 结果回流
     ← 分两路：UI 面（人类可读）+ 模型面（Token 优化）
```

这十个步骤确保了每一次工具调用都是**安全的、可审计的、可回溯的**。

## 4.2 Tool 接口设计与 buildTool() 工厂函数

每个工具通过 `buildTool()` 工厂函数创建，该函数采用**声明式配置 + fail-closed 默认策略**：

```typescript
// 工具定义的简化示例
const readFileTool = buildTool({
  name: 'Read',
  description: 'Reads a file from the filesystem',
  
  // Schema 定义（用于验证 LLM 输出的参数）
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file' },
      offset: { type: 'number', description: 'Line offset to start reading' },
      limit: { type: 'number', description: 'Maximum lines to read' },
    },
    required: ['file_path'],
  },

  // 权限默认值（fail-closed：未显式配置则最严格）
  needsPermission: true,        // 默认需要权限检查
  isReadOnly: false,            // 默认视为写操作（更严格）
  requiresSandbox: true,        // 默认需要沙箱隔离

  // 执行函数
  async execute(input, context) {
    const content = await fs.readFile(input.file_path, 'utf-8');
    return { type: 'text', content: withLineNumbers(content) };
  },

  // UI 展示格式化
  formatForUser(input, result) {
    return `Read ${input.file_path} (${countLines(result)} lines)`;
  },

  // 模型面格式化（Token 优化）
  formatForModel(input, result) {
    return truncateForContext(result.content, MAX_TOOL_RESULT_TOKENS);
  },
});
```

### Fail-Closed 默认策略

```
buildTool() 的默认值选择原则：

  needsPermission    → true   (而非 false)
  isReadOnly         → false  (而非 true)
  requiresSandbox    → true   (而非 false)
  allowsConcurrent   → false  (而非 true)

结果：忘记配置 = 最安全的执行路径
```

这意味着开发者新增工具时，即使忘记设置安全相关的配置项，工具也会以最严格的方式执行——需要权限确认、在沙箱中运行、不允许并发。

## 4.3 权限系统多阶段门控

工具调用的权限检查不是单一节点，而是**多阶段门控**：

```
工具调用请求
    │
    ▼
┌─── Gate 1: Schema 验证 ───────────────────────┐
│  参数是否符合 JSON Schema？                      │
│  失败 → 直接拒绝，不进入后续流程                   │
└────────────────────────────────────────────────┘
    │ 通过
    ▼
┌─── Gate 2: 语义验证 ──────────────────────────┐
│  参数值是否合理？                                 │
│  - 路径是否包含目录穿越（../../etc/passwd）？      │
│  - 命令是否包含危险操作（rm -rf /）？              │
│  - 文件是否在允许的路径列表内？                     │
└────────────────────────────────────────────────┘
    │ 通过
    ▼
┌─── Gate 3: Hook 拦截 ────────────────────────┐
│  用户配置的 pre-hook 脚本是否允许？               │
│  - 返回 exit 0 → 放行                          │
│  - 返回 exit 非0 → 拒绝并附带原因                │
│  - 输出修改后的参数 → 使用修改后的参数继续          │
└────────────────────────────────────────────────┘
    │ 通过
    ▼
┌─── Gate 4: 权限规则匹配 ─────────────────────┐
│  按优先级匹配权限规则：                           │
│  1. 用户显式规则（.claude/settings.json）        │
│  2. 项目规则（项目级 .claude/settings.json）      │
│  3. 系统默认规则                                 │
│                                                │
│  结果：                                         │
│  - allow → 直接执行                             │
│  - deny → 拒绝并告知原因                         │
│  - ask → 弹出确认对话框，等待用户决策               │
└────────────────────────────────────────────────┘
    │ allow
    ▼
[执行工具]
```

### 权限规则的粒度

权限规则支持多种匹配维度：

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Glob",
      "Grep"
    ],
    "deny": [
      "Bash(rm -rf *)"
    ],
    "ask": [
      "Write(*.env)",
      "Bash(curl *)"
    ]
  }
}
```

- 工具名匹配：`"Read"` — 允许所有 Read 调用
- 参数模式匹配：`"Bash(rm -rf *)"` — 只拦截特定的 Bash 命令模式
- 路径模式匹配：`"Write(*.env)"` — 对特定路径的写操作要求确认

## 4.4 并发分区调度：partitionToolCalls 算法

当 LLM 在单轮响应中返回多个工具调用时，系统需要智能地决定哪些可以并行、哪些必须串行：

```typescript
// LLM 返回 4 个工具调用
const toolCalls = [
  { tool: 'Read',    input: { file_path: '/src/index.ts' } },
  { tool: 'Read',    input: { file_path: '/src/utils.ts' } },
  { tool: 'Write',   input: { file_path: '/src/index.ts' } },
  { tool: 'Grep',    input: { pattern: 'import.*utils' } },
];

// partitionToolCalls 算法输出
const partitions = [
  // 分区 1：所有只读操作可并行
  [
    { tool: 'Read',  input: { file_path: '/src/index.ts' } },
    { tool: 'Read',  input: { file_path: '/src/utils.ts' } },
    { tool: 'Grep',  input: { pattern: 'import.*utils' } },
  ],
  // 分区 2：写入操作串行，且在读取之后
  [
    { tool: 'Write', input: { file_path: '/src/index.ts' } },
  ],
];
```

### 分区规则

```
输入: toolCalls[]
    │
    ▼
[1] 标记每个调用的属性
    ├─ isReadOnly: true/false
    ├─ targetPaths: 涉及的文件路径集合
    └─ hasSideEffects: true/false
    │
    ▼
[2] 构建依赖图
    ├─ 写-写冲突：同一文件的两个写操作 → 串行
    ├─ 读-写冲突：先读后写同一文件 → 串行
    ├─ 读-读兼容：同一文件的两个读操作 → 可并行
    └─ 无依赖：不同文件的操作 → 可并行
    │
    ▼
[3] 拓扑排序 + 贪心分区
    ├─ 按依赖关系构建 DAG
    └─ 将无依赖的节点贪心归入同一批次
    │
    ▼
输出: partitions[][]  (区内并行，区间串行)
```

## 4.5 StreamingToolExecutor：边收边执行的状态机

`StreamingToolExecutor` 是工具执行管道的核心，它是一个**有限状态机**，在 LLM 流式输出的同时就开始处理已完成的工具调用：

```
状态转换图：

  IDLE ──(收到 tool_use 开始)──→ PARSING
                                    │
                              (参数 JSON 流式接收中)
                                    │
                              (JSON 完整接收)
                                    │
                                    ▼
                               VALIDATING
                                    │
                              (Schema + 语义验证)
                                    │
                           ┌────────┴────────┐
                           │                 │
                        验证通过           验证失败
                           │                 │
                           ▼                 ▼
                     PERMISSION_CHECK    REJECTED
                           │              (终态)
                    ┌──────┼──────┐
                    │      │      │
                  allow   deny   ask
                    │      │      │
                    ▼      ▼      ▼
               EXECUTING DENIED  WAITING_USER
                    │     (终态)    │
                    │            ┌──┴──┐
                    │          allow  deny
                    │            │      │
                    │            ▼      ▼
                    │       EXECUTING  DENIED
                    │            │     (终态)
                    ▼            │
              (执行完成) ◄───────┘
                    │
                    ▼
               COLLECTING
                    │
              (结果标准化)
                    │
                    ▼
                COMPLETED
                 (终态)
```

**关键优化**：传统实现会等 LLM 完整输出所有工具调用后再开始执行。`StreamingToolExecutor` 在收到第一个完整的 `tool_use` 块时就立即启动其执行管道，与 LLM 后续内容的流式输出并行。这意味着当 LLM 还在输出第三个工具调用时，第一个工具可能已经执行完毕。

```
时间线：

LLM 输出:  [===tool1===][=====tool2=====][==tool3==]
               │              │               │
执行管道:      ├─ 验证 ─┐     │               │
               │        ▼     │               │
               │   权限检查   │               │
               │        ▼     │               │
               │   执行工具1  ├─ 验证 ─┐      │
               │        ▼     │        ▼     │
               │   完成!      │   执行工具2   │
               │             │        ▼     │
               │             │   完成!      ├─ ...
               │             │             │
```

## 4.6 Transcript 作为唯一真相来源

所有工具调用的完整记录都写入 **Transcript**（对话记录），它是整个系统的**唯一真相来源**：

```typescript
interface TranscriptEntry {
  id: string;                   // 唯一标识
  timestamp: number;            // 时间戳
  type: 'tool_use' | 'tool_result';
  
  // 工具调用记录
  toolName: string;             // 工具名称
  toolInput: Record<string, any>; // 完整输入参数
  
  // 执行过程记录
  permissionDecision: 'allow' | 'deny' | 'ask';
  permissionReason?: string;    // 权限决策原因
  hookModifications?: any;      // Hook 对参数的修改
  
  // 结果记录
  result: ToolResult;           // 完整执行结果
  executionTime: number;        // 执行耗时（ms）
  error?: ErrorDetails;         // 错误详情（如有）
}
```

Transcript 的作用：
1. **对话恢复**：会话中断后可以从 Transcript 恢复完整状态
2. **上下文构建**：每轮 LLM 调用的 `messages` 数组直接从 Transcript 构建
3. **审计追踪**：所有工具调用的输入、权限决策、输出都有完整记录
4. **调试诊断**：出错时可以回溯完整的执行链路

## 4.7 工具结果回流模型的两面性

工具执行完成后，结果需要以**两种不同的格式**分别回流到 UI 和模型：

### UI 面（人类可读）

```
┌──────────────────────────────────────────────┐
│ 📄 Read /src/components/Button.tsx           │
│    156 lines read (lines 1-156)              │
│                                              │
│  1 │ import React from 'react';              │
│  2 │                                         │
│  3 │ interface ButtonProps {                 │
│  4 │   variant: 'primary' | 'secondary';     │
│  ...                                         │
└──────────────────────────────────────────────┘
```

- 带语法高亮的代码展示
- 文件元信息（行数、路径）
- 可折叠的详细内容

### 模型面（Token 优化）

```
<tool_result id="toolu_abc123">
  import React from 'react';
  
  interface ButtonProps {
    variant: 'primary' | 'secondary';
  ...
  [truncated: 120 lines omitted, use offset/limit to read specific ranges]
</tool_result>
```

- 纯文本，无装饰
- 智能截断（超长结果只保留关键部分）
- 保留 `tool_use_id` 关联，确保模型能匹配调用和结果
- 截断时提供指引（告知如何用 offset/limit 读取完整内容）

### 两面分离的必要性

```
同一份执行结果
    │
    ├─→ UI 面：完整、美观、可交互
    │   └─ 用户可以看到全部 1000 行代码
    │
    └─→ 模型面：精简、结构化、Token 友好
        └─ 只注入前 200 行 + 摘要，节省 Token 预算
```

如果不分离，要么为了 Token 效率牺牲用户体验（UI 也只展示截断内容），要么为了用户体验牺牲 Token 效率（模型接收完整 1000 行），两者都是不可接受的。

---

> **小结**：Claude Code 的 Tool Call 机制是一条精密的十步管道。`buildTool()` 的 fail-closed 策略确保安全底线，多阶段门控提供纵深防护，`partitionToolCalls` 算法优化并发效率，`StreamingToolExecutor` 状态机实现边收边执行，Transcript 作为唯一真相来源保障一致性，而结果回流的两面设计则在用户体验和 Token 效率之间取得了平衡。
