# Starts-Agents

**在聊天软件里养一支 AI 机器人团队 —— 一个本地优先的起步实现。**

侧边栏里不是联系人，而是一个个机器人：各自有人设、记忆、模型和工具。
你像聊天一样使唤它们，看着它们干活，危险动作先弹卡问你。

这是为「从零理解并亲手长出一个 agent 团队产品」准备的起步代码：
零依赖（只要 Node 22+）、本地运行、开箱能聊。设计说明见
[docs/architecture.md](docs/architecture.md)。

```
Web UI ──HTTP/SSE──▶ Harness ──▶ Engines（echo / openai / claude-cli，可插拔）
                        │
                        ├─────▶ Tools（ safe 直接跑 / ask 先过审批 ）
                        └─────▶ Approvals（审批卡：人点了 Allow 才执行）
```

## 快速开始

```bash
node src/server.js
# 打开 http://127.0.0.1:8797
```

不需要任何密钥：默认的 **echo 引擎**离线可用，它就是用来学系统的——试着发：

- `list files` — 列工作区文件（安全工具，直接执行）
- `read <文件名>` — 读工作区里的文件
- `note <内容>` — 记到这个机器人的笔记本
- `run ls -la` — **会先弹审批卡**，你点了 Allow 它才真的执行

## 换上真的大脑

引擎是驱动，一个文件一个脑（`src/engines.js`）：

| 引擎 | 说明 |
|---|---|
| `echo` | 离线演示脑，无需密钥，学系统用 |
| `openai` | 任何 OpenAI 兼容接口（OpenAI / OpenRouter / DeepSeek / 本地 llama.cpp 等） |
| `claude-cli` | 调用本机已登录的 `claude` CLI，用你自己的订阅 |

```bash
START_AGENTS_AI_API_KEY=sk-... \
START_AGENTS_AI_BASE_URL=https://api.openai.com/v1 \
START_AGENTS_AI_MODEL=gpt-4o-mini \
node src/server.js
```

新增一个引擎（Codex、Grok、自训模型……）：照着 `claude-cli` 驱动抄一份，
在 `ENGINES` 里注册一行，完事。

## 团队 = 一个 Markdown 文件

整支团队（名字/引擎/模型/人设/共同守则）可以打包成一个 `.md` 文件分享、
导入、版本管理，**不带任何密钥和聊天记录**。示例见
[teams/example-team.md](teams/example-team.md)，格式见
[docs/teams.md](docs/teams.md)。UI 左下角可导入/导出。

## 写代码是主场

这不是聊天玩具：机器人有自己独立的项目工作区和一整套代码工具——

- **安全工具（直接执行）**：`list_files`、`read_file`、`search_text`（全仓搜索）
- **审批工具（弹卡批准才执行）**：`write_file`（整文件写）、`edit_file`（精确块替换）、`run_shell`（跑测试/git，30 秒限）
- 审批卡带 **diff 预览**：改哪几行先给你看；还有「本会话全放行」——
  连环改文件时不用逐张点，重启服务即收回
- 工具循环最多 25 轮：读代码 → 改 → 跑测试 → 看报错 → 再改，一气呵成

## 模型：强开源优先，密钥加密保管

「⚙ Models」里添加供应商，预设对着当前第一梯队的开源权重模型：
**DeepSeek、Qwen3-Coder（DashScope）、Kimi K2（Moonshot）、GLM（智谱）**，
另有 OpenRouter 聚合、本机 Ollama、任意自定义兼容接口，模型名可改。

- API key 经 **AES-256-GCM 加密**存盘（主密钥在环境变量或 0600 密钥文件里），
  界面只回显掩码，日志里也不落明文——明文只在发起请求的那一瞬间存在于内存
- 链路直连供应商，**没有 Composio/中转之类的第三方经手**你的 key 和代码
- 每次工具执行、每次审批决定都记入 `data/audit.log`，设置页可看最近动态

## 安全模型（一句话版）

模型只能**提议**，只有人能**批准**：每个工具都声明风险等级，
改状态的工具必须过审批卡（5 分钟无人理自动拒绝）；
文件工具被关在该机器人的工作区里出不去。加新工具时请守住这条线。

## 本地模型：不拉 API 也能跑

不想用任何云 API？在服务器上装一个开源权重模型，数据不出机器：

```bash
sudo bash scripts/setup-local-model.sh            # 默认 qwen2.5-coder:1.5b
pm2 restart starts-agents                          # 重启后自动识别
```

