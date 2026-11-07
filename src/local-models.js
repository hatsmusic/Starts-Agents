// Curated local models (Ollama) — chosen for agent work, in honest
// tiers. Two different numbers, often confused:
//   diskGB — the download / model file size (what it costs on disk)
//   ramGB  — roughly how much RAM it occupies WHILE ANSWERING on a
//            CPU-only box (weights loaded + KV cache). This number
//            decides whether the machine copes.
// The harness asks Ollama to unload a model after 5 idle minutes
// (see scripts/setup-local-model.sh), so the RAM comes back.
// `cat` groups the picker: code | general | reasoning | vision.
// The catalog is deliberately generous (v0.7): the operator may run
// tiny models on this small box, but the app is also handed to other
// people with bigger machines — the full ladder is there for them.
export const LOCAL_MODELS = [
  /* ---- code ---- */
  {
    tag: 'qwen2.5-coder:1.5b', cat: 'code', name: 'Qwen2.5-Coder 1.5B', diskGB: 1.0, ramGB: 1.2,
    blurbZh: '演示档：能聊天、跑流程，真干活会犯傻', blurbEn: 'Demo tier: chats and demos the flow, fumbles real work',
  },
  {
    tag: 'qwen2.5-coder:3b', cat: 'code', name: 'Qwen2.5-Coder 3B', diskGB: 1.9, ramGB: 2.2,
    blurbZh: '入门档：小任务能做，工具调用时好时坏', blurbEn: 'Starter tier: small tasks work, tool calls are hit-or-miss',
  },
  {
    tag: 'qwen2.5-coder:7b', cat: 'code', name: 'Qwen2.5-Coder 7B', diskGB: 4.7, ramGB: 5.5,
    blurbZh: '能用起步：简单多步任务可以完成', blurbEn: 'Usable start: simple multi-step tasks get done',
  },
  {
    tag: 'qwen2.5-coder:14b', cat: 'code', name: 'Qwen2.5-Coder 14B', diskGB: 9.0, ramGB: 10,
    blurbZh: '稳档：代码质量与工具调用都明显更靠谱', blurbEn: 'Solid tier: noticeably better code and tool use',
  },
  {
    tag: 'qwen2.5-coder:32b', cat: 'code', name: 'Qwen2.5-Coder 32B', diskGB: 19, ramGB: 21,
    blurbZh: '上代旗舰代码模型：慢，但代码品味好', blurbEn: "Last gen's flagship coder: slow, but with good code taste",
  },
  {
    tag: 'devstral:24b', cat: 'code', name: 'Devstral 24B', diskGB: 14, ramGB: 15,
    blurbZh: 'Mistral 专为 coding agent 调校的一款', blurbEn: "Mistral's model tuned specifically for coding agents",
  },
  {
    tag: 'qwen3-coder:30b', cat: 'code', name: 'Qwen3-Coder 30B', diskGB: 19, ramGB: 20,
    blurbZh: '本地代码 Agent 首选：仓库级理解 + 可靠工具调用', blurbEn: 'The local coding-agent pick: repo-level understanding, reliable tool calls',
  },
  {
    tag: 'qwen3-coder:480b', cat: 'code', name: 'Qwen3-Coder 480B (MoE)', diskGB: 290, ramGB: 300,
    blurbZh: '旗舰 MoE：给工作站/服务器集群准备的，家用机别碰', blurbEn: 'Flagship MoE: for workstations / server clusters — not for home boxes',
  },
  /* ---- general ---- */
  {
    tag: 'llama3.2:3b', cat: 'general', name: 'Llama 3.2 3B', diskGB: 2.0, ramGB: 2.4,
    blurbZh: 'Meta 小杯：聊天、摘要、轻任务', blurbEn: "Meta's small one: chat, summaries, light tasks",
  },
  {
    tag: 'llama3.1:8b', cat: 'general', name: 'Llama 3.1 8B', diskGB: 4.7, ramGB: 5.5,
    blurbZh: 'Meta 中杯：通用均衡，英文最强', blurbEn: "Meta's mid-size: balanced generalist, strongest in English",
  },
  {
    tag: 'qwen3:8b', cat: 'general', name: 'Qwen3 8B', diskGB: 5.2, ramGB: 6,
    blurbZh: '通义新代 8B：中文好，带思维链开关', blurbEn: 'New-gen Qwen 8B: strong Chinese, switchable thinking',
  },
  {
    tag: 'qwen3:14b', cat: 'general', name: 'Qwen3 14B', diskGB: 9.3, ramGB: 10.5,
    blurbZh: '通义 14B：通用稳档，工具调用可靠', blurbEn: 'Qwen3 14B: solid generalist, reliable tool calls',
  },
  {
    tag: 'qwen3:32b', cat: 'general', name: 'Qwen3 32B', diskGB: 19, ramGB: 21,
    blurbZh: '通义 32B：本地通用强档', blurbEn: 'Qwen3 32B: the strong local generalist',
  },
  {
    tag: 'qwen3.6:27b', cat: 'general', name: 'Qwen 3.6 27B', diskGB: 17, ramGB: 18,
    blurbZh: '强档：综合代码能力出色，工具调用可靠', blurbEn: 'Strong tier: excellent all-round coder, reliable tool calls',
  },
  {
    tag: 'gpt-oss:20b', cat: 'general', name: 'GPT-OSS 20B', diskGB: 14, ramGB: 15,
    blurbZh: 'OpenAI 的开源权重：推理与工具调用强，通用型', blurbEn: "OpenAI's open weights: strong reasoning and tool use, general-purpose",
  },
  {
    tag: 'gpt-oss:120b', cat: 'general', name: 'GPT-OSS 120B', diskGB: 65, ramGB: 70,
    blurbZh: 'OpenAI 开源大杯：给大内存机器准备', blurbEn: "OpenAI's big open weights: for machines with serious RAM",
  },
  {
    tag: 'phi4:14b', cat: 'general', name: 'Phi-4 14B', diskGB: 9.1, ramGB: 10,
    blurbZh: '微软出品：小身材，推理与数学见长', blurbEn: "Microsoft's Phi-4: small body, strong reasoning and math",
  },
  {
    tag: 'gemma3:12b', cat: 'general', name: 'Gemma 3 12B', diskGB: 8.1, ramGB: 9.5,
    blurbZh: 'Google 开源：多语言好，还能看图', blurbEn: "Google's open model: great multilingual, can also see images",
  },
  {
    tag: 'mistral-small:24b', cat: 'general', name: 'Mistral Small 24B', diskGB: 14, ramGB: 15.5,
    blurbZh: 'Mistral 通用主力：均衡、低调', blurbEn: "Mistral's general workhorse: balanced and understated",
  },
  /* ---- reasoning ---- */
  {
    tag: 'deepseek-r1:7b', cat: 'reasoning', name: 'DeepSeek-R1 7B', diskGB: 4.7, ramGB: 5.5,
    blurbZh: 'R1 蒸馏小杯：会打草稿的推理模型', blurbEn: 'R1 distilled, small: a reasoning model that shows its work',
  },
  {
    tag: 'deepseek-r1:14b', cat: 'reasoning', name: 'DeepSeek-R1 14B', diskGB: 9.0, ramGB: 10,
    blurbZh: 'R1 蒸馏中杯：数学/逻辑明显更强', blurbEn: 'R1 distilled, mid: clearly stronger math and logic',
  },
  {
    tag: 'deepseek-r1:32b', cat: 'reasoning', name: 'DeepSeek-R1 32B', diskGB: 19, ramGB: 21,
    blurbZh: 'R1 蒸馏大杯：本地推理强档，就是慢', blurbEn: 'R1 distilled, large: strong local reasoning, just slow',
  },
  /* ---- vision ---- */
  {
    tag: 'qwen2.5vl:7b', cat: 'vision', name: 'Qwen2.5-VL 7B', diskGB: 6.0, ramGB: 7,
    blurbZh: '能看图：截图、照片、文档图都能读', blurbEn: 'Can see: reads screenshots, photos and document images',
  },
  {
    tag: 'qwen2.5vl:32b', cat: 'vision', name: 'Qwen2.5-VL 32B', diskGB: 21, ramGB: 23,
    blurbZh: '看图强档：细粒度识别与文档理解', blurbEn: 'Strong vision: fine-grained recognition and document understanding',
  },
  {
    tag: 'llava:13b', cat: 'vision', name: 'LLaVA 13B', diskGB: 8.0, ramGB: 9,
    blurbZh: '经典视觉模型：看图聊天、描述图片', blurbEn: 'The classic vision model: image chat and description',
  },
];

export function getLocalModel(tag) {
  return LOCAL_MODELS.find((m) => m.tag === tag) || null;
}
