// Provider catalog (v0.16.0, item 135): every supported provider is a
// first-class entry — its own tile in Settings, its own connect page —
// instead of a preset buried in one generic form. The generic form
// survives only as the last entry ('custom'), the fallback for any
// OpenAI-compatible endpoint not listed here.
//
// `protocol` is the provider's NATIVE wire format (what the house is
// known for); `protocols` lists every format its endpoints speak.
// The servable baseUrl is ALWAYS the provider's official
// OpenAI-compatible endpoint (Anthropic, Google and Vertex all publish
// one), because the harness's only API driver speaks that shape — the
// protocol field is honest labelling and is stored on the provider
// row, it does not switch the driver. baseUrls were verified against
// the providers' own documentation on 2026-11-10 (see the batch
// report for the per-entry sources); Vertex is the one template: its
// OpenAI-compatible endpoint embeds the GCP project and location, so
// the default carries {project}/{location} placeholders the user
// replaces on the connect page, and its "key" is a short-lived
// OAuth2 access token, not a static API key (accessType: 'token').

export const CAP_KEYS = ['image', 'video', 'voice', 'ocr', 'embed', 'search'];
export const PROTOCOLS = ['openai', 'claude', 'gemini', 'vertex'];

export const PROVIDER_CATALOG = [
  {
    id: 'minimax', labelZh: 'MiniMax', labelEn: 'MiniMax',
    accessType: 'api-key', protocol: 'openai', protocols: ['openai', 'claude'],
    baseUrl: 'https://api.minimax.io/v1', consoleUrl: 'https://platform.minimax.io',
    models: ['MiniMax-M3', 'MiniMax-M3.1-Flash'],
    monogram: 'MM', color: '#e5484d', presetId: null,
    hintZh: '国际站端点。中国大陆账号请把地址改为 https://api.minimaxi.com/v1（控制台 platform.minimaxi.com）。同一密钥也提供 Anthropic 兼容端点。',
    hintEn: 'Global endpoint. Mainland-China accounts: change the URL to https://api.minimaxi.com/v1 (console: platform.minimaxi.com). The same key also serves an Anthropic-compatible endpoint.',
  },
  {
    id: 'openai', labelZh: 'OpenAI', labelEn: 'OpenAI',
    accessType: 'api-key', protocol: 'openai', protocols: ['openai'],
    baseUrl: 'https://api.openai.com/v1', consoleUrl: 'https://platform.openai.com',
    models: ['gpt-5', 'gpt-4o', 'gpt-4o-mini'],
    monogram: 'AI', color: '#10a37f', presetId: null,
    hintZh: 'OpenAI 官方 API，格式即本平台的原生驱动格式。',
    hintEn: 'The official OpenAI API — its format is the one this harness drives natively.',
  },
  {
    id: 'openrouter', labelZh: 'OpenRouter（聚合）', labelEn: 'OpenRouter (aggregator)',
    accessType: 'api-key', protocol: 'openai', protocols: ['openai'],
    baseUrl: 'https://openrouter.ai/api/v1', consoleUrl: 'https://openrouter.ai',
    models: ['qwen/qwen3-coder', 'deepseek/deepseek-chat', 'moonshotai/kimi-k2', 'openai/gpt-oss-120b'],
    monogram: 'OR', color: '#6467f2', presetId: 'openrouter',
    hintZh: '一个 key 试遍各家模型；模型名按 OpenRouter 目录填（带厂商前缀）。',
    hintEn: 'One key reaches many vendors; model ids follow the OpenRouter catalogue (vendor-prefixed).',
  },
  {
    id: 'opencode-zen', labelZh: 'OpenCode Zen', labelEn: 'OpenCode Zen',
    accessType: 'api-key', protocol: 'openai', protocols: ['openai', 'claude', 'gemini'],
    baseUrl: 'https://opencode.ai/zen/v1', consoleUrl: 'https://opencode.ai/auth',
    models: ['qwen3-coder', 'kimi-k2', 'big-pickle'],
    monogram: 'OZ', color: '#8a63d2', presetId: null,
    hintZh: 'OpenCode 团队的精选模型网关，一个 key 按量调用多家模型；不同模型在 Zen 内部走各自的原生格式，对外统一此端点。订阅版 OpenCode Go 的地址是 https://opencode.ai/zen/go/v1，可按需改。',
    hintEn: 'The OpenCode team’s curated pay-per-use gateway: one key, many vendors. Zen routes each model over its native format internally; this endpoint is the uniform door. The subscription tier (OpenCode Go) lives at https://opencode.ai/zen/go/v1 if you prefer it.',
  },
  {
    id: 'anthropic', labelZh: 'Anthropic (Claude)', labelEn: 'Anthropic (Claude)',
    accessType: 'api-key', protocol: 'claude', protocols: ['claude', 'openai'],
    baseUrl: 'https://api.anthropic.com/v1', consoleUrl: 'https://console.anthropic.com',
    models: ['claude-sonnet-4-5', 'claude-sonnet-4', 'claude-haiku-4-5'],
    monogram: 'An', color: '#d97757', presetId: null,
    hintZh: '原生格式是 Claude Messages；此地址是 Anthropic 官方的 OpenAI 兼容端点（官方定位为测试/对比用途，工具调用可用）。订阅账号（Claude 订阅）不在这里填 key，见下方「订阅账号」区。',
    hintEn: 'Native format is Claude Messages; this URL is Anthropic’s official OpenAI-compatible endpoint (positioned by Anthropic for testing/comparison; tool calls work). A Claude subscription is NOT entered here — see the Subscription accounts section below.',
  },
  {
    id: 'google-aistudio', labelZh: 'Google AI Studio (Gemini)', labelEn: 'Google AI Studio (Gemini)',
    accessType: 'api-key', protocol: 'gemini', protocols: ['gemini', 'openai'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', consoleUrl: 'https://aistudio.google.com',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    monogram: 'Ge', color: '#4285f4', presetId: null,
    hintZh: '原生格式是 Gemini；此地址是 Google 官方的 OpenAI 兼容端点，用 AI Studio 的 API key（Bearer 方式）调用。',
    hintEn: 'Native format is Gemini; this URL is Google’s official OpenAI-compatible endpoint, called with an AI Studio API key as a Bearer token.',
  },
  {
    id: 'vertex', labelZh: 'Vertex AI (Google Cloud)', labelEn: 'Vertex AI (Google Cloud)',
    accessType: 'token', protocol: 'vertex', protocols: ['vertex', 'openai'],
    baseUrl: 'https://aiplatform.googleapis.com/v1beta1/projects/{project}/locations/{location}/endpoints/openapi',
    consoleUrl: 'https://console.cloud.google.com/vertex-ai',
    models: ['google/gemini-2.5-flash', 'google/gemini-2.5-pro'],
    monogram: 'Vx', color: '#34a853', presetId: null,
    hintZh: '企业级 GCP 入口：先把地址里的 {project} 与 {location} 换成你的项目与区域（如 us-central1）。Vertex 没有静态 API key，「密钥」欄填 OAuth2 访问令牌（gcloud auth print-access-token，约 1 小时过期，过期需更新）；模型名带 google/ 前缀。区域端点可把主机改为 {location}-aiplatform.googleapis.com。',
    hintEn: 'The enterprise GCP door: replace {project} and {location} in the URL with your project and region (e.g. us-central1). Vertex has no static API key — the key field takes an OAuth2 access token (gcloud auth print-access-token, ~1h lifetime, refresh when it expires). Model ids carry the google/ prefix. Regional hosts look like {location}-aiplatform.googleapis.com.',
  },
  {
    id: 'deepseek', labelZh: 'DeepSeek（深度求索）', labelEn: 'DeepSeek',
    accessType: 'api-key', protocol: 'openai', protocols: ['openai', 'claude'],
    baseUrl: 'https://api.deepseek.com/v1', consoleUrl: 'https://platform.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    monogram: 'DS', color: '#4d6bfe', presetId: 'deepseek',
    hintZh: 'DeepSeek V 系列一线代码与推理，工具调用稳；深度推理可选 deepseek-reasoner。也提供 Anthropic 兼容端点。',
    hintEn: 'Front-line coding and reasoning at a fraction of closed-source prices; deepseek-reasoner for deep reasoning. An Anthropic-compatible endpoint is also offered.',
  },
  {
    id: 'siliconflow', labelZh: '硅基流动 SiliconFlow', labelEn: 'SiliconFlow',
    accessType: 'api-key', protocol: 'openai', protocols: ['openai', 'claude'],
    baseUrl: 'https://api.siliconflow.cn/v1', consoleUrl: 'https://cloud.siliconflow.cn',
    models: ['deepseek-ai/DeepSeek-V4-Flash', 'Qwen/Qwen2.5-72B-Instruct'],
    monogram: 'SF', color: '#7c5cff', presetId: null,
    hintZh: '国内开源模型聚合平台，一个 key 调 DeepSeek/Qwen/GLM/Kimi 等；国际站地址为 https://api.siliconflow.com/v1。',
    hintEn: 'A hosted open-model platform: one key for DeepSeek/Qwen/GLM/Kimi and more. The international site uses https://api.siliconflow.com/v1.',
  },
  {
    id: 'moonshot', labelZh: 'Moonshot · Kimi', labelEn: 'Moonshot · Kimi',
    accessType: 'api-key', protocol: 'openai', protocols: ['openai', 'claude'],
    baseUrl: 'https://api.moonshot.cn/v1', consoleUrl: 'https://platform.moonshot.cn',
    models: ['kimi-k2-0711-preview', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    monogram: 'Ki', color: '#111827', presetId: 'kimi',
    hintZh: 'Kimi K2 系列为长程 agentic 任务而生，长上下文。国际站地址为 https://api.moonshot.ai/v1。也提供 Anthropic 兼容端点。',
    hintEn: 'The Kimi K2 family is built for long agentic runs with long context. International endpoint: https://api.moonshot.ai/v1. An Anthropic-compatible endpoint is also offered.',
  },
  {
    id: 'volcengine-ark', labelZh: '火山方舟（豆包）', labelEn: 'Volcengine Ark (Doubao)',
    accessType: 'api-key', protocol: 'openai', protocols: ['openai', 'claude'],
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', consoleUrl: 'https://console.volcengine.com/ark',
    models: ['doubao-seed-1-6-251015'],
    monogram: '方', color: '#e8590c', presetId: null,
    hintZh: '方舟的 model 字段通常填你在控制台创建的「推理接入点 ID」（ep- 开头），也可以填控制台列出的模型 ID；以控制台为准。Coding Plan 套餐请改用 https://ark.cn-beijing.volces.com/api/coding/v3 与套餐专属 key。',
    hintEn: 'Ark’s model field usually takes an inference endpoint ID you create in the console (ep-…), or a console-listed model ID — the console wins. Coding Plan subscriptions use https://ark.cn-beijing.volces.com/api/coding/v3 with their own key.',
  },
  {
    id: 'dashscope', labelZh: '阿里云百炼 · 通义千问', labelEn: 'Alibaba Bailian · Qwen (DashScope)',
    accessType: 'api-key', protocol: 'openai', protocols: ['openai', 'claude'],
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', consoleUrl: 'https://bailian.console.aliyun.com',
    models: ['qwen3-coder-plus', 'qwen3-coder-flash', 'qwen3-max', 'qwen-plus'],
    monogram: 'Qw', color: '#ff6a00', presetId: 'qwen',
    hintZh: 'Qwen3-Coder 家族是开源代码模型第一梯队，工具调用可靠；通用可选 qwen3-max。也提供 Anthropic 兼容端点。',
    hintEn: 'The Qwen3-Coder family leads the open coding models with reliable tool calls; qwen3-max for general work. An Anthropic-compatible endpoint is also offered.',
  },
  {
    id: 'bigmodel', labelZh: '智谱 BigModel · GLM', labelEn: 'Zhipu BigModel · GLM',
    accessType: 'api-key', protocol: 'openai', protocols: ['openai', 'claude'],
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', consoleUrl: 'https://open.bigmodel.cn',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air'],
    monogram: 'GL', color: '#2563eb', presetId: 'glm',
    hintZh: 'GLM 的长项是长时间、多步骤 agent 会话的稳定性。也提供 Anthropic 兼容端点。',
    hintEn: 'GLM’s strength is stability over long, multi-step agent sessions. An Anthropic-compatible endpoint is also offered.',
  },
  {
    id: 'qianfan', labelZh: '百度千帆（文心）', labelEn: 'Baidu Qianfan (ERNIE)',
    accessType: 'api-key', protocol: 'openai', protocols: ['openai'],
    baseUrl: 'https://qianfan.baidubce.com/v2', consoleUrl: 'https://console.bce.baidu.com/qianfan',
    models: ['ernie-4.5-turbo-128k', 'ernie-4.0-turbo-8k', 'deepseek-v3.2'],
    monogram: '千', color: '#2932e1', presetId: null,
    hintZh: '千帆 V2 接口完全兼容 OpenAI 标准；控制台创建 API Key 后填入（部分账号还需在请求头带 appid，本页暂不支持，见报告待裁项）。',
    hintEn: 'Qianfan’s V2 API is fully OpenAI-compatible; create an API key in the console. (Some accounts also need an appid header, not supported on this page yet — see the batch report.)',
  },
  {
    id: 'xiaomi-mimo', labelZh: 'Xiaomi MiMo', labelEn: 'Xiaomi MiMo',
    accessType: 'api-key', protocol: 'openai', protocols: ['openai', 'claude'],
    baseUrl: 'https://api.xiaomimimo.com/v1', consoleUrl: 'https://platform.xiaomimimo.com',
    models: [],
    monogram: 'Mi', color: '#ff6900', presetId: null,
    hintZh: '此为按量付费端点（sk- 开头的 key）。Token Plan 订阅请改用套餐页给出的专属地址（中国集群 https://token-plan-cn.xiaomimimo.com/v1，key 为 tp-/ttp- 开头）。模型 ID 以平台为准：保存 key 后点「拉取模型」获取准确列表。',
    hintEn: 'This is the pay-as-you-go endpoint (sk- keys). Token Plan subscriptions use the dedicated URL from the plan page (China cluster: https://token-plan-cn.xiaomimimo.com/v1, tp-/ttp- keys). Model ids follow the platform — save the key, then Fetch models for the exact list.',
  },
  {
    id: 'xai', labelZh: 'xAI (Grok)', labelEn: 'xAI (Grok)',
    accessType: 'api-key', protocol: 'openai', protocols: ['openai'],
    baseUrl: 'https://api.x.ai/v1', consoleUrl: 'https://console.x.ai',
    models: ['grok-4.3', 'grok-4'],
    monogram: 'X', color: '#111111', presetId: null,
    hintZh: 'Grok 家族的 OpenAI 兼容 API；Chat Completions 可用（官方主推 Responses API，本平台驱动走 Chat Completions）。',
    hintEn: 'The Grok family over an OpenAI-compatible API; Chat Completions works (xAI leads with the Responses API; this harness drives Chat Completions).',
  },
  {
    id: 'ollama', labelZh: 'Ollama（本机/局域网）', labelEn: 'Ollama (local / LAN)',
    accessType: 'local', protocol: 'openai', protocols: ['openai'],
    baseUrl: 'http://127.0.0.1:11434/v1', consoleUrl: 'https://ollama.com',
    models: ['qwen3-coder:30b', 'qwen2.5-coder:7b', 'qwen2.5-coder:1.5b'],
    monogram: 'Ol', color: '#5b5bd6', presetId: 'ollama',
    hintZh: '本地跑的开源模型，不需要 key。能干活从 7B 起步；本地模型管理（下载/切换）在下方「本地模型」卡里。',
    hintEn: 'Open models running on this machine — no key needed. Useful work starts around 7B; downloads and switching live in the Local models card below.',
  },
  {
    id: 'custom', labelZh: '自定义 OpenAI 兼容接口', labelEn: 'Custom OpenAI-compatible endpoint',
    accessType: 'api-key', protocol: 'openai', protocols: ['openai', 'claude', 'gemini', 'vertex'],
    baseUrl: '', consoleUrl: '',
    models: [],
    monogram: '+', color: '#64748b', presetId: 'custom',
    hintZh: '任何兼容 /chat/completions 的端点：自建推理、其他云厂商、网关等。目录里没有的供应商从这里接。',
    hintEn: 'Any endpoint speaking /chat/completions: self-hosted inference, other clouds, gateways. Providers not in the catalogue connect here.',
  },
];

export function getCatalogEntry(id) {
  return PROVIDER_CATALOG.find((e) => e.id === id) || null;
}

/* Capability slots (item 135): which of this provider's models serves
 * each non-chat capability. Values must name a model IN the provider's
 * list (or be empty = unassigned); anything else is dropped here, at
 * the single choke point both POST and PATCH pass through, so a stale
 * or foreign model id can never be stored. Returns null for
 * non-object input so callers can distinguish "not provided". */
export function sanitizeCaps(caps, models) {
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return null;
  const known = new Set((Array.isArray(models) ? models : []).map((m) => String(m)));
  const out = {};
  for (const k of CAP_KEYS) {
    const v = typeof caps[k] === 'string' ? caps[k].trim() : '';
    out[k] = v && known.has(v) ? v : '';
  }
  return out;
}

export function sanitizeProtocol(protocol, entry = null) {
  const p = String(protocol || '').trim().toLowerCase();
  if (PROTOCOLS.includes(p)) return p;
  return entry?.protocol || 'openai';
}
