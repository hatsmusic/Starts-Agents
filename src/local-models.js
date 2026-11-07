// Curated local models (Ollama) — chosen for agent work, in honest
// tiers. Two different numbers, often confused:
//   diskGB — the download / model file size (what it costs on disk)
//   ramGB  — roughly how much RAM it occupies WHILE ANSWERING on a
//            CPU-only box (weights loaded + KV cache). This is the
//            number that decides whether the machine copes.
// The harness asks Ollama to unload a model after 5 idle minutes
// (see scripts/setup-local-model.sh), so the RAM comes back.
export const LOCAL_MODELS = [
  {
    tag: 'qwen2.5-coder:1.5b', name: 'Qwen2.5-Coder 1.5B', diskGB: 1.0, ramGB: 1.2,
    blurbZh: '演示档：能聊天、跑流程，真干活会犯傻', blurbEn: 'Demo tier: chats and demos the flow, fumbles real work',
  },
  {
    tag: 'qwen2.5-coder:3b', name: 'Qwen2.5-Coder 3B', diskGB: 1.9, ramGB: 2.2,
    blurbZh: '入门档：小任务能做，工具调用时好时坏', blurbEn: 'Starter tier: small tasks work, tool calls are hit-or-miss',
  },
  {
    tag: 'qwen2.5-coder:7b', name: 'Qwen2.5-Coder 7B', diskGB: 4.7, ramGB: 5.5,
    blurbZh: '能用起步：简单多步任务可以完成', blurbEn: 'Usable start: simple multi-step tasks get done',
  },
  {
    tag: 'qwen2.5-coder:14b', name: 'Qwen2.5-Coder 14B', diskGB: 9.0, ramGB: 10,
    blurbZh: '稳档：代码质量与工具调用都明显更靠谱', blurbEn: 'Solid tier: noticeably better code and tool use',
  },
  {
    tag: 'gpt-oss:20b', name: 'GPT-OSS 20B', diskGB: 14, ramGB: 15,
    blurbZh: 'OpenAI 的开源权重：推理与工具调用强，通用型', blurbEn: "OpenAI's open weights: strong reasoning and tool use, general-purpose",
  },
  {
    tag: 'devstral:24b', name: 'Devstral 24B', diskGB: 14, ramGB: 15,
    blurbZh: 'Mistral 专为 coding agent 调校的一款', blurbEn: "Mistral's model tuned specifically for coding agents",
  },
  {
    tag: 'qwen3.6:27b', name: 'Qwen 3.6 27B', diskGB: 17, ramGB: 18,
    blurbZh: '强档：综合代码能力出色，工具调用可靠', blurbEn: 'Strong tier: excellent all-round coder, reliable tool calls',
  },
  {
    tag: 'qwen3-coder:30b', name: 'Qwen3-Coder 30B', diskGB: 19, ramGB: 20,
    blurbZh: '本地代码 Agent 首选：仓库级理解 + 可靠工具调用', blurbEn: 'The local coding-agent pick: repo-level understanding, reliable tool calls',
  },
];

export function getLocalModel(tag) {
  return LOCAL_MODELS.find((m) => m.tag === tag) || null;
}
