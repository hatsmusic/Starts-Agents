// Curated local models — chosen for agent work, in honest tiers.
// Two different numbers, often confused:
//   diskGB — the download / model file size (what it costs on disk)
//   ramGB  — roughly how much RAM it occupies WHILE ANSWERING on a
//            CPU-only box (weights loaded + KV cache). This number
//            decides whether the machine copes.
// The harness asks Ollama to unload a model after 5 idle minutes,
// so the RAM comes back; scripts/setup-local-model.sh installs
// Ollama, makes sure the service answers, pulls the default model
// (qwen2.5-coder:1.5b) and prints the OLLAMA_KEEP_ALIVE knob that
// controls that unload window.
// `tools: false` marks model FAMILIES publicly known not to support
// tool calling (codegemma, codellama, starcoder/2, first-gen
// deepseek-coder, gemma/gemma2, llama2). It is a picker/display
// hint ONLY: runtime decisions always use Ollama's measured
// /api/show capabilities, never this mark. Entries without the
// field are "unknown", not "supported".
// `cat` groups the picker: code | general | reasoning | vision | embed.
// `src` says where the pull actually comes from — never blurred:
//   ollama    — the official Ollama library (registry.ollama.ai/library)
//   hf        — a Hugging Face GGUF repo pulled via Ollama's hf.co/ path
//               (community quantisers such as unsloth / bartowski, or
//               the author's own GGUF repo); the author is credited in
//               the blurb, and these are NOT official Ollama builds.
//   community — a community namespace on the Ollama registry itself
//               (e.g. huihui_ai/, mannix/, jeffh/): third-party builds,
//               marked （社区） in the name.
//   github    — an open-source project published on GitHub, pulled via
//               its Hugging Face GGUF distribution; `srcUrl` links the
//               GitHub repo.
// `license` is the model weights licence as verified from the model
// card (HF cardData / README) at cataloguing time — entries whose
// licence could not be verified are not catalogued at all.
// Every tag in this file was pull-verified (Ollama registry manifest
// 200, sizes = manifest layer sums; HF repos checked via the HF API
// with GGUF file sizes) — see the v0.16.0 evidence note in the goal's
// hidden_files. fitFor(ramGB) buckets a model for a given box:
// <=2.6GB 'smooth', <=4.2GB 'tight', anything above 'over' — big
// models stay listed (the operator's call), they are just labelled.
// The catalog is deliberately generous: the operator may run tiny
// models on this small box, but the app is also handed to other
// people with bigger machines — the full ladder is there for them.
export const LOCAL_MODELS = [
  /* ---- code ---- */
  {
    tag: 'qwen2.5-coder:1.5b', cat: 'code', name: 'Qwen2.5-Coder 1.5B', diskGB: 1, ramGB: 1.2, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '演示档：能聊天、跑流程，真干活会犯傻', blurbEn: 'Demo tier: chats and demos the flow, fumbles real work',
  },
  {
    tag: 'qwen2.5-coder:3b', cat: 'code', name: 'Qwen2.5-Coder 3B', diskGB: 1.9, ramGB: 2.2, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '入门档：小任务能做，工具调用时好时坏', blurbEn: 'Starter tier: small tasks work, tool calls are hit-or-miss',
  },
  {
    tag: 'qwen2.5-coder:7b', cat: 'code', name: 'Qwen2.5-Coder 7B', diskGB: 4.7, ramGB: 5.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '能用起步：简单多步任务可以完成', blurbEn: 'Usable start: simple multi-step tasks get done',
  },
  {
    tag: 'qwen2.5-coder:14b', cat: 'code', name: 'Qwen2.5-Coder 14B', diskGB: 9, ramGB: 10, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '稳档：代码质量与工具调用都明显更靠谱', blurbEn: 'Solid tier: noticeably better code and tool use',
  },
  {
    tag: 'qwen2.5-coder:32b', cat: 'code', name: 'Qwen2.5-Coder 32B', diskGB: 19.9, ramGB: 21, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '上代旗舰代码模型：慢，但代码品味好', blurbEn: 'Last gen\'s flagship coder: slow, but with good code taste',
  },
  {
    tag: 'devstral:24b', cat: 'code', name: 'Devstral 24B', diskGB: 14.3, ramGB: 15, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Mistral 专为 coding agent 调校的一款', blurbEn: 'Mistral\'s model tuned specifically for coding agents',
  },
  {
    tag: 'devstral-small-2:24b', cat: 'code', name: 'Devstral Small 2 24B', diskGB: 15.2, ramGB: 16.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Devstral 二代小杯：为代码 Agent 优化，体积比一代大杯小得多', blurbEn: 'Devstral 2\'s smaller build: tuned for coding agents, far lighter than the 123B',
  },
  {
    tag: 'qwen3-coder:30b', cat: 'code', name: 'Qwen3-Coder 30B', diskGB: 18.6, ramGB: 20, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '本地代码 Agent 首选：仓库级理解 + 可靠工具调用', blurbEn: 'The local coding-agent pick: repo-level understanding, reliable tool calls',
  },
  {
    tag: 'qwen3-coder:480b', cat: 'code', name: 'Qwen3-Coder 480B (MoE)', diskGB: 290.1, ramGB: 300, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '旗舰 MoE：给工作站/服务器集群准备的，家用机别碰', blurbEn: 'Flagship MoE: for workstations / server clusters — not for home boxes',
  },
  {
    tag: 'qwen2.5-coder:0.5b', cat: 'code', name: 'Qwen2.5-Coder 0.5B', diskGB: 0.4, ramGB: 0.8, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '最小代码模型：补全、改小片段，玩具档', blurbEn: 'Smallest coder: completions and tiny edits, toy tier',
  },
  {
    tag: 'starcoder2:3b', tools: false, cat: 'code', name: 'StarCoder2 3B', diskGB: 1.7, ramGB: 2.1, src: 'ollama', license: 'BigCode OpenRAIL-M',
    blurbZh: 'BigCode 开源代码模型：轻量补全', blurbEn: 'BigCode\'s open coder: light completions',
  },
  {
    tag: 'codellama:7b', tools: false, cat: 'code', name: 'CodeLlama 7B', diskGB: 3.8, ramGB: 4.6, src: 'ollama', license: 'Llama 2 Community License',
    blurbZh: 'Meta 经典代码模型：老牌补全手', blurbEn: 'Meta\'s classic coder: a veteran completion hand',
  },
  {
    tag: 'deepseek-coder:6.7b', tools: false, cat: 'code', name: 'DeepSeek-Coder 6.7B', diskGB: 3.8, ramGB: 4.6, src: 'ollama', license: 'DeepSeek License',
    blurbZh: '初代 DeepSeek 代码：小而能打', blurbEn: 'Original DeepSeek coder: small and capable',
  },
  {
    tag: 'starcoder2:7b', tools: false, cat: 'code', name: 'StarCoder2 7B', diskGB: 4, ramGB: 4.8, src: 'ollama', license: 'BigCode OpenRAIL-M',
    blurbZh: 'StarCoder2 中杯：多语言代码补全', blurbEn: 'StarCoder2 mid: multilingual code completion',
  },
  {
    tag: 'granite-code:8b', cat: 'code', name: 'Granite Code 8B', diskGB: 4.6, ramGB: 5.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'IBM 开源代码模型：企业风，稳重', blurbEn: 'IBM\'s open coder: enterprise-flavoured, steady',
  },
  {
    tag: 'codegemma:7b', tools: false, cat: 'code', name: 'CodeGemma 7B', diskGB: 5, ramGB: 6, src: 'ollama', license: 'Gemma Terms',
    blurbZh: 'Google 的代码版 Gemma', blurbEn: 'Google\'s coding Gemma',
  },
  {
    tag: 'codellama:13b', tools: false, cat: 'code', name: 'CodeLlama 13B', diskGB: 7.4, ramGB: 8.7, src: 'ollama', license: 'Llama 2 Community License',
    blurbZh: 'CodeLlama 大杯：理解力更好', blurbEn: 'CodeLlama large: better comprehension',
  },
  {
    tag: 'deepseek-coder-v2:16b', cat: 'code', name: 'DeepSeek-Coder-V2 16B', diskGB: 8.9, ramGB: 10.4, src: 'ollama', license: 'DeepSeek License',
    blurbZh: 'MoE 代码模型：轻身板、强代码', blurbEn: 'MoE coder: light body, strong code',
  },
  {
    tag: 'starcoder2:15b', tools: false, cat: 'code', name: 'StarCoder2 15B', diskGB: 9.1, ramGB: 10.7, src: 'ollama', license: 'BigCode OpenRAIL-M',
    blurbZh: 'StarCoder2 大杯：仓库级补全更稳', blurbEn: 'StarCoder2 large: steadier repo-level completion',
  },
  {
    tag: 'devstral-2:123b', cat: 'code', name: 'Devstral 2 123B', diskGB: 74.9, ramGB: 82, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Mistral 代码旗舰：SWE 级修仓能力，给大机器', blurbEn: 'Mistral\'s coding flagship: SWE-grade repo work, big machines',
  },
  {
    tag: 'codestral:22b', cat: 'code', name: 'Codestral 22B', diskGB: 12.6, ramGB: 14, src: 'ollama', license: 'MNPL (Mistral Non-Production License)',
    blurbZh: 'Mistral 专门的代码模型：补全与改代码都利落', blurbEn: 'Mistral\'s dedicated code model: crisp completion and edits',
  },
  {
    tag: 'codellama:34b', tools: false, cat: 'code', name: 'CodeLlama 34B', diskGB: 19.1, ramGB: 21, src: 'ollama', license: 'Llama 2 Community License',
    blurbZh: 'CodeLlama 大杯：老牌旗舰补全手', blurbEn: 'CodeLlama large: the veteran flagship completer',
  },
  {
    tag: 'codellama:70b', tools: false, cat: 'code', name: 'CodeLlama 70B', diskGB: 38.9, ramGB: 43, src: 'ollama', license: 'Llama 2 Community License',
    blurbZh: 'CodeLlama 旗舰：给大机器的老牌强手', blurbEn: 'CodeLlama\'s flagship: a proven heavyweight for big machines',
  },
  {
    tag: 'starcoder:7b', tools: false, cat: 'code', name: 'StarCoder 7B', diskGB: 4.3, ramGB: 5.1, src: 'ollama', license: 'BigCode OpenRAIL-M',
    blurbZh: '初代 StarCoder：经典开源补全', blurbEn: 'The original StarCoder: a classic open completer',
  },
  {
    tag: 'starcoder:15b', tools: false, cat: 'code', name: 'StarCoder 15B', diskGB: 9, ramGB: 10.6, src: 'ollama', license: 'BigCode OpenRAIL-M',
    blurbZh: '初代 StarCoder 大杯：多语言补全', blurbEn: 'Original StarCoder, large: multilingual completion',
  },
  {
    tag: 'codegemma:2b', tools: false, cat: 'code', name: 'CodeGemma 2B', diskGB: 1.6, ramGB: 1.9, src: 'ollama', license: 'Gemma Terms',
    blurbZh: 'Google 代码小杯：轻量补全', blurbEn: 'Google\'s small coder: light completions',
  },
  {
    tag: 'granite-code:3b', cat: 'code', name: 'Granite Code 3B', diskGB: 2, ramGB: 2.4, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'IBM 代码小杯：轻量、企业风', blurbEn: 'IBM\'s small coder: light, enterprise-flavoured',
  },
  {
    tag: 'granite-code:20b', cat: 'code', name: 'Granite Code 20B', diskGB: 11.6, ramGB: 13.2, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'IBM 代码强档：仓库级任务更稳', blurbEn: 'IBM\'s strong coder: steadier repo-level work',
  },
  {
    tag: 'granite-code:34b', cat: 'code', name: 'Granite Code 34B', diskGB: 19.2, ramGB: 21.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'IBM 代码旗舰：给大内存机器', blurbEn: 'IBM\'s coding flagship: big-RAM machines',
  },
  {
    tag: 'codegeex4:9b', cat: 'code', name: 'CodeGeeX4 9B', diskGB: 5.5, ramGB: 6.4, src: 'ollama', license: 'CodeGeeX4 License',
    blurbZh: '清华 CodeGeeX 第四代：中英双语代码', blurbEn: 'Tsinghua\'s CodeGeeX gen 4: bilingual code model',
  },
  {
    tag: 'yi-coder:9b', cat: 'code', name: 'Yi-Coder 9B', diskGB: 5, ramGB: 5.9, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '零一万物代码款：长上下文补全利落', blurbEn: '01.AI\'s coder: crisp long-context completion',
  },
  {
    tag: 'yi-coder:1.5b', cat: 'code', name: 'Yi-Coder 1.5B', diskGB: 0.9, ramGB: 1.2, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Yi-Coder 小杯：极轻补全', blurbEn: 'Yi-Coder small: featherweight completion',
  },
  {
    tag: 'sqlcoder:7b', cat: 'code', name: 'SQLCoder 7B', diskGB: 4.1, ramGB: 4.9, src: 'ollama', license: 'CC-BY-SA-4.0',
    blurbZh: 'Defog 的 SQL 专长：自然语言转查询', blurbEn: 'Defog\'s SQL specialist: natural language to queries',
  },
  {
    tag: 'deepseek-coder:33b', tools: false, cat: 'code', name: 'DeepSeek-Coder 33B', diskGB: 18.8, ramGB: 21, src: 'ollama', license: 'DeepSeek License',
    blurbZh: '初代 DeepSeek 代码旗舰：老而弥坚', blurbEn: 'The original DeepSeek coding flagship: aged well',
  },
  {
    tag: 'deepseek-coder:1.3b', tools: false, cat: 'code', name: 'DeepSeek-Coder 1.3B', diskGB: 0.8, ramGB: 1.1, src: 'ollama', license: 'DeepSeek License',
    blurbZh: '初代代码小杯：极轻补全玩具档', blurbEn: 'Original coder, tiny: featherweight completion, toy tier',
  },
  /* ---- general ---- */
  {
    tag: 'llama3.2:3b', cat: 'general', name: 'Llama 3.2 3B', diskGB: 2, ramGB: 2.4, src: 'ollama', license: 'Llama 3.2 Community License',
    blurbZh: 'Meta 小杯：聊天、摘要、轻任务', blurbEn: 'Meta\'s small one: chat, summaries, light tasks',
  },
  {
    tag: 'llama3.1:8b', cat: 'general', name: 'Llama 3.1 8B', diskGB: 4.9, ramGB: 5.5, src: 'ollama', license: 'Llama 3.1 Community License',
    blurbZh: 'Meta 中杯：通用均衡，英文最强', blurbEn: 'Meta\'s mid-size: balanced generalist, strongest in English',
  },
  {
    tag: 'qwen3:8b', cat: 'general', name: 'Qwen3 8B', diskGB: 5.2, ramGB: 6, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义新代 8B：中文好，带思维链开关', blurbEn: 'New-gen Qwen 8B: strong Chinese, switchable thinking',
  },
  {
    tag: 'qwen3:14b', cat: 'general', name: 'Qwen3 14B', diskGB: 9.3, ramGB: 10.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义 14B：通用稳档，工具调用可靠', blurbEn: 'Qwen3 14B: solid generalist, reliable tool calls',
  },
  {
    tag: 'qwen3:32b', cat: 'general', name: 'Qwen3 32B', diskGB: 20.2, ramGB: 21, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义 32B：本地通用强档', blurbEn: 'Qwen3 32B: the strong local generalist',
  },
  {
    tag: 'qwen3.6:27b', cat: 'general', name: 'Qwen 3.6 27B', diskGB: 17.8, ramGB: 18, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '强档：综合代码能力出色，工具调用可靠', blurbEn: 'Strong tier: excellent all-round coder, reliable tool calls',
  },
  {
    tag: 'qwen3.5:4b', cat: 'general', name: 'Qwen3.5 4B', diskGB: 3.3, ramGB: 4, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义 3.5 小杯：新代轻量通用', blurbEn: 'Qwen3.5 small: new-gen light generalist',
  },
  {
    tag: 'qwen3.5:9b', cat: 'general', name: 'Qwen3.5 9B', diskGB: 6.6, ramGB: 7.6, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义 3.5 中杯：均衡，中文强', blurbEn: 'Qwen3.5 mid: balanced, strong Chinese',
  },
  {
    tag: 'qwen3.5:27b', cat: 'general', name: 'Qwen3.5 27B', diskGB: 17.5, ramGB: 19.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义 3.5 强档：通用+代码都硬', blurbEn: 'Qwen3.5 strong tier: general and code both solid',
  },
  {
    tag: 'qwen3.5:35b', cat: 'general', name: 'Qwen3.5 35B (MoE)', diskGB: 22.1, ramGB: 24, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义 3.5 MoE：35B 总参，速度快过同体量稠密款', blurbEn: 'Qwen3.5 MoE: 35B total, faster than dense models its size',
  },
  {
    tag: 'qwen3.5:122b', cat: 'general', name: 'Qwen3.5 122B (MoE)', diskGB: 81.4, ramGB: 89, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义 3.5 旗舰 MoE：给大内存机器', blurbEn: 'Qwen3.5 flagship MoE: big-RAM machines',
  },
  {
    tag: 'gpt-oss:20b', cat: 'general', name: 'GPT-OSS 20B', diskGB: 13.8, ramGB: 15, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'OpenAI 的开源权重：推理与工具调用强，通用型', blurbEn: 'OpenAI\'s open weights: strong reasoning and tool use, general-purpose',
  },
  {
    tag: 'gpt-oss:120b', cat: 'general', name: 'GPT-OSS 120B', diskGB: 65.4, ramGB: 70, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'OpenAI 开源大杯：给大内存机器准备', blurbEn: 'OpenAI\'s big open weights: for machines with serious RAM',
  },
  {
    tag: 'phi4:14b', cat: 'general', name: 'Phi-4 14B', diskGB: 9.1, ramGB: 10, src: 'ollama', license: 'MIT',
    blurbZh: '微软出品：小身材，推理与数学见长', blurbEn: 'Microsoft\'s Phi-4: small body, strong reasoning and math',
  },
  {
    tag: 'gemma3:12b', cat: 'general', vision: true, name: 'Gemma 3 12B', diskGB: 8.2, ramGB: 9.5, src: 'ollama', license: 'Gemma Terms',
    blurbZh: 'Google 开源：多语言好，还能看图', blurbEn: 'Google\'s open model: great multilingual, can also see images',
  },
  {
    tag: 'mistral-small:24b', cat: 'general', name: 'Mistral Small 24B', diskGB: 14.3, ramGB: 15.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Mistral 通用主力：均衡、低调', blurbEn: 'Mistral\'s general workhorse: balanced and understated',
  },
  {
    tag: 'qwen3:0.6b', cat: 'general', name: 'Qwen3 0.6B', diskGB: 0.5, ramGB: 0.9, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义最小杯：跑流程、占位演示', blurbEn: 'Qwen\'s tiniest: flow demos and placeholders',
  },
  {
    tag: 'gemma3:1b', cat: 'general', vision: false, name: 'Gemma 3 1B', diskGB: 0.8, ramGB: 1.2, src: 'ollama', license: 'Gemma Terms',
    blurbZh: 'Google 最小杯：极轻通用', blurbEn: 'Google\'s tiniest generalist',
  },
  {
    tag: 'llama3.2:1b', cat: 'general', name: 'Llama 3.2 1B', diskGB: 1.3, ramGB: 1.7, src: 'ollama', license: 'Llama 3.2 Community License',
    blurbZh: 'Meta 最小杯：极轻，聊天小助手', blurbEn: 'Meta\'s tiniest: featherweight chat helper',
  },
  {
    tag: 'qwen3:1.7b', cat: 'general', name: 'Qwen3 1.7B', diskGB: 1.4, ramGB: 1.8, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义小杯：轻任务中文顺手', blurbEn: 'Qwen small: handy for light Chinese tasks',
  },
  {
    tag: 'smollm2:1.7b', cat: 'general', name: 'SmolLM2 1.7B', diskGB: 1.8, ramGB: 2.2, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'HuggingFace 极轻量：边缘设备档', blurbEn: 'HuggingFace\'s featherweight: edge-device tier',
  },
  {
    tag: 'qwen2.5:3b', cat: 'general', name: 'Qwen2.5 3B', diskGB: 1.9, ramGB: 2.3, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '上代通义小杯：稳、省', blurbEn: 'Previous-gen Qwen small: steady and lean',
  },
  {
    tag: 'phi3.5:3.8b', cat: 'general', name: 'Phi-3.5 Mini', diskGB: 2.2, ramGB: 2.7, src: 'ollama', license: 'MIT',
    blurbZh: '微软小钢炮：小体积，推理不错', blurbEn: 'Microsoft\'s pocket rocket: small, reasons well',
  },
  {
    tag: 'qwen3:4b', cat: 'general', name: 'Qwen3 4B', diskGB: 2.5, ramGB: 3.1, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义 4B：轻量均衡档', blurbEn: 'Qwen 4B: light balanced tier',
  },
  {
    tag: 'gemma3:4b', cat: 'general', vision: true, name: 'Gemma 3 4B', diskGB: 3.4, ramGB: 4.1, src: 'ollama', license: 'Gemma Terms',
    blurbZh: 'Gemma 小杯：能看图，多语言好', blurbEn: 'Gemma small: sees images, great multilingual',
  },
  {
    tag: 'mistral:7b', cat: 'general', name: 'Mistral 7B', diskGB: 4.4, ramGB: 5.3, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Mistral 经典 7B：快而均衡', blurbEn: 'Mistral\'s classic 7B: fast and balanced',
  },
  {
    tag: 'qwen2.5:7b', cat: 'general', name: 'Qwen2.5 7B', diskGB: 4.7, ramGB: 5.6, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '上代通义 7B：老牌均衡手', blurbEn: 'Previous-gen Qwen 7B: veteran all-rounder',
  },
  {
    tag: 'gemma2:9b', tools: false, cat: 'general', name: 'Gemma 2 9B', diskGB: 5.4, ramGB: 6.4, src: 'ollama', license: 'Gemma Terms',
    blurbZh: '上代 Gemma 中杯：文笔好', blurbEn: 'Previous-gen Gemma mid: good writer',
  },
  {
    tag: 'qwen2.5:14b', cat: 'general', name: 'Qwen2.5 14B', diskGB: 9, ramGB: 10.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '上代通义 14B：通用稳档', blurbEn: 'Previous-gen Qwen 14B: solid generalist',
  },
  {
    tag: 'gemma2:27b', tools: false, cat: 'general', name: 'Gemma 2 27B', diskGB: 15.6, ramGB: 18.1, src: 'ollama', license: 'Gemma Terms',
    blurbZh: '上代 Gemma 大杯：长文稳', blurbEn: 'Previous-gen Gemma large: steady long-form',
  },
  {
    tag: 'gemma3:27b', cat: 'general', vision: true, name: 'Gemma 3 27B', diskGB: 17.4, ramGB: 20.2, src: 'ollama', license: 'Gemma Terms',
    blurbZh: 'Gemma 大杯：通用稳档，能看图', blurbEn: 'Gemma large: solid generalist, sees images',
  },
  {
    tag: 'gemma4:e2b', cat: 'general', vision: true, name: 'Gemma 4 E2B', diskGB: 4.6, ramGB: 5.4, src: 'ollama', license: 'Gemma Terms',
    blurbZh: 'Google 新代端侧款：小身材多模态（含视觉塔所以体积偏大）', blurbEn: 'Google\'s new edge model: multimodal in a small body (vision tower included, hence the size)',
  },
  {
    tag: 'gemma4:e4b', cat: 'general', vision: true, name: 'Gemma 4 E4B', diskGB: 6.6, ramGB: 7.6, src: 'ollama', license: 'Gemma Terms',
    blurbZh: 'Gemma 4 端侧大杯：多模态，轻量档里的全能手', blurbEn: 'Gemma 4 edge large: multimodal all-rounder in the light tier',
  },
  {
    tag: 'gemma4:12b', cat: 'general', vision: true, name: 'Gemma 4 12B', diskGB: 8, ramGB: 9.4, src: 'ollama', license: 'Gemma Terms',
    blurbZh: 'Gemma 4 中杯：多语言与看图都强', blurbEn: 'Gemma 4 mid: strong multilingual and vision',
  },
  {
    tag: 'gemma4:26b', cat: 'general', vision: true, name: 'Gemma 4 26B (MoE)', diskGB: 18.7, ramGB: 21, src: 'ollama', license: 'Gemma Terms',
    blurbZh: 'Gemma 4 MoE：大杯身手、MoE 速度', blurbEn: 'Gemma 4 MoE: large-model quality at MoE speed',
  },
  {
    tag: 'gemma4:31b', cat: 'general', vision: true, name: 'Gemma 4 31B', diskGB: 20.4, ramGB: 23, src: 'ollama', license: 'Gemma Terms',
    blurbZh: 'Gemma 4 旗舰稠密款：通用稳档之选', blurbEn: 'Gemma 4 flagship dense: the solid generalist pick',
  },
  {
    tag: 'nemotron-3-nano:4b', cat: 'general', name: 'Nemotron 3 Nano 4B', diskGB: 2.8, ramGB: 3.4, src: 'ollama', license: 'NVIDIA Nemotron Open Model License',
    blurbZh: 'NVIDIA 新代小杯：为 Agent 场景调校', blurbEn: 'NVIDIA\'s new small model: tuned for agentic work',
  },
  {
    tag: 'nemotron-3-nano:30b', cat: 'general', name: 'Nemotron 3 Nano 30B', diskGB: 24.3, ramGB: 26.5, src: 'ollama', license: 'NVIDIA Nemotron Open Model License',
    blurbZh: 'Nemotron 3 大杯：混合推理，Agent 向', blurbEn: 'Nemotron 3 large: hybrid reasoning, agent-oriented',
  },
  {
    tag: 'qwen2.5:32b', cat: 'general', name: 'Qwen2.5 32B', diskGB: 19.9, ramGB: 23.1, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '上代通义 32B：本地强档', blurbEn: 'Previous-gen Qwen 32B: strong local tier',
  },
  {
    tag: 'llama3.3:70b', cat: 'general', name: 'Llama 3.3 70B', diskGB: 42.5, ramGB: 47, src: 'ollama', license: 'Llama 3.3 Community License',
    blurbZh: 'Meta 旗舰开源：通用强档，吃内存', blurbEn: 'Meta\'s flagship open model: strong, eats RAM',
  },
  {
    tag: 'qwen2.5:72b', cat: 'general', name: 'Qwen2.5 72B', diskGB: 47.4, ramGB: 52, src: 'ollama', license: 'Tongyi Qianwen License',
    blurbZh: '上代通义旗舰：给大内存机器', blurbEn: 'Previous-gen Qwen flagship: big-RAM machines',
  },
  {
    tag: 'llama4:16x17b', cat: 'general', vision: true, name: 'Llama 4 Scout', diskGB: 67.4, ramGB: 74, src: 'ollama', license: 'Llama 4 Community License',
    blurbZh: 'Meta 新代 MoE：长上下文、多模态，给大机器', blurbEn: 'Meta\'s new MoE: long context, multimodal, big machines only',
  },
  {
    tag: 'mistral-large:123b', cat: 'general', name: 'Mistral Large 123B', diskGB: 73.2, ramGB: 81, src: 'ollama', license: 'Mistral Research License (MRL)',
    blurbZh: 'Mistral 旗舰：给服务器准备的', blurbEn: 'Mistral\'s flagship: server-class',
  },
  {
    tag: 'deepseek-v3.1:671b', cat: 'general', name: 'DeepSeek-V3.1 671B', diskGB: 404.5, ramGB: 440, src: 'ollama', license: 'MIT',
    blurbZh: '满血 DeepSeek：本地部署的云端级体验，集群档', blurbEn: 'Full-size DeepSeek: cloud-grade, run locally — cluster tier',
  },
  {
    tag: 'qwen3:235b-a22b', cat: 'general', name: 'Qwen3 235B (MoE)', diskGB: 142.2, ramGB: 155, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义旗舰 MoE：通用+代码全能，大内存档', blurbEn: 'Qwen\'s flagship MoE: everything-strong, big-RAM tier',
  },
  {
    tag: 'qwen3-next:80b', cat: 'general', name: 'Qwen3-Next 80B', diskGB: 50.4, ramGB: 55, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义次世代：长上下文 + 高速推理', blurbEn: 'Qwen next-gen: long context, fast inference',
  },
  {
    tag: 'llama3.1:405b', cat: 'general', name: 'Llama 3.1 405B', diskGB: 243.1, ramGB: 265, src: 'ollama', license: 'Llama 3.1 Community License',
    blurbZh: 'Meta 上代旗舰：开源权重标杆，集群档', blurbEn: 'Meta\'s former flagship: the open-weights benchmark, cluster tier',
  },
  {
    tag: 'phi4-mini:3.8b', cat: 'general', name: 'Phi-4 Mini 3.8B', diskGB: 2.5, ramGB: 3, src: 'ollama', license: 'MIT',
    blurbZh: '微软小钢炮：体积小、逻辑意外地能打', blurbEn: 'Microsoft\'s pocket rocket: small, surprisingly strong at logic',
  },
  {
    tag: 'hermes3:8b', cat: 'general', name: 'Hermes 3 8B', diskGB: 4.7, ramGB: 5.5, src: 'ollama', license: 'Llama 3.1 Community License',
    blurbZh: 'Nous 的指令调校版 Llama：听话、工具调用稳', blurbEn: 'Nous\' instruction-tuned Llama: obedient, steady tool use',
  },
  {
    tag: 'aya:8b', cat: 'general', name: 'Aya 8B', diskGB: 4.8, ramGB: 5.6, src: 'ollama', license: 'CC-BY-NC-4.0',
    blurbZh: 'Cohere 的多语言款：小语种覆盖是它的主场', blurbEn: 'Cohere\'s multilingual entry: broad language coverage is its home turf',
  },
  {
    tag: 'exaone3.5:7.8b', cat: 'general', name: 'EXAONE 3.5 7.8B', diskGB: 4.8, ramGB: 5.6, src: 'ollama', license: 'EXAONE License',
    blurbZh: 'LG 的双语（英/韩）通用款，指令跟随干净', blurbEn: 'LG\'s bilingual (EN/KO) general model with clean instruction following',
  },
  {
    tag: 'granite3.3:8b', cat: 'general', name: 'Granite 3.3 8B', diskGB: 4.9, ramGB: 5.8, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'IBM 企业向通用款：稳重、长上下文', blurbEn: 'IBM\'s enterprise general model: steady, long context',
  },
  {
    tag: 'glm4:9b', cat: 'general', name: 'GLM-4 9B', diskGB: 5.5, ramGB: 6.4, src: 'ollama', license: 'GLM-4 License',
    blurbZh: '智谱 GLM-4：中文对话自然、工具调用齐整', blurbEn: 'Zhipu\'s GLM-4: natural Chinese chat, tidy tool calls',
  },
  {
    tag: 'mistral-nemo:12b', cat: 'general', name: 'Mistral Nemo 12B', diskGB: 7.1, ramGB: 8.2, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Mistral×NVIDIA 的 12B：均衡、长上下文', blurbEn: 'Mistral×NVIDIA\'s 12B: balanced, long context',
  },
  {
    tag: 'solar-pro:22b', cat: 'general', name: 'Solar Pro 22B', diskGB: 13.3, ramGB: 15, src: 'ollama', license: 'MIT',
    blurbZh: 'Upstage 的旗舰通用款：单卡档里推理偏强', blurbEn: 'Upstage\'s flagship: strong reasoning for its single-card tier',
  },
  {
    tag: 'command-r:35b', cat: 'general', name: 'Command R 35B', diskGB: 18.7, ramGB: 20.5, src: 'ollama', license: 'CC-BY-NC-4.0',
    blurbZh: 'Cohere 的 RAG/工具向款：查资料型任务对口', blurbEn: 'Cohere\'s RAG/tool-oriented model: fits lookup-heavy tasks',
  },
  {
    tag: 'llama3.1:70b', cat: 'general', name: 'Llama 3.1 70B', diskGB: 42.5, ramGB: 46, src: 'ollama', license: 'Llama 3.1 Community License',
    blurbZh: '上代大杯 Llama：慢而稳，老牌全能', blurbEn: 'Last-gen big Llama: slow, steady, a proven all-rounder',
  },
  {
    tag: 'qwen3:30b-a3b', cat: 'general', name: 'Qwen3 30B-A3B (MoE)', diskGB: 18.6, ramGB: 20, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义 MoE：30B 总参、3B 激活，速度快', blurbEn: 'Qwen MoE: 30B total, 3B active — fast for its size',
  },
  {
    tag: 'qwen2.5:0.5b', cat: 'general', name: 'Qwen2.5 0.5B', diskGB: 0.4, ramGB: 0.8, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '上代通义最小杯：占位演示档', blurbEn: 'Previous-gen Qwen tiniest: placeholder demos',
  },
  {
    tag: 'qwen2.5:1.5b', cat: 'general', name: 'Qwen2.5 1.5B', diskGB: 1, ramGB: 1.4, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '上代通义小杯：轻任务顺手', blurbEn: 'Previous-gen Qwen small: handy for light tasks',
  },
  {
    tag: 'gemma3:270m', cat: 'general', name: 'Gemma 3 270M', diskGB: 0.3, ramGB: 0.6, src: 'ollama', license: 'Gemma Terms',
    blurbZh: 'Google 极小杯：边缘设备与流程演示', blurbEn: 'Google\'s micro model: edge devices and flow demos',
  },
  {
    tag: 'gemma2:2b', tools: false, cat: 'general', name: 'Gemma 2 2B', diskGB: 1.6, ramGB: 2, src: 'ollama', license: 'Gemma Terms',
    blurbZh: '上代 Gemma 小杯：轻量通用', blurbEn: 'Previous-gen Gemma small: light generalist',
  },
  {
    tag: 'tinyllama:1.1b', cat: 'general', name: 'TinyLlama 1.1B', diskGB: 0.6, ramGB: 1, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '经典极轻量：跑流程、占位', blurbEn: 'The classic featherweight: flows and placeholders',
  },
  {
    tag: 'smollm2:135m', cat: 'general', name: 'SmolLM2 135M', diskGB: 0.3, ramGB: 0.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'HuggingFace 微型杯：能跑通流程的最小档', blurbEn: 'HuggingFace\'s micro tier: smallest thing that runs the flow',
  },
  {
    tag: 'smollm2:360m', cat: 'general', name: 'SmolLM2 360M', diskGB: 0.7, ramGB: 1, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'SmolLM2 小杯：极轻聊天', blurbEn: 'SmolLM2 small: featherweight chat',
  },
  {
    tag: 'olmo2:7b', cat: 'general', name: 'OLMo 2 7B', diskGB: 4.5, ramGB: 5.4, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Ai2 全开源款：数据与训练全透明', blurbEn: 'Ai2\'s fully-open model: data and training in the open',
  },
  {
    tag: 'olmo2:13b', cat: 'general', name: 'OLMo 2 13B', diskGB: 8.4, ramGB: 9.8, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'OLMo 2 中杯：全开源路线强档', blurbEn: 'OLMo 2 mid: the strong fully-open pick',
  },
  {
    tag: 'olmo-3:7b', cat: 'general', name: 'OLMo 3 7B', diskGB: 4.5, ramGB: 5.4, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Ai2 新代：带思考模式的全开源款', blurbEn: 'Ai2\'s new gen: fully-open with a thinking mode',
  },
  {
    tag: 'olmo-3:32b', cat: 'general', name: 'OLMo 3 32B', diskGB: 19.5, ramGB: 22, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'OLMo 3 强档：全开源旗舰', blurbEn: 'OLMo 3 strong tier: the fully-open flagship',
  },
  {
    tag: 'llama3:8b', cat: 'general', name: 'Llama 3 8B', diskGB: 4.7, ramGB: 5.5, src: 'ollama', license: 'Llama 3 Community License',
    blurbZh: 'Meta 上代中杯：生态最广的老将', blurbEn: 'Meta\'s previous mid: the veteran with the widest ecosystem',
  },
  {
    tag: 'llama3:70b', cat: 'general', name: 'Llama 3 70B', diskGB: 40, ramGB: 44, src: 'ollama', license: 'Llama 3 Community License',
    blurbZh: 'Llama 3 大杯：给大内存机器', blurbEn: 'Llama 3 large: big-RAM machines',
  },
  {
    tag: 'llama2:7b', tools: false, cat: 'general', name: 'Llama 2 7B', diskGB: 3.8, ramGB: 4.6, src: 'ollama', license: 'Llama 2 Community License',
    blurbZh: '开源史上的里程碑：怀旧档，能力已过时', blurbEn: 'The open-weights milestone: nostalgia tier, dated skills',
  },
  {
    tag: 'mistral-small3.1:24b', cat: 'general', vision: true, name: 'Mistral Small 3.1 24B', diskGB: 15.5, ramGB: 17, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Mistral Small 3.1：能看图，通用均衡', blurbEn: 'Mistral Small 3.1: sees images, balanced generalist',
  },
  {
    tag: 'mistral-small:22b', cat: 'general', name: 'Mistral Small 22B', diskGB: 12.6, ramGB: 14, src: 'ollama', license: 'Mistral Research License (MRL)',
    blurbZh: 'Mistral Small 二代：研究许可证，均衡手', blurbEn: 'Mistral Small gen 2: research licence, balanced hand',
  },
  {
    tag: 'ministral-3:3b', cat: 'general', vision: true, name: 'Ministral 3 3B', diskGB: 3, ramGB: 3.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Mistral 端侧新代小杯：多模态，轻快', blurbEn: 'Mistral\'s new edge small: multimodal and quick',
  },
  {
    tag: 'ministral-3:8b', cat: 'general', vision: true, name: 'Ministral 3 8B', diskGB: 6, ramGB: 7, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Ministral 3 中杯：端侧多模态均衡档', blurbEn: 'Ministral 3 mid: balanced edge multimodal',
  },
  {
    tag: 'ministral-3:14b', cat: 'general', vision: true, name: 'Ministral 3 14B', diskGB: 9.1, ramGB: 10.6, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Ministral 3 大杯：端侧里的强档', blurbEn: 'Ministral 3 large: the edge line\'s strong tier',
  },
  {
    tag: 'granite3.2:8b', cat: 'general', name: 'Granite 3.2 8B', diskGB: 4.9, ramGB: 5.8, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'IBM 通用款：企业风、稳重', blurbEn: 'IBM\'s general model: enterprise-flavoured, steady',
  },
  {
    tag: 'granite3.2:2b', cat: 'general', name: 'Granite 3.2 2B', diskGB: 1.6, ramGB: 1.9, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Granite 小杯：轻量企业档', blurbEn: 'Granite small: light enterprise tier',
  },
  {
    tag: 'granite3.3:2b', cat: 'general', name: 'Granite 3.3 2B', diskGB: 1.6, ramGB: 1.9, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Granite 3.3 小杯：轻、稳', blurbEn: 'Granite 3.3 small: light and steady',
  },
  {
    tag: 'granite4:3b', cat: 'general', name: 'Granite 4.0 3B', diskGB: 2.1, ramGB: 2.6, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'IBM 新代混合架构：小身材长上下文', blurbEn: 'IBM\'s new hybrid architecture: long context, small body',
  },
  {
    tag: 'exaone3.5:2.4b', cat: 'general', name: 'EXAONE 3.5 2.4B', diskGB: 1.6, ramGB: 2, src: 'ollama', license: 'EXAONE License',
    blurbZh: 'LG 双语小杯：英/韩轻任务', blurbEn: 'LG\'s bilingual small: light EN/KO tasks',
  },
  {
    tag: 'exaone3.5:32b', cat: 'general', name: 'EXAONE 3.5 32B', diskGB: 19.3, ramGB: 22, src: 'ollama', license: 'EXAONE License',
    blurbZh: 'EXAONE 旗舰：英/韩双语强档', blurbEn: 'EXAONE\'s flagship: strong EN/KO tier',
  },
  {
    tag: 'aya-expanse:8b', cat: 'general', name: 'Aya Expanse 8B', diskGB: 5.1, ramGB: 5.9, src: 'ollama', license: 'CC-BY-NC-4.0',
    blurbZh: 'Cohere 多语言新代：23 种语言（非商用许可）', blurbEn: 'Cohere\'s multilingual new gen: 23 languages (non-commercial licence)',
  },
  {
    tag: 'aya-expanse:32b', cat: 'general', name: 'Aya Expanse 32B', diskGB: 19.8, ramGB: 22.5, src: 'ollama', license: 'CC-BY-NC-4.0',
    blurbZh: 'Aya Expanse 大杯：多语言强档（非商用许可）', blurbEn: 'Aya Expanse large: strong multilingual (non-commercial licence)',
  },
  {
    tag: 'command-r-plus:104b', cat: 'general', name: 'Command R+ 104B', diskGB: 59.2, ramGB: 65, src: 'ollama', license: 'CC-BY-NC-4.0',
    blurbZh: 'Cohere 的 RAG 旗舰：查资料型任务（非商用许可）', blurbEn: 'Cohere\'s RAG flagship: lookup-heavy tasks (non-commercial licence)',
  },
  {
    tag: 'openhermes:latest', cat: 'general', name: 'OpenHermes 2.5 7B', diskGB: 4.1, ramGB: 4.9, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Teknium 的经典指令调校：社区老牌热门', blurbEn: 'Teknium\'s classic instruction tune: a long-running community favourite',
  },
  {
    tag: 'zephyr:7b', cat: 'general', name: 'Zephyr 7B', diskGB: 4.1, ramGB: 4.9, src: 'ollama', license: 'MIT',
    blurbZh: 'HF 官方对齐调校版 Mistral：对话顺滑', blurbEn: 'HF\'s own aligned Mistral tune: smooth chat',
  },
  {
    tag: 'solar:10.7b', cat: 'general', name: 'SOLAR 10.7B', diskGB: 6.1, ramGB: 7, src: 'ollama', license: 'CC-BY-NC-4.0',
    blurbZh: 'Upstage 的深度上扩款：小身材强推理（非商用许可）', blurbEn: 'Upstage\'s depth-upscaled model: strong reasoning, small body (non-commercial licence)',
  },
  {
    tag: 'dolphin3:8b', cat: 'general', name: 'Dolphin 3.0 8B', diskGB: 4.9, ramGB: 5.8, src: 'ollama', license: 'Llama 3.1 Community License',
    blurbZh: '社区模型（Cognitive Computations）：少拒答、听话', blurbEn: 'Community model (Cognitive Computations): uncensored-leaning, obedient',
  },
  {
    tag: 'hermes3:70b', cat: 'general', name: 'Hermes 3 70B', diskGB: 40, ramGB: 44, src: 'ollama', license: 'Llama 3.1 Community License',
    blurbZh: 'Nous 指令旗舰大杯：给大机器', blurbEn: 'Nous\' instruction flagship, large: big machines',
  },
  {
    tag: 'hermes3:405b', cat: 'general', name: 'Hermes 3 405B', diskGB: 228.9, ramGB: 250, src: 'ollama', license: 'Llama 3.1 Community License',
    blurbZh: 'Hermes 满血版：集群档', blurbEn: 'Hermes at full size: cluster tier',
  },
  {
    tag: 'falcon3:3b', cat: 'general', name: 'Falcon3 3B', diskGB: 2, ramGB: 2.5, src: 'ollama', license: 'TII Falcon LLM License',
    blurbZh: '阿布扎比 TII 小杯：轻量多语言', blurbEn: 'Abu Dhabi TII\'s small model: light multilingual',
  },
  {
    tag: 'falcon3:7b', cat: 'general', name: 'Falcon3 7B', diskGB: 4.6, ramGB: 5.4, src: 'ollama', license: 'TII Falcon LLM License',
    blurbZh: 'Falcon3 中杯：均衡通用', blurbEn: 'Falcon3 mid: balanced generalist',
  },
  {
    tag: 'falcon3:10b', cat: 'general', name: 'Falcon3 10B', diskGB: 6.3, ramGB: 7.3, src: 'ollama', license: 'TII Falcon LLM License',
    blurbZh: 'Falcon3 大杯：同系强档', blurbEn: 'Falcon3 large: the family\'s strong tier',
  },
  {
    tag: 'glm-4.7-flash:latest', cat: 'general', name: 'GLM-4.7-Flash 30B (MoE)', diskGB: 19, ramGB: 21, src: 'ollama', license: 'MIT',
    blurbZh: '智谱闪电款：为 Agent 与推理调校，速度优先', blurbEn: 'Zhipu\'s flash model: tuned for agents and reasoning, speed first',
  },
  {
    tag: 'hf.co/unsloth/DeepSeek-V4-Flash-GGUF:UD-Q4_K_XL', cat: 'general', name: 'DeepSeek-V4-Flash (HF GGUF)', diskGB: 155.1, ramGB: 170, src: 'hf', license: 'MIT',
    blurbZh: 'HF 社区量化（unsloth）：V4 闪电版，官方库还没有', blurbEn: 'HF community quant (unsloth): the V4 flash tier, not in the official library yet',
  },
  {
    tag: 'hf.co/unsloth/DeepSeek-V4-Pro-0813-GGUF:UD-Q4_K_XL', cat: 'general', name: 'DeepSeek-V4-Pro (HF GGUF)', diskGB: 849.7, ramGB: 920, src: 'hf', license: 'MIT',
    blurbZh: 'HF 社区量化（unsloth）：V4 旗舰 Pro，万亿级 MoE，纯集群档', blurbEn: 'HF community quant (unsloth): the V4 Pro flagship, trillion-class MoE — cluster only',
  },
  {
    tag: 'hf.co/unsloth/Kimi-K2-Instruct-GGUF:UD-Q4_K_XL', cat: 'general', name: 'Kimi K2 Instruct (HF GGUF)', diskGB: 587.1, ramGB: 640, src: 'github', license: 'Modified MIT License', srcUrl: 'https://github.com/MoonshotAI/Kimi-K2',
    blurbZh: 'GitHub 开源项目（MoonshotAI/Kimi-K2），经 HF 社区量化分发：万亿 MoE', blurbEn: 'GitHub open project (MoonshotAI/Kimi-K2) via HF community quants: trillion-param MoE',
  },
  {
    tag: 'hf.co/unsloth/GLM-4.5-Air-GGUF:Q4_K_M', cat: 'general', name: 'GLM-4.5-Air 106B (HF GGUF)', diskGB: 73, ramGB: 80, src: 'hf', license: 'MIT',
    blurbZh: 'HF 社区量化（unsloth）：智谱 MoE 旗舰的轻量版', blurbEn: 'HF community quant (unsloth): Zhipu\'s lighter MoE flagship',
  },
  {
    tag: 'hf.co/bartowski/ByteDance-Seed_Seed-OSS-36B-Instruct-GGUF:Q4_K_M', cat: 'general', name: 'Seed-OSS 36B (HF GGUF)', diskGB: 21.8, ramGB: 25, src: 'github', license: 'Apache-2.0', srcUrl: 'https://github.com/ByteDance-Seed/Seed-OSS',
    blurbZh: 'GitHub 开源项目（ByteDance-Seed/Seed-OSS），经 HF 社区量化（bartowski）分发', blurbEn: 'GitHub open project (ByteDance-Seed/Seed-OSS) via HF community quants (bartowski)',
  },
  {
    tag: 'hf.co/dphn/Dolphin3.0-Llama3.1-8B-GGUF:Q4_K_M', cat: 'general', name: 'Dolphin 3.0 8B (HF GGUF)', diskGB: 4.9, ramGB: 5.8, src: 'hf', license: 'Llama 3.1 Community License',
    blurbZh: 'HF 官方仓（dphn）：Cognitive Computations 的社区名作，少拒答', blurbEn: 'HF official repo (dphn): Cognitive Computations\' community favourite, low-refusal',
  },
  {
    tag: 'hf.co/NousResearch/Hermes-4.3-36B-GGUF:Q4_K_M', cat: 'general', name: 'Hermes 4.3 36B (HF GGUF)', diskGB: 21.8, ramGB: 25, src: 'hf', license: 'Apache-2.0',
    blurbZh: 'HF 官方 GGUF（Nous）：Hermes 4.3，混合推理', blurbEn: 'HF official GGUF (Nous): Hermes 4.3 with hybrid reasoning',
  },
  {
    tag: 'hf.co/bartowski/NousResearch_Hermes-4-14B-GGUF:Q4_K_M', cat: 'general', name: 'Hermes 4 14B (HF GGUF)', diskGB: 9, ramGB: 10.5, src: 'hf', license: 'Apache-2.0',
    blurbZh: 'HF 社区量化（bartowski）：Nous Hermes 4 中杯', blurbEn: 'HF community quant (bartowski): Nous\' Hermes 4 mid-size',
  },
  {
    tag: 'hf.co/unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF:Q4_K_M', cat: 'general', name: 'Qwen3 30B-A3B Instruct-2507 (HF GGUF)', diskGB: 18.6, ramGB: 20, src: 'hf', license: 'Apache-2.0',
    blurbZh: 'HF 社区量化（unsloth）：2507 纯指令版，不带思维链', blurbEn: 'HF community quant (unsloth): the 2507 pure-instruct refresh, no thinking mode',
  },
  {
    tag: 'huihui_ai/qwen3-abliterated:4b', cat: 'general', name: 'Qwen3 4B Abliterated（社区）', diskGB: 2.5, ramGB: 3, src: 'community', license: 'Apache-2.0',
    blurbZh: '社区注册表（huihui_ai）：去拒答微调版，非官方出品', blurbEn: 'Community registry (huihui_ai): abliterated fine-tune, not an official build',
  },
  {
    tag: 'huihui_ai/qwen3-abliterated:8b', cat: 'general', name: 'Qwen3 8B Abliterated（社区）', diskGB: 5, ramGB: 5.9, src: 'community', license: 'Apache-2.0',
    blurbZh: '社区注册表（huihui_ai）：去拒答微调版，非官方出品', blurbEn: 'Community registry (huihui_ai): abliterated fine-tune, not an official build',
  },
  {
    tag: 'huihui_ai/qwen3-abliterated:14b', cat: 'general', name: 'Qwen3 14B Abliterated（社区）', diskGB: 9, ramGB: 10.5, src: 'community', license: 'Apache-2.0',
    blurbZh: '社区注册表（huihui_ai）：去拒答微调版，非官方出品', blurbEn: 'Community registry (huihui_ai): abliterated fine-tune, not an official build',
  },
  {
    tag: 'huihui_ai/qwen3-abliterated:32b', cat: 'general', name: 'Qwen3 32B Abliterated（社区）', diskGB: 19.8, ramGB: 22, src: 'community', license: 'Apache-2.0',
    blurbZh: '社区注册表（huihui_ai）：去拒答微调版，非官方出品', blurbEn: 'Community registry (huihui_ai): abliterated fine-tune, not an official build',
  },
  {
    tag: 'huihui_ai/gemma3-abliterated:12b', cat: 'general', vision: true, name: 'Gemma 3 12B Abliterated（社区）', diskGB: 24.4, ramGB: 27, src: 'community', license: 'Gemma Terms',
    blurbZh: '社区注册表（huihui_ai）：去拒答版，能看图；未量化所以体积大', blurbEn: 'Community registry (huihui_ai): abliterated, sees images; unquantised, hence the size',
  },
  {
    tag: 'mannix/llama3.1-8b-abliterated:latest', cat: 'general', name: 'Llama 3.1 8B Abliterated（社区）', diskGB: 4.7, ramGB: 5.5, src: 'community', license: 'Llama 3.1 Community License',
    blurbZh: '社区注册表（mannix）：去拒答微调版，非官方出品', blurbEn: 'Community registry (mannix): abliterated fine-tune, not an official build',
  },
  /* ---- reasoning ---- */
  {
    tag: 'deepseek-r1:7b', cat: 'reasoning', name: 'DeepSeek-R1 7B', diskGB: 4.7, ramGB: 5.5, src: 'ollama', license: 'MIT',
    blurbZh: 'R1 蒸馏小杯：会打草稿的推理模型', blurbEn: 'R1 distilled, small: a reasoning model that shows its work',
  },
  {
    tag: 'deepseek-r1:14b', cat: 'reasoning', name: 'DeepSeek-R1 14B', diskGB: 9, ramGB: 10, src: 'ollama', license: 'MIT',
    blurbZh: 'R1 蒸馏中杯：数学/逻辑明显更强', blurbEn: 'R1 distilled, mid: clearly stronger math and logic',
  },
  {
    tag: 'deepseek-r1:32b', cat: 'reasoning', name: 'DeepSeek-R1 32B', diskGB: 19.9, ramGB: 21, src: 'ollama', license: 'MIT',
    blurbZh: 'R1 蒸馏大杯：本地推理强档，就是慢', blurbEn: 'R1 distilled, large: strong local reasoning, just slow',
  },
  {
    tag: 'deepseek-r1:1.5b', cat: 'reasoning', name: 'DeepSeek-R1 1.5B', diskGB: 1.1, ramGB: 1.5, src: 'ollama', license: 'MIT',
    blurbZh: 'R1 蒸馏最小杯：推理入门体验', blurbEn: 'R1 distilled tiniest: a taste of reasoning',
  },
  {
    tag: 'deepseek-r1:8b', cat: 'reasoning', name: 'DeepSeek-R1 8B', diskGB: 5.2, ramGB: 6.2, src: 'ollama', license: 'MIT',
    blurbZh: 'R1 蒸馏 8B：小杯推理，性价比档', blurbEn: 'R1 distilled 8B: small reasoner, value pick',
  },
  {
    tag: 'qwq:32b', cat: 'reasoning', name: 'QwQ 32B', diskGB: 19.9, ramGB: 23.1, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义推理专长：长思维链，慢工出细活', blurbEn: 'Qwen\'s reasoning specialist: long chains, slow and thorough',
  },
  {
    tag: 'deepseek-r1:70b', cat: 'reasoning', name: 'DeepSeek-R1 70B', diskGB: 42.5, ramGB: 47, src: 'ollama', license: 'MIT',
    blurbZh: 'R1 蒸馏大杯：本地推理旗舰档', blurbEn: 'R1 distilled large: local reasoning flagship tier',
  },
  {
    tag: 'deepseek-r1:671b', cat: 'reasoning', name: 'DeepSeek-R1 671B', diskGB: 404.4, ramGB: 440, src: 'ollama', license: 'MIT',
    blurbZh: '满血 R1：本地最强推理，集群档', blurbEn: 'Full-size R1: the strongest local reasoner, cluster tier',
  },
  {
    tag: 'cogito-2.1:671b', cat: 'reasoning', name: 'Cogito 2.1 671B', diskGB: 1342.3, ramGB: 1400, src: 'ollama', license: 'MIT',
    blurbZh: 'DeepCogito 满血推理：1.3TB 全精度，纯集群玩具', blurbEn: 'DeepCogito full-size reasoner: 1.3TB full precision, cluster toy',
  },
  {
    tag: 'magistral:24b', cat: 'reasoning', name: 'Magistral 24B', diskGB: 14.3, ramGB: 16, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Mistral 推理专长：链式思考稳', blurbEn: 'Mistral\'s reasoning specialist: steady chain-of-thought',
  },
  {
    tag: 'phi4-reasoning:14b', cat: 'reasoning', name: 'Phi-4 Reasoning 14B', diskGB: 11.1, ramGB: 12.5, src: 'ollama', license: 'MIT',
    blurbZh: '微软推理版 Phi-4：数学与逻辑专长', blurbEn: 'Microsoft\'s reasoning Phi-4: math and logic specialist',
  },
  {
    tag: 'nemotron-3-super:120b', cat: 'reasoning', name: 'Nemotron 3 Super 120B', diskGB: 86.8, ramGB: 95, src: 'ollama', license: 'NVIDIA Nemotron Open Model License',
    blurbZh: 'NVIDIA 旗舰：为多 Agent 协作与推理调校，给大机器', blurbEn: 'NVIDIA\'s flagship: tuned for multi-agent work and reasoning, big machines',
  },
  {
    tag: 'phi4-mini-reasoning:3.8b', cat: 'reasoning', name: 'Phi-4 Mini Reasoning 3.8B', diskGB: 3.2, ramGB: 3.8, src: 'ollama', license: 'MIT',
    blurbZh: '微软推理小杯：数学专长，体积小', blurbEn: 'Microsoft\'s small reasoner: math-leaning, compact',
  },
  {
    tag: 'marco-o1:7b', cat: 'reasoning', name: 'Marco-o1 7B', diskGB: 4.7, ramGB: 5.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '阿里国际的 o1 路线探索款', blurbEn: 'Alibaba AIDC\'s o1-style explorer',
  },
  {
    tag: 'openthinker:7b', cat: 'reasoning', name: 'OpenThinker 7B', diskGB: 4.7, ramGB: 5.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '开源思维链数据训出的推理款', blurbEn: 'Reasoner trained on open chain-of-thought data',
  },
  {
    tag: 'openthinker:32b', cat: 'reasoning', name: 'OpenThinker 32B', diskGB: 19.9, ramGB: 23, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'OpenThinker 强档：开放数据推理', blurbEn: 'OpenThinker strong tier: open-data reasoning',
  },
  {
    tag: 'exaone-deep:7.8b', cat: 'reasoning', name: 'EXAONE-Deep 7.8B', diskGB: 4.8, ramGB: 5.6, src: 'ollama', license: 'EXAONE License',
    blurbZh: 'LG 的推理专长款：英/韩双语', blurbEn: 'LG\'s reasoning specialist: EN/KO bilingual',
  },
  {
    tag: 'exaone-deep:32b', cat: 'reasoning', name: 'EXAONE-Deep 32B', diskGB: 19.3, ramGB: 22, src: 'ollama', license: 'EXAONE License',
    blurbZh: 'EXAONE-Deep 强档：慢思考', blurbEn: 'EXAONE-Deep strong tier: slow thinking',
  },
  {
    tag: 'hf.co/unsloth/DeepSeek-R1-0528-Qwen3-8B-GGUF:Q4_K_M', cat: 'reasoning', name: 'DeepSeek-R1-0528-Qwen3-8B (HF GGUF)', diskGB: 5, ramGB: 5.9, src: 'hf', license: 'MIT',
    blurbZh: 'HF 社区量化（unsloth）：0528 版 R1 蒸到 Qwen3-8B', blurbEn: 'HF community quant (unsloth): the 0528 R1 distilled into Qwen3-8B',
  },
  {
    tag: 'huihui_ai/deepseek-r1-abliterated:8b', cat: 'reasoning', name: 'DeepSeek-R1 8B Abliterated（社区）', diskGB: 5, ramGB: 5.9, src: 'community', license: 'MIT',
    blurbZh: '社区注册表（huihui_ai）：R1 蒸馏去拒答版，非官方出品', blurbEn: 'Community registry (huihui_ai): abliterated R1 distill, not an official build',
  },
  /* ---- vision ---- */
  {
    tag: 'qwen3-vl:30b', cat: 'vision', name: 'Qwen3-VL 30B (MoE)', diskGB: 19.6, ramGB: 21, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Qwen3 视觉的 MoE 档：看图快、答得细', blurbEn: 'Qwen3 vision\'s MoE tier: fast eyes, detailed answers',
  },
  {
    tag: 'qwen2.5vl:7b', cat: 'vision', name: 'Qwen2.5-VL 7B', diskGB: 6, ramGB: 7, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '能看图：截图、照片、文档图都能读', blurbEn: 'Can see: reads screenshots, photos and document images',
  },
  {
    tag: 'qwen2.5vl:32b', cat: 'vision', name: 'Qwen2.5-VL 32B', diskGB: 21.2, ramGB: 23, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '看图强档：细粒度识别与文档理解', blurbEn: 'Strong vision: fine-grained recognition and document understanding',
  },
  {
    tag: 'llava:13b', cat: 'vision', name: 'LLaVA 13B', diskGB: 8, ramGB: 9, src: 'ollama', license: 'Llama 2 Community License',
    blurbZh: '经典视觉模型：看图聊天、描述图片', blurbEn: 'The classic vision model: image chat and description',
  },
  {
    tag: 'moondream:1.8b', cat: 'vision', name: 'Moondream 1.8B', diskGB: 1.7, ramGB: 2.1, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '极轻视觉：看图描述飞快', blurbEn: 'Featherweight vision: fast image description',
  },
  {
    tag: 'qwen2.5vl:3b', cat: 'vision', name: 'Qwen2.5-VL 3B', diskGB: 3.2, ramGB: 3.9, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义视觉小杯：截图/文档入门档', blurbEn: 'Qwen vision small: screenshots and documents, starter tier',
  },
  {
    tag: 'llava:7b', cat: 'vision', name: 'LLaVA 7B', diskGB: 4.7, ramGB: 5.6, src: 'ollama', license: 'Llama 2 Community License',
    blurbZh: '经典视觉小杯：看图聊天', blurbEn: 'Classic vision small: image chat',
  },
  {
    tag: 'llava-llama3:8b', cat: 'vision', name: 'LLaVA-Llama3 8B', diskGB: 5.6, ramGB: 6.5, src: 'ollama', license: 'Llama 3 Community License',
    blurbZh: 'LLaVA 的 Llama3 版：看图更聪明', blurbEn: 'LLaVA on Llama 3: smarter image chat',
  },
  {
    tag: 'minicpm-v:8b', cat: 'vision', name: 'MiniCPM-V 8B', diskGB: 5.5, ramGB: 6.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '面壁开源视觉：小体积，OCR 能打', blurbEn: 'OpenBMB\'s vision model: small, strong OCR',
  },
  {
    tag: 'llama3.2-vision:11b', cat: 'vision', name: 'Llama 3.2 Vision 11B', diskGB: 7.8, ramGB: 9.2, src: 'ollama', license: 'Llama 3.2 Community License',
    blurbZh: 'Meta 视觉款：看图 + 通用兼顾', blurbEn: 'Meta\'s vision model: images plus general chat',
  },
  {
    tag: 'llama3.2-vision:90b', cat: 'vision', name: 'Llama 3.2 Vision 90B', diskGB: 54.6, ramGB: 60, src: 'ollama', license: 'Llama 3.2 Community License',
    blurbZh: 'Meta 视觉大杯：给大机器', blurbEn: 'Meta\'s big vision model: big machines',
  },
  {
    tag: 'qwen3-vl:2b', cat: 'vision', name: 'Qwen3-VL 2B', diskGB: 1.9, ramGB: 2.4, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义新代视觉小杯：截图/文档入门', blurbEn: 'New-gen Qwen vision small: screenshots and documents, starter tier',
  },
  {
    tag: 'qwen3-vl:4b', cat: 'vision', name: 'Qwen3-VL 4B', diskGB: 3.3, ramGB: 4.1, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义新代视觉中杯：OCR 与界面理解更强', blurbEn: 'New-gen Qwen vision mid: stronger OCR and UI understanding',
  },
  {
    tag: 'qwen3-vl:8b', cat: 'vision', name: 'Qwen3-VL 8B', diskGB: 6.2, ramGB: 7.3, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义新代视觉主力：看图干活的均衡档', blurbEn: 'New-gen Qwen vision workhorse: the balanced pick for image work',
  },
  {
    tag: 'qwen3-vl:32b', cat: 'vision', name: 'Qwen3-VL 32B', diskGB: 20.9, ramGB: 23, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义新代视觉强档：细粒度识别与文档理解', blurbEn: 'New-gen Qwen vision strong tier: fine-grained recognition and documents',
  },
  {
    tag: 'qwen3-vl:235b', cat: 'vision', name: 'Qwen3-VL 235B (MoE)', diskGB: 143.3, ramGB: 156, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义视觉旗舰 MoE：给大内存机器', blurbEn: 'Qwen vision flagship MoE: big-RAM machines',
  },
  {
    tag: 'deepseek-ocr:3b', cat: 'vision', name: 'DeepSeek-OCR 3B', diskGB: 6.7, ramGB: 7.8, src: 'ollama', license: 'MIT',
    blurbZh: 'DeepSeek 的 OCR 专长：文档转文字、版面解析（体积含视觉塔）', blurbEn: 'DeepSeek\'s OCR specialist: documents to text, layout parsing (size includes the vision tower)',
  },
  {
    tag: 'qwen2.5vl:72b', cat: 'vision', name: 'Qwen2.5-VL 72B', diskGB: 48.7, ramGB: 54, src: 'ollama', license: 'Tongyi Qianwen License',
    blurbZh: '通义视觉旗舰：文档与细粒度识别最强档', blurbEn: 'Qwen vision flagship: documents and fine-grained recognition',
  },
  {
    tag: 'bakllava:7b', cat: 'vision', name: 'BakLLaVA 7B', diskGB: 4.7, ramGB: 5.6, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '社区视觉老将：Mistral 底子的看图聊天', blurbEn: 'Community vision veteran: Mistral-based image chat',
  },
  {
    tag: 'granite3.2-vision:2b', cat: 'vision', name: 'Granite 3.2 Vision 2B', diskGB: 2.4, ramGB: 3, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'IBM 视觉小杯：文档理解入门', blurbEn: 'IBM\'s small vision model: document understanding, starter tier',
  },
  {
    tag: 'huihui_ai/qwen3-vl-abliterated:8b', cat: 'vision', name: 'Qwen3-VL 8B Abliterated（社区）', diskGB: 6.1, ramGB: 7.2, src: 'community', license: 'Apache-2.0',
    blurbZh: '社区注册表（huihui_ai）：视觉款去拒答版，非官方出品', blurbEn: 'Community registry (huihui_ai): abliterated vision build, not an official build',
  },
  /* ---- embed ---- */
  {
    tag: 'nomic-embed-text:latest', cat: 'embed', name: 'Nomic Embed Text', diskGB: 0.3, ramGB: 0.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '向量检索经典款：给文档做嵌入的老将', blurbEn: 'The embedding classic: a veteran for document vectors',
  },
  {
    tag: 'nomic-embed-text-v2-moe:latest', cat: 'embed', name: 'Nomic Embed Text v2 MoE', diskGB: 1, ramGB: 1.2, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Nomic 新代多语言嵌入：MoE 架构', blurbEn: 'Nomic\'s new multilingual embedder: MoE architecture',
  },
  {
    tag: 'bge-m3:latest', cat: 'embed', name: 'BGE-M3', diskGB: 1.2, ramGB: 1.5, src: 'ollama', license: 'MIT',
    blurbZh: '智源多语言嵌入：多粒度检索，中文强', blurbEn: 'BAAI\'s multilingual embedder: multi-granularity retrieval, strong Chinese',
  },
  {
    tag: 'bge-large:335m', cat: 'embed', name: 'BGE-Large-EN 335M', diskGB: 0.7, ramGB: 0.9, src: 'ollama', license: 'MIT',
    blurbZh: '智源英文嵌入大杯：英文检索稳', blurbEn: 'BAAI\'s English embedder, large: steady English retrieval',
  },
  {
    tag: 'mxbai-embed-large:335m', cat: 'embed', name: 'Mxbai Embed Large 335M', diskGB: 0.7, ramGB: 0.9, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Mixedbread 英文嵌入：检索口碑款', blurbEn: 'Mixedbread\'s English embedder: well-reviewed retrieval',
  },
  {
    tag: 'snowflake-arctic-embed:335m', cat: 'embed', name: 'Snowflake Arctic Embed L', diskGB: 0.7, ramGB: 0.9, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Snowflake 企业向嵌入大杯', blurbEn: 'Snowflake\'s enterprise embedder, large',
  },
  {
    tag: 'snowflake-arctic-embed:137m', cat: 'embed', name: 'Snowflake Arctic Embed M', diskGB: 0.3, ramGB: 0.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Arctic Embed 中杯：轻量检索', blurbEn: 'Arctic Embed mid: light retrieval',
  },
  {
    tag: 'snowflake-arctic-embed:22m', cat: 'embed', name: 'Snowflake Arctic Embed XS', diskGB: 0.1, ramGB: 0.3, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Arctic Embed 极小杯：边缘档', blurbEn: 'Arctic Embed micro: edge tier',
  },
  {
    tag: 'snowflake-arctic-embed2:latest', cat: 'embed', name: 'Snowflake Arctic Embed 2.0', diskGB: 1.2, ramGB: 1.5, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'Arctic Embed 二代：多语言检索', blurbEn: 'Arctic Embed gen 2: multilingual retrieval',
  },
  {
    tag: 'all-minilm:22m', cat: 'embed', name: 'All-MiniLM-L6 22M', diskGB: 0.1, ramGB: 0.3, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '句子嵌入鼻祖小杯：极轻、极快', blurbEn: 'The sentence-embedding ancestor, small: featherweight and fast',
  },
  {
    tag: 'all-minilm:33m', cat: 'embed', name: 'All-MiniLM-L12 33M', diskGB: 0.1, ramGB: 0.3, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'MiniLM 大杯：比 L6 稍准，仍然极轻', blurbEn: 'MiniLM large: a bit sharper than L6, still featherweight',
  },
  {
    tag: 'embeddinggemma:300m', cat: 'embed', name: 'EmbeddingGemma 300M', diskGB: 0.6, ramGB: 0.9, src: 'ollama', license: 'Gemma Terms',
    blurbZh: 'Google 端侧嵌入：多语言、离线友好', blurbEn: 'Google\'s on-device embedder: multilingual, offline-friendly',
  },
  {
    tag: 'qwen3-embedding:0.6b', cat: 'embed', name: 'Qwen3 Embedding 0.6B', diskGB: 0.6, ramGB: 0.9, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义新代嵌入小杯：多语言检索', blurbEn: 'Qwen\'s new embedder, small: multilingual retrieval',
  },
  {
    tag: 'qwen3-embedding:4b', cat: 'embed', name: 'Qwen3 Embedding 4B', diskGB: 2.5, ramGB: 3, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义嵌入中杯：精度与体积均衡', blurbEn: 'Qwen embedder mid: accuracy/size balance',
  },
  {
    tag: 'qwen3-embedding:8b', cat: 'embed', name: 'Qwen3 Embedding 8B', diskGB: 4.7, ramGB: 5.6, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '通义嵌入旗舰：检索精度档', blurbEn: 'Qwen\'s embedding flagship: the accuracy tier',
  },
  {
    tag: 'paraphrase-multilingual:278m', cat: 'embed', name: 'Paraphrase Multilingual 278M', diskGB: 0.6, ramGB: 0.8, src: 'ollama', license: 'Apache-2.0',
    blurbZh: '50+ 语言的句子嵌入：多语言老牌', blurbEn: 'Sentence embeddings for 50+ languages: the multilingual veteran',
  },
  {
    tag: 'granite-embedding:278m', cat: 'embed', name: 'Granite Embedding 278M', diskGB: 0.6, ramGB: 0.8, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'IBM 多语言嵌入：企业向检索', blurbEn: 'IBM\'s multilingual embedder: enterprise retrieval',
  },
  {
    tag: 'granite-embedding:30m', cat: 'embed', name: 'Granite Embedding 30M', diskGB: 0.1, ramGB: 0.3, src: 'ollama', license: 'Apache-2.0',
    blurbZh: 'IBM 英文嵌入极小杯：边缘档', blurbEn: 'IBM\'s English embedder, micro: edge tier',
  },
  {
    tag: 'jeffh/intfloat-multilingual-e5-large-instruct:f16', cat: 'embed', name: 'Multilingual E5 Large Instruct（社区）', diskGB: 1.1, ramGB: 1.5, src: 'community', license: 'MIT',
    blurbZh: '社区注册表（jeffh）：微软 E5 多语言指令嵌入', blurbEn: 'Community registry (jeffh): Microsoft\'s E5 multilingual instruct embedder',
  },
];

export function getLocalModel(tag) {
  return LOCAL_MODELS.find((m) => m.tag === tag) || null;
}

// Fit bucket for a box with `ramGB` of usable RAM: the model's own
// ramGB estimate decides. 'smooth' fits comfortably, 'tight' fits
// but leaves little headroom, 'over' will not run sanely.
export function fitFor(ramGB) {
  if (ramGB <= 2.6) return 'smooth';
  if (ramGB <= 4.2) return 'tight';
  return 'over';
}
