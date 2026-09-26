# Third-party notices

Ruah's own code is covered by the license in `LICENSE` (to be added). This file
lists code and assets from other projects that Ruah contains, with their
licenses. Dependencies installed by pnpm / bun (`package.json`,
`ui/package.json`) are not copied into this repository and carry their own
license files; the packaged app ships them under `Contents/Resources/app/node_modules`.
The bundled `dist/` and `viewer/` code loses the source files' header comments, so
the packaged app also ships this file as `Ruah.app/Contents/Resources/THIRD_PARTY_NOTICES.md`
(the build fails without it).

## T3 Code (MIT)

Portions of this software are derived from T3 Code
https://github.com/pingdotgg/t3code
Copyright (c) 2026 T3 Tools Inc.
Licensed under the MIT License, reproduced below.

Files adapted from T3 Code (commit eff44be43), each marked with a header
comment naming its source:

| ruah file | T3 Code source |
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
| `src/terminal/pty.ts` | `apps/server/src/terminal/NodePtyAdapter.ts`, `apps/server/src/terminal/PtyAdapter.ts` |
| `src/terminal/manager.ts` | `apps/server/src/terminal/Manager.ts` |
| `src/terminal/history.ts` | `apps/server/src/terminal/Manager.ts` (`BoundedTerminalHistory`, `sanitizeTerminalHistoryChunk`) |
| `src/terminal/env.ts` | `apps/server/src/terminal/Manager.ts` (`createTerminalSpawnEnv`, shell candidates) |
| `src/terminal/gateway.ts` | `apps/server/src/terminal/OutputProtocol.ts` (acknowledged output window) |

Viewer files whose code or visual patterns were adapted from T3 Code's web app
(also marked with a header comment):

| ruah file | T3 Code source |
| --- | --- |
| `ui/src/components/agent/AgentPanel.tsx` | `apps/web/src/components/ChatView.tsx`, `chat/MessagesTimeline.tsx` |
| `ui/src/components/agent/Composer.tsx` | `apps/web/src/components/chat/ComposerSurface.tsx`, `ComposerPrimaryActions.tsx` |
| `ui/src/components/agent/ComposerControls.tsx` | `apps/web/src/components/chat/ProviderModelPicker.tsx`, `ComposerControl.tsx`, `CompactComposerControlsMenu.tsx` |
| `ui/src/components/agent/Markdown.tsx` | `apps/web/src/components/ChatMarkdown.tsx` |
| `ui/src/components/agent/PermissionCard.tsx` | `apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx`, `ComposerPendingApprovalActions.tsx` |
| `ui/src/components/agent/ToolCallRow.tsx` | `apps/web/src/components/chat/MessagesTimeline.tsx` (`SimpleWorkEntryRow`) |
| `ui/src/components/agent/TurnView.tsx` | `apps/web/src/components/chat/MessagesTimeline.tsx` |
| `ui/src/components/map/MapPage.tsx` | `apps/web/src/components/chat/ChatHeader.tsx` (header and segmented control) |
| `ui/src/components/shell/SidebarSections.tsx` | `apps/web/src/components/Sidebar.tsx` |
| `ui/src/components/usage/UsagePage.tsx` | `apps/web/src/components/usage/UsagePage.tsx` |
| `ui/src/components/usage/UsageChart.tsx` | `apps/web/src/components/usage/UsageProviderChart.tsx` |
| `ui/src/components/usage/UsagePriceOverrides.tsx` | `apps/web/src/components/usage/UsagePriceOverrides.tsx`, `usagePriceTable.ts`, `usagePriceTargets.ts` |
| `ui/src/components/usage/usageAgents.ts` | `apps/web/src/components/usage/usageProviders.ts` |
| `ui/src/components/usage/usagePagePreferences.ts` | `apps/web/src/components/usage/usagePagePreferences.ts` |
| `ui/src/components/usage/usagePriceForm.ts` | `apps/web/src/components/usage/usagePriceForm.ts` |
| `ui/src/lib/usage.ts` | `packages/shared/src/usageFormat.ts` (formatting helpers) |
| `ui/src/styles.css` | `apps/web/src/components/chat/ComposerSurface.tsx` (composer surface styles) |

### MIT License (T3 Code)

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

## shadcn/ui (MIT)

`ui/src/components/ui/*` started as components generated with the shadcn/ui CLI
(`ui/components.json`, style "new-york") and were then edited for Ruah.
https://github.com/shadcn-ui/ui

    MIT License

    Copyright (c) 2023 shadcn

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

## The viewer's origin (Lovable)

The viewer in `ui/` began as a project generated with Lovable
(https://lovable.dev, TanStack Start template `tanstack_start_ts_current`;
`ui/.lovable/`) for the Ruah maintainers and has since been rewritten and
extended by hand. Code Lovable generates belongs to the user it was generated
for, so the viewer is Ruah's own work under Ruah's license. Its build configuration
depends on the MIT-licensed npm package `@lovable.dev/vite-tanstack-config`.
`ui/src/lib/lovable-error-reporting.ts` only reports errors when the viewer runs
inside Lovable's own preview; the desktop app and `ruah app serve` send nothing.

## Ruah brand assets

The Ruah name, logo, wordmark and the Phantom mascots
(`ui/src/components/brand/*`, `ui/public/icon.svg`, `ui/public/favicon.ico`,
`electron/assets/*`, `electron/build/dmg-background.*`) come from the Ruah
website by the same authors. They identify the project; see the README
("Name and logo") for how they may be used.

## Fonts (SIL Open Font License 1.1)

The viewer (`ui/public/fonts/`, copied to `viewer/fonts/`) bundles two fonts so the desktop
app renders the same offline. They were copied unmodified from the built ruah website
(`ruah-website/.next/static/media/`: Jura from Google Fonts via `next/font/google`, latin subset;
Geist Mono from the `geist` npm package) and renamed:

| file | font | copyright |
| --- | --- | --- |
| `jura-latin-variable.woff2` | Jura (latin, variable weight), used only for the "ruah" wordmark | Copyright 2010 The Jura Project Authors (https://github.com/ossobuffo/jura) |
| `geist-mono-variable.woff2` | Geist Mono (variable weight), used for code, paths, ids and tokens | Copyright (c) 2023 Vercel, in collaboration with basement.studio |

Both are licensed under the SIL Open Font License, Version 1.1: they may be bundled and
redistributed with software, but not sold by themselves. The license text follows.

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION AND CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
