---
name: code-review
description: Review code for quality, bugs, and best practices
when_to_use: When the user asks to review code or check for bugs
allowed_tools:
  - FileRead
  - Bash
model: LongCat-2.0-Preview
effort: medium
user_invocable: true
---

# Code Review

You are performing a thorough code review. Analyze the code for:

1. **Bugs and logic errors** - off-by-one, null checks, race conditions
2. **Security issues** - injection, XSS, hardcoded secrets
3. **Performance** - unnecessary allocations, N+1 queries, missing caching
4. **Code quality** - naming, structure, DRY violations
5. **Best practices** - error handling, logging, documentation

Provide specific, actionable feedback with line references when possible.
