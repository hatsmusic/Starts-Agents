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
    hint: 'DeepSeek V3.2/V4 一线代码与推理，价格只有闭源前线的零头，工具调用稳。深度推理可选 deepseek-reasoner。',
  },
  {
    id: 'qwen', label: 'Qwen · 通义千问 (DashScope)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-coder-plus',
    hint: 'Qwen3-Coder 家族是开源代码模型第一梯队，工具调用可靠；通用可选 qwen3-max。',
  },
  {
    id: 'kimi', label: 'Kimi · Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview',
    hint: 'Kimi K2 系列为长程 agentic 任务而生；控制台有更新型号（如 K2.5）时把模型名换掉即可。长上下文。',
  },
  {
    id: 'glm', label: 'GLM · 智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6',
    hint: 'GLM 的长项是长时间、多步骤的 agent 会话稳定性（4.6 起，5.x 更强）；国产开源权重。',
  },
  {
    id: 'openrouter', label: 'OpenRouter (聚合)',
    baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder',
    hint: '一个 key 试遍各家开源权重（Qwen3-Coder / DeepSeek / GLM / Kimi / gpt-oss 等）；模型名按 OpenRouter 目录填。',
  },
  {
    id: 'ollama', label: 'Ollama (本机/局域网)',
    baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-coder:30b',
    hint: '本地跑的开源模型，不需要 key。能干活从 7B 起步，30B 级才真正像个 agent；1.5B 只是演示档。内存不够别硬塞。',
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