脚本装 Ollama、拉模型、并把占用管住（单并发、闲置 5 分钟自动卸载释放内存）。
应用启动时探测到 Ollama 会**自动注册**「本地模型 · Ollama」供应商并把 Coder 指过去，
零配置。选型按内存诚实说：

| 模型 | 磁盘（下载占用） | 内存（回答时占用） | 适合 |
|---|---|---|---|
| qwen2.5-coder:1.5b | 1.0 GB | ~1.2 GB | **演示档**，内存紧时的默认 |
| qwen2.5-coder:7b | 4.7 GB | ~5.5 GB | **能用起步**：简单多步任务可完成 |
| qwen3-coder:30b | 19 GB | ~20 GB | **本地真干活**：仓库级理解 + 可靠工具调用 |
| qwen3.6:27b | 17 GB | ~18 GB | 本地强档，综合代码能力出色 |

两个数别混：**磁盘**是模型文件躺着占的硬盘（下完就不变了）；
**内存（RAM）**是它回答问题时要占的运行内存——本机是 CPU 跑，
权重全装进内存再加 KV cache。脚本给 Ollama 设了闲置 5 分钟自动卸载，
不用的时候内存会还回来。装好后也可以在 App 的「⚙ 模型设置 →
本地模型」里直接下载/切换这 8 个选项，不用再敲命令。

也要有预期：本地小模型在多步写代码、连续工具调用上明显弱于
DeepSeek / Qwen3-Coder 这类 API 大模型，CPU 推理也慢些——
小活、离线、隐私场景用本地，重活给某个机器人单独挂 API 供应商即可，两边不冲突。

## 手机上用：子域名 + PWA

把 harness 跑在服务器上、前面挂一个子域名，手机浏览器打开后
「添加到主屏幕」就是一个独立 App（全屏、图标、离线外壳）：

1. **DNS**：给子域名（如 `agents.example.com`）加一条 A 记录指向服务器。
2. **反向代理**：把该子域名转发到 `127.0.0.1:8797`（nginx 示例：
   `proxy_pass http://127.0.0.1:8797;`，记得带 `proxy_set_header Host $host;`，
   SSE 需要 `proxy_buffering off;`）。
3. **启动**（务必设访问口令，见下）：
   ```bash
   START_AGENTS_ACCESS_TOKEN='换成你自己的长口令' pm2 start src/server.js --name starts-agents
   ```
4. 手机打开子域名 → 输一次口令（此后这台设备免输）→ 分享菜单
   「添加到主屏幕」。

**资源占用**：harness 本身是零依赖 Node 进程，空闲内存约几十 MB，
对话时也不会涨到哪去——算力都在引擎那头。真吃内存的是「在服务器
本地跑模型 / 给每个 bot 开虚拟机」，那种玩法别往小内存机器上放；
引擎走 API 就完全没这个问题。

## ⚠️ 公开部署必须设口令

`START_AGENTS_ACCESS_TOKEN` 不设 = 只有本机能用（默认绑定 127.0.0.1）。
一旦经子域名公开，**必须**设口令：否则任何人打开页面都能点
Allow 让机器人在你服务器上执行 shell 命令——审批卡防的是模型，
防不了陌生人。口令经 `/api/login` 换成一年期 HttpOnly cookie，
存在每台设备上，输一次即可。

## 现状与路线

v0.4（显示名 **Complay Ai**）：在 v0.3（代码工具集、多供应商加密保险库、
PWA、15 种语言、Complay「C」品牌）之上，按开源 Agent 的成熟做法
（OpenHands / aider / Cline / SWE-agent 等，逐项出处见
docs/agent-design.md）把骨架升级成**真 Agent**：

- **Agent 工作协议**：服务端每轮注入——先探索、先计划、小步完整、
  **必须真的跑起来验证**、出错迭代、打包交付；闲聊不动工具。
- **上下文先行**：每轮附带工作区文件树（RepoMap 轻量版）。
- **任务清单**：`update_tasks` 工具 + 聊天顶部清单条，长任务进度可见、落盘可续。
- **停滞熔断**：工具连续失败 3 次，系统打断并要求换思路或汇报卡点。
- **部署包交付**：`package_project` 把项目打成 zip，聊天里出下载卡片；
  聊天头 📦 也可手动打包。写出来不算完，**能下载、能跑，才算交付**。
- 小模型兼容：文本版工具调用拦截执行、空回复兜底说明（v0.3.2/0.3.3）。

刻意还没做的（以及该在哪下手）写在 architecture 文档末尾：
每 bot 一台电脑、群聊房间与路由、定时/webhook 触发。

## License

MIT
