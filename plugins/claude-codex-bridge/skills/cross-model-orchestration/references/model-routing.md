# 模型路由依据

## 结论

截至 2026-08-15，质量优先路由保持：

- Claude：`claude-opus-5` / `max`
- Codex：`gpt-5.6-sol` / `max`

文字、创意写作和长文任务不自动路由到 Opus 4.6。当前公开写作评测中，Opus 5 已高于
Opus 4.6；`claude-opus-4-6` / `max` 只保留为调用方明确选择的兼容项。

## 评测快照

不同评测的量纲不同，只能在同一列内比较，不能把 Elo、Rubric 分数和 Intelligence Index
横向相减。

| 评测 | Claude Opus 5 | GPT-5.6 Sol | Claude Opus 4.6 |
| --- | ---: | ---: | ---: |
| EQ-Bench Creative Writing v3 Elo | 2104.9 | 1959.1 | 1802.0 |
| Creative Writing v3 Rubric | 85.35 | 83.90 | 82.65 |
| EQ-Bench Longform | 86.3 | 81.7 | 77.7 |
| EQ-Bench 4 情绪与对话能力 Elo | 1385.0 | 1250.1 | 1222.8 |

Artificial Analysis Intelligence Index 的同日快照：

| 模型与档位 | Index |
| --- | ---: |
| Claude Opus 5 max | 63 |
| Claude Opus 5 xhigh | 63 |
| GPT-5.6 Sol max | 61 |
| GPT-5.6 Terra max | 57 |
| Claude Sonnet 5 max | 55 |
| GPT-5.6 Luna max | 52 |

这些分数支持“质量优先”默认值，但不能证明某个模型在每个私有任务上都最优。`balanced` 和
`high_volume` 是明确的速度/成本取舍，不声称其质量高于默认模型。

## 路由表

| `taskProfile` | Claude target | Codex target | 用途 |
| --- | --- | --- | --- |
| `quality` | Opus 5 / max | Sol / max | 默认质量优先 |
| `writing`、`creative_writing` | Opus 5 / max | Sol / max | 正式写作、创意写作、长文 |
| `coding`、`research`、`knowledge_work` | Opus 5 / max | Sol / max | 代码、研究、知识工作 |
| `balanced` | Sonnet 5 / high | Terra / max | 明确接受一定质量取舍以平衡速度/成本 |
| `high_volume` | Sonnet 5 / medium | Luna / max | 大批量、低风险、可独立复核的任务 |

显式 `model` 或 `reasoningEffort` 优先于 profile；未提供时才走 profile 或质量默认。路由只在
已经选定的 `target=claude|codex` 内选模型，不得把跨模型互审改成同源自审。

## 来源

- EQ-Bench Creative Writing v3: <https://eqbench.com/creative_writing.html>
- EQ-Bench Longform: <https://eqbench.com/creative_writing_longform.html>
- Artificial Analysis model leaderboard: <https://artificialanalysis.ai/leaderboards/models>
- Anthropic Claude Opus 5: <https://www.anthropic.com/news/claude-opus-5>
- Anthropic effort: <https://platform.claude.com/docs/en/build-with-claude/effort>
- OpenAI GPT-5.6 Sol: <https://developers.openai.com/api/docs/models/gpt-5.6-sol>
- OpenAI GPT-5.6 Terra: <https://developers.openai.com/api/docs/models/gpt-5.6-terra>
- OpenAI GPT-5.6 Luna: <https://developers.openai.com/api/docs/models/gpt-5.6-luna>

更新路由表前必须重新核对来源和本机运行时可用性。榜单只决定默认建议；实际选择仍须通过 bridge
白名单、目标端兼容性、CLI/SDK 接受情况和模型回执门。
