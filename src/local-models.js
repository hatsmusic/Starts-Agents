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
    tag: 'devstral-small-2:24b', cat: 'code', name: 'Devstral Small 2 24B', diskGB: 15.2, ramGB: 16.5,
    blurbZh: 'Devstral 二代小杯：为代码 Agent 优化，体积比一代大杯小得多', blurbEn: 'Devstral 2\'s smaller build: tuned for coding agents, far lighter than the 123B',
  },
  {
    tag: 'qwen3-coder:30b', cat: 'code', name: 'Qwen3-Coder 30B', diskGB: 19, ramGB: 20,
    blurbZh: '本地代码 Agent 首选：仓库级理解 + 可靠工具调用', blurbEn: 'The local coding-agent pick: repo-level understanding, reliable tool calls',
  },
  {
    tag: 'qwen3-coder:480b', cat: 'code', name: 'Qwen3-Coder 480B (MoE)', diskGB: 290, ramGB: 300,
    blurbZh: '旗舰 MoE：给工作站/服务器集群准备的，家用机别碰', blurbEn: 'Flagship MoE: for workstations / server clusters — not for home boxes',
  },
  {
    tag: 'qwen2.5-coder:0.5b', cat: 'code', name: 'Qwen2.5-Coder 0.5B', diskGB: 0.4, ramGB: 0.8,
    blurbZh: '最小代码模型：补全、改小片段，玩具档', blurbEn: 'Smallest coder: completions and tiny edits, toy tier',
  },
  {
    tag: 'starcoder2:3b', cat: 'code', name: 'StarCoder2 3B', diskGB: 1.7, ramGB: 2.1,
    blurbZh: 'BigCode 开源代码模型：轻量补全', blurbEn: 'BigCode\'s open coder: light completions',
  },
  {
    tag: 'codellama:7b', cat: 'code', name: 'CodeLlama 7B', diskGB: 3.8, ramGB: 4.6,
    blurbZh: 'Meta 经典代码模型：老牌补全手', blurbEn: 'Meta\'s classic coder: a veteran completion hand',
  },
  {
    tag: 'deepseek-coder:6.7b', cat: 'code', name: 'DeepSeek-Coder 6.7B', diskGB: 3.8, ramGB: 4.6,
    blurbZh: '初代 DeepSeek 代码：小而能打', blurbEn: 'Original DeepSeek coder: small and capable',
  },
  {
    tag: 'starcoder2:7b', cat: 'code', name: 'StarCoder2 7B', diskGB: 4, ramGB: 4.8,
    blurbZh: 'StarCoder2 中杯：多语言代码补全', blurbEn: 'StarCoder2 mid: multilingual code completion',
  },
  {
    tag: 'granite-code:8b', cat: 'code', name: 'Granite Code 8B', diskGB: 4.6, ramGB: 5.5,
    blurbZh: 'IBM 开源代码模型：企业风，稳重', blurbEn: 'IBM\'s open coder: enterprise-flavoured, steady',
  },
  {
    tag: 'codegemma:7b', cat: 'code', name: 'CodeGemma 7B', diskGB: 5, ramGB: 6,
    blurbZh: 'Google 的代码版 Gemma', blurbEn: 'Google\'s coding Gemma',
  },
  {
    tag: 'codellama:13b', cat: 'code', name: 'CodeLlama 13B', diskGB: 7.4, ramGB: 8.7,
    blurbZh: 'CodeLlama 大杯：理解力更好', blurbEn: 'CodeLlama large: better comprehension',
  },
  {
    tag: 'deepseek-coder-v2:16b', cat: 'code', name: 'DeepSeek-Coder-V2 16B', diskGB: 8.9, ramGB: 10.4,
    blurbZh: 'MoE 代码模型：轻身板、强代码', blurbEn: 'MoE coder: light body, strong code',
  },
  {
    tag: 'starcoder2:15b', cat: 'code', name: 'StarCoder2 15B', diskGB: 9.1, ramGB: 10.7,
    blurbZh: 'StarCoder2 大杯：仓库级补全更稳', blurbEn: 'StarCoder2 large: steadier repo-level completion',
  },
  {
    tag: 'devstral-2:123b', cat: 'code', name: 'Devstral 2 123B', diskGB: 74.9, ramGB: 82,
    blurbZh: 'Mistral 代码旗舰：SWE 级修仓能力，给大机器', blurbEn: 'Mistral\'s coding flagship: SWE-grade repo work, big machines',
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
    tag: 'qwen3.5:4b', cat: 'general', name: 'Qwen3.5 4B', diskGB: 3.3, ramGB: 4,
    blurbZh: '通义 3.5 小杯：新代轻量通用', blurbEn: 'Qwen3.5 small: new-gen light generalist',
  },
  {
    tag: 'qwen3.5:9b', cat: 'general', name: 'Qwen3.5 9B', diskGB: 6.6, ramGB: 7.6,
    blurbZh: '通义 3.5 中杯：均衡，中文强', blurbEn: 'Qwen3.5 mid: balanced, strong Chinese',
  },
  {
    tag: 'qwen3.5:27b', cat: 'general', name: 'Qwen3.5 27B', diskGB: 17.5, ramGB: 19.5,
    blurbZh: '通义 3.5 强档：通用+代码都硬', blurbEn: 'Qwen3.5 strong tier: general and code both solid',
  },
  {
    tag: 'qwen3.5:35b', cat: 'general', name: 'Qwen3.5 35B (MoE)', diskGB: 22.1, ramGB: 24,
    blurbZh: '通义 3.5 MoE：35B 总参，速度快过同体量稠密款', blurbEn: 'Qwen3.5 MoE: 35B total, faster than dense models its size',
  },
  {
    tag: 'qwen3.5:122b', cat: 'general', name: 'Qwen3.5 122B (MoE)', diskGB: 81.4, ramGB: 89,
    blurbZh: '通义 3.5 旗舰 MoE：给大内存机器', blurbEn: 'Qwen3.5 flagship MoE: big-RAM machines',
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
  {
    tag: 'qwen3:0.6b', cat: 'general', name: 'Qwen3 0.6B', diskGB: 0.5, ramGB: 0.9,
    blurbZh: '通义最小杯：跑流程、占位演示', blurbEn: 'Qwen\'s tiniest: flow demos and placeholders',
  },
  {
    tag: 'gemma3:1b', cat: 'general', name: 'Gemma 3 1B', diskGB: 0.8, ramGB: 1.2,
    blurbZh: 'Google 最小杯：极轻通用', blurbEn: 'Google\'s tiniest generalist',
  },
  {
    tag: 'llama3.2:1b', cat: 'general', name: 'Llama 3.2 1B', diskGB: 1.3, ramGB: 1.7,
    blurbZh: 'Meta 最小杯：极轻，聊天小助手', blurbEn: 'Meta\'s tiniest: featherweight chat helper',
  },
  {
    tag: 'qwen3:1.7b', cat: 'general', name: 'Qwen3 1.7B', diskGB: 1.4, ramGB: 1.8,
    blurbZh: '通义小杯：轻任务中文顺手', blurbEn: 'Qwen small: handy for light Chinese tasks',
  },
  {
    tag: 'smollm2:1.7b', cat: 'general', name: 'SmolLM2 1.7B', diskGB: 1.8, ramGB: 2.2,
    blurbZh: 'HuggingFace 极轻量：边缘设备档', blurbEn: 'HuggingFace\'s featherweight: edge-device tier',
  },
  {
    tag: 'qwen2.5:3b', cat: 'general', name: 'Qwen2.5 3B', diskGB: 1.9, ramGB: 2.3,
    blurbZh: '上代通义小杯：稳、省', blurbEn: 'Previous-gen Qwen small: steady and lean',
  },
  {
    tag: 'phi3.5:3.8b', cat: 'general', name: 'Phi-3.5 Mini', diskGB: 2.2, ramGB: 2.7,
    blurbZh: '微软小钢炮：小体积，推理不错', blurbEn: 'Microsoft\'s pocket rocket: small, reasons well',
  },
  {
    tag: 'qwen3:4b', cat: 'general', name: 'Qwen3 4B', diskGB: 2.5, ramGB: 3.1,
    blurbZh: '通义 4B：轻量均衡档', blurbEn: 'Qwen 4B: light balanced tier',
  },
  {
    tag: 'gemma3:4b', cat: 'general', name: 'Gemma 3 4B', diskGB: 3.4, ramGB: 4.1,
    blurbZh: 'Gemma 小杯：能看图，多语言好', blurbEn: 'Gemma small: sees images, great multilingual',
  },
  {
    tag: 'mistral:7b', cat: 'general', name: 'Mistral 7B', diskGB: 4.4, ramGB: 5.3,
    blurbZh: 'Mistral 经典 7B：快而均衡', blurbEn: 'Mistral\'s classic 7B: fast and balanced',
  },
  {
    tag: 'qwen2.5:7b', cat: 'general', name: 'Qwen2.5 7B', diskGB: 4.7, ramGB: 5.6,
    blurbZh: '上代通义 7B：老牌均衡手', blurbEn: 'Previous-gen Qwen 7B: veteran all-rounder',
  },
  {
    tag: 'gemma2:9b', cat: 'general', name: 'Gemma 2 9B', diskGB: 5.4, ramGB: 6.4,
    blurbZh: '上代 Gemma 中杯：文笔好', blurbEn: 'Previous-gen Gemma mid: good writer',
  },
  {
    tag: 'qwen2.5:14b', cat: 'general', name: 'Qwen2.5 14B', diskGB: 9, ramGB: 10.5,
    blurbZh: '上代通义 14B：通用稳档', blurbEn: 'Previous-gen Qwen 14B: solid generalist',
  },
  {
    tag: 'gemma2:27b', cat: 'general', name: 'Gemma 2 27B', diskGB: 15.6, ramGB: 18.1,
    blurbZh: '上代 Gemma 大杯：长文稳', blurbEn: 'Previous-gen Gemma large: steady long-form',
  },
  {
    tag: 'gemma3:27b', cat: 'general', name: 'Gemma 3 27B', diskGB: 17.4, ramGB: 20.2,
    blurbZh: 'Gemma 大杯：通用稳档，能看图', blurbEn: 'Gemma large: solid generalist, sees images',
  },
  {
    tag: 'gemma4:e2b', cat: 'general', name: 'Gemma 4 E2B', diskGB: 4.6, ramGB: 5.4,
    blurbZh: 'Google 新代端侧款：小身材多模态（含视觉塔所以体积偏大）', blurbEn: 'Google\'s new edge model: multimodal in a small body (vision tower included, hence the size)',
  },
  {
    tag: 'gemma4:e4b', cat: 'general', name: 'Gemma 4 E4B', diskGB: 6.6, ramGB: 7.6,
    blurbZh: 'Gemma 4 端侧大杯：多模态，轻量档里的全能手', blurbEn: 'Gemma 4 edge large: multimodal all-rounder in the light tier',
  },
  {
    tag: 'gemma4:12b', cat: 'general', name: 'Gemma 4 12B', diskGB: 8.0, ramGB: 9.4,
    blurbZh: 'Gemma 4 中杯：多语言与看图都强', blurbEn: 'Gemma 4 mid: strong multilingual and vision',
  },
  {
    tag: 'gemma4:26b', cat: 'general', name: 'Gemma 4 26B (MoE)', diskGB: 18.7, ramGB: 21,
    blurbZh: 'Gemma 4 MoE：大杯身手、MoE 速度', blurbEn: 'Gemma 4 MoE: large-model quality at MoE speed',
  },
  {
    tag: 'gemma4:31b', cat: 'general', name: 'Gemma 4 31B', diskGB: 20.4, ramGB: 23,
    blurbZh: 'Gemma 4 旗舰稠密款：通用稳档之选', blurbEn: 'Gemma 4 flagship dense: the solid generalist pick',
  },
  {
    tag: 'nemotron-3-nano:4b', cat: 'general', name: 'Nemotron 3 Nano 4B', diskGB: 2.8, ramGB: 3.4,
    blurbZh: 'NVIDIA 新代小杯：为 Agent 场景调校', blurbEn: 'NVIDIA\'s new small model: tuned for agentic work',
  },
  {
    tag: 'nemotron-3-nano:30b', cat: 'general', name: 'Nemotron 3 Nano 30B', diskGB: 24.3, ramGB: 26.5,
    blurbZh: 'Nemotron 3 大杯：混合推理，Agent 向', blurbEn: 'Nemotron 3 large: hybrid reasoning, agent-oriented',
  },
  {
    tag: 'qwen2.5:32b', cat: 'general', name: 'Qwen2.5 32B', diskGB: 19.9, ramGB: 23.1,
    blurbZh: '上代通义 32B：本地强档', blurbEn: 'Previous-gen Qwen 32B: strong local tier',
  },
  {
    tag: 'llama3.3:70b', cat: 'general', name: 'Llama 3.3 70B', diskGB: 42.5, ramGB: 47,
    blurbZh: 'Meta 旗舰开源：通用强档，吃内存', blurbEn: 'Meta\'s flagship open model: strong, eats RAM',
  },
  {
    tag: 'qwen2.5:72b', cat: 'general', name: 'Qwen2.5 72B', diskGB: 47.4, ramGB: 52,
    blurbZh: '上代通义旗舰：给大内存机器', blurbEn: 'Previous-gen Qwen flagship: big-RAM machines',
  },
  {
    tag: 'llama4:16x17b', cat: 'general', name: 'Llama 4 Scout', diskGB: 67.4, ramGB: 74,
    blurbZh: 'Meta 新代 MoE：长上下文、多模态，给大机器', blurbEn: 'Meta\'s new MoE: long context, multimodal, big machines only',
  },
  {
    tag: 'mistral-large:123b', cat: 'general', name: 'Mistral Large 123B', diskGB: 73.2, ramGB: 81,
    blurbZh: 'Mistral 旗舰：给服务器准备的', blurbEn: 'Mistral\'s flagship: server-class',
  },
  {
    tag: 'deepseek-v3.1:671b', cat: 'general', name: 'DeepSeek-V3.1 671B', diskGB: 404.5, ramGB: 440,
    blurbZh: '满血 DeepSeek：本地部署的云端级体验，集群档', blurbEn: 'Full-size DeepSeek: cloud-grade, run locally — cluster tier',
  },
  {
    tag: 'qwen3:235b-a22b', cat: 'general', name: 'Qwen3 235B (MoE)', diskGB: 142.2, ramGB: 155,
    blurbZh: '通义旗舰 MoE：通用+代码全能，大内存档', blurbEn: 'Qwen\'s flagship MoE: everything-strong, big-RAM tier',
  },
  {
    tag: 'qwen3-next:80b', cat: 'general', name: 'Qwen3-Next 80B', diskGB: 50.4, ramGB: 55,
    blurbZh: '通义次世代：长上下文 + 高速推理', blurbEn: 'Qwen next-gen: long context, fast inference',
  },
  {
    tag: 'llama3.1:405b', cat: 'general', name: 'Llama 3.1 405B', diskGB: 243.1, ramGB: 265,
    blurbZh: 'Meta 上代旗舰：开源权重标杆，集群档', blurbEn: 'Meta\'s former flagship: the open-weights benchmark, cluster tier',
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
  {
    tag: 'deepseek-r1:1.5b', cat: 'reasoning', name: 'DeepSeek-R1 1.5B', diskGB: 1.1, ramGB: 1.5,
    blurbZh: 'R1 蒸馏最小杯：推理入门体验', blurbEn: 'R1 distilled tiniest: a taste of reasoning',
  },
  {
    tag: 'deepseek-r1:8b', cat: 'reasoning', name: 'DeepSeek-R1 8B', diskGB: 5.2, ramGB: 6.2,
    blurbZh: 'R1 蒸馏 8B：小杯推理，性价比档', blurbEn: 'R1 distilled 8B: small reasoner, value pick',
  },
  {
    tag: 'qwq:32b', cat: 'reasoning', name: 'QwQ 32B', diskGB: 19.9, ramGB: 23.1,
    blurbZh: '通义推理专长：长思维链，慢工出细活', blurbEn: 'Qwen\'s reasoning specialist: long chains, slow and thorough',
  },
  {
    tag: 'deepseek-r1:70b', cat: 'reasoning', name: 'DeepSeek-R1 70B', diskGB: 42.5, ramGB: 47,
    blurbZh: 'R1 蒸馏大杯：本地推理旗舰档', blurbEn: 'R1 distilled large: local reasoning flagship tier',
  },
  {
    tag: 'deepseek-r1:671b', cat: 'reasoning', name: 'DeepSeek-R1 671B', diskGB: 404.4, ramGB: 440,
    blurbZh: '满血 R1：本地最强推理，集群档', blurbEn: 'Full-size R1: the strongest local reasoner, cluster tier',
  },
  {
    tag: 'cogito-2.1:671b', cat: 'reasoning', name: 'Cogito 2.1 671B', diskGB: 1342.3, ramGB: 1400,
    blurbZh: 'DeepCogito 满血推理：1.3TB 全精度，纯集群玩具', blurbEn: 'DeepCogito full-size reasoner: 1.3TB full precision, cluster toy',
  },
  {
    tag: 'magistral:24b', cat: 'reasoning', name: 'Magistral 24B', diskGB: 14.3, ramGB: 16,
    blurbZh: 'Mistral 推理专长：链式思考稳', blurbEn: 'Mistral\'s reasoning specialist: steady chain-of-thought',
  },
  {
    tag: 'phi4-reasoning:14b', cat: 'reasoning', name: 'Phi-4 Reasoning 14B', diskGB: 11.1, ramGB: 12.5,
    blurbZh: '微软推理版 Phi-4：数学与逻辑专长', blurbEn: 'Microsoft\'s reasoning Phi-4: math and logic specialist',
  },
  {
    tag: 'nemotron-3-super:120b', cat: 'reasoning', name: 'Nemotron 3 Super 120B', diskGB: 86.8, ramGB: 95,
    blurbZh: 'NVIDIA 旗舰：为多 Agent 协作与推理调校，给大机器', blurbEn: 'NVIDIA\'s flagship: tuned for multi-agent work and reasoning, big machines',
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
  {
    tag: 'moondream:1.8b', cat: 'vision', name: 'Moondream 1.8B', diskGB: 1.7, ramGB: 2.1,
    blurbZh: '极轻视觉：看图描述飞快', blurbEn: 'Featherweight vision: fast image description',
  },
  {
    tag: 'qwen2.5vl:3b', cat: 'vision', name: 'Qwen2.5-VL 3B', diskGB: 3.2, ramGB: 3.9,
    blurbZh: '通义视觉小杯：截图/文档入门档', blurbEn: 'Qwen vision small: screenshots and documents, starter tier',
  },
  {
    tag: 'llava:7b', cat: 'vision', name: 'LLaVA 7B', diskGB: 4.7, ramGB: 5.6,
    blurbZh: '经典视觉小杯：看图聊天', blurbEn: 'Classic vision small: image chat',
  },
  {
    tag: 'llava-llama3:8b', cat: 'vision', name: 'LLaVA-Llama3 8B', diskGB: 5.5, ramGB: 6.5,
    blurbZh: 'LLaVA 的 Llama3 版：看图更聪明', blurbEn: 'LLaVA on Llama 3: smarter image chat',
  },
  {
    tag: 'minicpm-v:8b', cat: 'vision', name: 'MiniCPM-V 8B', diskGB: 5.5, ramGB: 6.5,
    blurbZh: '面壁开源视觉：小体积，OCR 能打', blurbEn: 'OpenBMB\'s vision model: small, strong OCR',
  },
  {
    tag: 'llama3.2-vision:11b', cat: 'vision', name: 'Llama 3.2 Vision 11B', diskGB: 7.8, ramGB: 9.2,
    blurbZh: 'Meta 视觉款：看图 + 通用兼顾', blurbEn: 'Meta\'s vision model: images plus general chat',
  },
  {
    tag: 'llama3.2-vision:90b', cat: 'vision', name: 'Llama 3.2 Vision 90B', diskGB: 54.6, ramGB: 60,
    blurbZh: 'Meta 视觉大杯：给大机器', blurbEn: 'Meta\'s big vision model: big machines',
  },
  {
    tag: 'qwen3-vl:2b', cat: 'vision', name: 'Qwen3-VL 2B', diskGB: 1.9, ramGB: 2.4,
    blurbZh: '通义新代视觉小杯：截图/文档入门', blurbEn: 'New-gen Qwen vision small: screenshots and documents, starter tier',
  },
  {
    tag: 'qwen3-vl:4b', cat: 'vision', name: 'Qwen3-VL 4B', diskGB: 3.3, ramGB: 4.1,
    blurbZh: '通义新代视觉中杯：OCR 与界面理解更强', blurbEn: 'New-gen Qwen vision mid: stronger OCR and UI understanding',
  },
  {
    tag: 'qwen3-vl:8b', cat: 'vision', name: 'Qwen3-VL 8B', diskGB: 6.2, ramGB: 7.3,
    blurbZh: '通义新代视觉主力：看图干活的均衡档', blurbEn: 'New-gen Qwen vision workhorse: the balanced pick for image work',
  },
  {
    tag: 'qwen3-vl:32b', cat: 'vision', name: 'Qwen3-VL 32B', diskGB: 20.9, ramGB: 23,
    blurbZh: '通义新代视觉强档：细粒度识别与文档理解', blurbEn: 'New-gen Qwen vision strong tier: fine-grained recognition and documents',
  },
  {
    tag: 'qwen3-vl:235b', cat: 'vision', name: 'Qwen3-VL 235B (MoE)', diskGB: 143.3, ramGB: 156,
    blurbZh: '通义视觉旗舰 MoE：给大内存机器', blurbEn: 'Qwen vision flagship MoE: big-RAM machines',
  },
  {
    tag: 'deepseek-ocr:3b', cat: 'vision', name: 'DeepSeek-OCR 3B', diskGB: 6.7, ramGB: 7.8,
    blurbZh: 'DeepSeek 的 OCR 专长：文档转文字、版面解析（体积含视觉塔）', blurbEn: 'DeepSeek\'s OCR specialist: documents to text, layout parsing (size includes the vision tower)',
  },
];

export function getLocalModel(tag) {
  return LOCAL_MODELS.find((m) => m.tag === tag) || null;
}
