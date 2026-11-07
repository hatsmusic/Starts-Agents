// Model provider presets — strong open-weight models first.
// Every preset is a plain OpenAI-compatible endpoint: your key goes
// straight from the vault to the provider. No middleman, no relay,
// no third-party session in between (that was the closed products'
// trick — and the open clone's quiet dependency — we don't do it).
// Model ids are the providers' current coding-strong offerings;
// they are editable per provider after creation.
export const PRESETS = [
  {
    id: 'deepseek', label: 'DeepSeek (深度求索)',
    baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    hint: 'DeepSeek V3 系列，代码与推理都强，价格低。深度推理可选 deepseek-reasoner。',
  },
  {
    id: 'qwen', label: 'Qwen · 通义千问 (DashScope)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-coder-plus',
    hint: 'Qwen3-Coder 是目前开源代码模型的第一梯队；通用可选 qwen3-max。',
  },
  {
    id: 'kimi', label: 'Kimi · Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview',
    hint: 'Kimi K2，开源 agentic 模型，工具调用与代码任务见长，长上下文。',
  },
  {
    id: 'glm', label: 'GLM · 智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6',
    hint: 'GLM-4.6，代码与 agent 任务优化，国产开源权重。',
  },
  {
    id: 'openrouter', label: 'OpenRouter (聚合)',
    baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat',
    hint: '一个 key 试遍各家（含 gpt-oss 等开源权重）；模型名按 OpenRouter 目录填。',
  },
  {
    id: 'ollama', label: 'Ollama (本机/局域网)',
    baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-coder',
    hint: '本地跑的开源模型，不需要 key。别和高内存服务挤同一台小机器。',
  },
  {
    id: 'custom', label: '自定义 OpenAI 兼容接口',
    baseUrl: '', model: '',
    hint: '任何兼容 /chat/completions 的端点：自建推理、其他云厂商等。',
  },
];

export function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || null;
}
