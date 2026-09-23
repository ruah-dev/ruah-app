# Third-party notices

Portions of this software are derived from T3 Code
https://github.com/pingdotgg/t3code
Copyright (c) 2026 T3 Tools Inc.
Licensed under the MIT License, reproduced below.

Files adapted from T3 Code (commit eff44be43), each marked with a header
comment naming its source:

| archmap file | T3 Code source |
| --- | --- |
| `src/acp/claude-sdk-bridge.ts` | `apps/server/src/provider/Layers/ClaudeAdapter.ts` |
| `src/acp/claude-executable.ts` | `apps/server/src/provider/Drivers/ClaudeExecutable.ts` |
| `src/acp/claude-home.ts` | `apps/server/src/provider/Drivers/ClaudeHome.ts` |
| `src/acp/claude-skill-dispatch.ts` | `apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts` |
| `src/acp/acp-bridge.ts` | `apps/server/src/provider/acp/AcpSessionRuntime.ts`, `apps/server/src/provider/Layers/CursorAdapter.ts`, `apps/server/src/provider/acp/AcpAdapterSupport.ts` |
| `src/acp/acp-normalize.ts` | `apps/server/src/provider/acp/AcpRuntimeModel.ts` |
| `src/acp/acp-process.ts` | `apps/server/src/provider/acp/AcpSessionRuntime.ts` |
| `src/acp/presets.ts` | `apps/server/src/provider/acp/CursorAcpSupport.ts`, `apps/server/src/provider/acp/GrokAcpSupport.ts` |
| `src/usage/claude-limits.ts` | `apps/server/src/provider/Layers/claudeUsageLimits.ts`, `apps/server/src/provider/providerUsageLimits.ts` |
| `src/usage/claude-probe.ts` | `apps/server/src/provider/Layers/ClaudeProvider.ts` (capabilities probe) |

## MIT License (T3 Code)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
