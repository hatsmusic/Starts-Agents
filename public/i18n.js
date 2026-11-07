// Starts-Agents UI languages. 15 languages, one flat dictionary each.
// Add a language = add one object. Missing keys fall back to English.
export const LANGS = [
  ['zh', '简体中文'], ['tw', '繁體中文'], ['en', 'English'], ['ja', '日本語'],
  ['ko', '한국어'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['ru', 'Русский'], ['pt', 'Português'], ['vi', 'Tiếng Việt'], ['th', 'ไทย'],
  ['id', 'Bahasa Indonesia'], ['ar', 'العربية'], ['hi', 'हिन्दी'],
];

const en = {
  newBot: 'New bot', models: '⚙ Models', importTeam: 'Import team', exportTeam: 'Export',
  pickBot: 'Pick a bot', send: 'Send', msgPh: 'Message…',
  tryHint: 'Try: list files · read <file> · note <text> · run <command> (asks first)',
  dNew: 'New bot', dEdit: 'Edit bot', fName: 'Name', fEngine: 'Engine', fProvider: 'Model provider',
  fModel: 'Model', fModelPh: '(provider default)', fPersona: 'Persona', fPersonaPh: 'Who is this bot? How should it work?',
  del: 'Delete', cancel: 'Cancel', save: 'Save',
  sTitle: 'Model providers', sHint: 'Keys are encrypted on the server and never shown in full again. Strong open-weight models first; every preset talks straight to the provider.',
  noProv: 'No providers yet — add one below. Bots on the API engine need a provider.',
  preset: 'Preset', pLabel: 'Label', pLabelPh: 'e.g. My DeepSeek', pBase: 'Base URL', pModel: 'Model',
  pKey: 'API key', pKeyPh: 'sk-… (optional for local Ollama)', addProv: 'Add provider', close: 'Close',
  audit: 'Recent activity', noAudit: 'Nothing yet.', keyYes: 'key', keyNo: 'no key (local endpoint)',
  provNone: '(none — env default)', notConf: ' (not configured)',
  lockHint: 'This deployment is protected. Enter the access token once — this device will remember it.',
  lockPh: 'Access token', unlock: 'Unlock', lockErr: 'That token did not work — try again.',
  apTitle: '🙋 Approval needed — ', allow: 'Allow', allowS: 'Allow all this session', deny: 'Deny',
  pkgTitle: 'Package this project into a deployment zip', pkgReady: '📦 Deployment package ready', pkgDl: 'Download', pkgFiles: 'files',
  lmTitle: 'Local models (Ollama)', lmHint: 'Open-weight models running on this machine — no API, no key. Two different numbers: disk is the download size; RAM is what it occupies while answering (auto-unloads after 5 idle minutes).',
  lmOff: 'Ollama not detected on this server. Install it with scripts/setup-local-model.sh, then reopen Settings.',
  lmUse: 'Use', lmUsing: 'In use', lmPull: 'Download', lmDel: 'Delete', lmDisk: 'disk', lmRam: 'RAM', lmPulling: 'Downloading…', lmFailed: 'Download failed — tap Download to resume',
  attach: 'Add photo / video / file', editAct: 'Edit', delConfirm: 'Sure?', attTooBig: 'Each file must be under 10 MB', attTooMany: 'Up to 6 files at a time',
  okOnce: '✓ Allowed once', okSession: '✓ Allowed for this session', denied: '✕ Denied',
  imported: 'Imported team "{name}" — {n} bot(s).', importFail: '⚠ Import failed: ',
  sessExp: 'Session locked — enter the access token again', noMsg: 'No messages yet',
  lockHintAcct: 'Sign in with your account. First time here? Create the admin account below.',
  lockNamePh: 'Account name', lockPassPh: 'Password (8+ characters)', loginBtn: 'Sign in',
  createAcct: 'Create admin account', setupHint: 'No accounts exist yet — this creates the first (admin) account.',
  lockUseToken: 'Use the access token instead', lockUseAcct: 'Use an account instead',
  searchPh: 'Search agents…', fAll: 'All',
  st_running: 'Running', st_awaiting_approval: 'Awaiting approval', st_idle: 'Standby', st_offline: 'Offline',
  online: 'online', wsCurrent: 'Current workspace', wsOpen: 'Open',
  qaTitle: 'Quick actions', qaNew: 'New task', qaTeam: 'Manage team', qaImport: 'Import project', qaTasks: 'Task center',
  tabTeam: 'Team', tabTasks: 'Tasks', tabWs: 'Workspace', tabSettings: 'Settings',
  tasksTitle: 'Task Center', refresh: 'Refresh', wsTitle2: 'Workspace', teamTitle: 'Team',
  tg_done: 'Completed', tg_failed: 'Failed', tg_cancelled: 'Cancelled', noTasks: 'No tasks yet — send an agent some work.',
  tStop: 'Stop', tRetry: 'Retry', tView: 'Open', stoppedNote: '⏹ Stopped.',
  errRetry: 'Retry', errCopy: 'Copy error', errCopied: 'Copied',
  wsEmpty: 'This workspace is empty.', wsTotals: '{files} files · {size}',
  acctTitle: 'Account', logout: 'Sign out', pwOldPh: 'Current password', pwNewPh: 'New password (8+ characters)', pwChange: 'Change password', pwOk: 'Password changed.',
  usersTitle: 'Accounts (owner only)', uAdd: 'Add account', roleMember: 'Member', roleOwner: 'Owner',
  meLine: '{name} · {role}', legacyNote: 'Signed in with the legacy access token. Create an account for a personal login; unset START_AGENTS_ACCESS_TOKEN on the server to retire the token.',
  volTitle: 'Volunteer Program', volDesc: 'No pay, no duties: join or leave any time, nothing is asked of you. Joined accounts are pre-registered with the volunteer quota tier — when the standalone built-in model launches and quotas begin, volunteers automatically get a larger quota.',
  volJoin: 'Join the volunteer program', volLeave: 'Leave the program', volJoined: 'You are a volunteer since {date} · quota tier: volunteer', volNot: 'Not joined yet · {n} volunteer(s) so far', volNeedAcct: 'Volunteering attaches to an account — create one first (sign out and register, or ask the owner to add you).',
  lmCat_code: 'Coding', lmCat_general: 'General', lmCat_reasoning: 'Reasoning', lmCat_vision: 'Vision',
  stopTitle: 'Stop generating', volBadge: 'Volunteer',

};

const zh = {
  newBot: '新建机器人', models: '⚙ 模型设置', importTeam: '导入团队', exportTeam: '导出',
  pickBot: '选择一个机器人', send: '发送', msgPh: '输入消息…',
  tryHint: '试试：list files 看工作区 · read 文件名 · note 记一笔 · run 命令（要审批）',
  dNew: '新建机器人', dEdit: '编辑机器人', fName: '名字', fEngine: '引擎', fProvider: '模型供应商',
  fModel: '模型', fModelPh: '（用供应商默认）', fPersona: '人设', fPersonaPh: '这个机器人是谁？应该怎么干活？',
  del: '删除', cancel: '取消', save: '保存',
  sTitle: '模型供应商', sHint: '密钥在服务器上加密保存，之后不再明文显示，只留掩码提示。强开源模型优先；所有预设都直连供应商，没有中间商。',
  noProv: '还没有供应商，在下面添加一个。用「API 模型」引擎的机器人需要先有供应商。',
  preset: '预设', pLabel: '名称', pLabelPh: '例如：我的 DeepSeek', pBase: '接口地址', pModel: '模型',
  pKey: 'API 密钥', pKeyPh: 'sk-…（本地 Ollama 可不填）', addProv: '添加供应商', close: '关闭',
  audit: '最近动态', noAudit: '暂无记录。', keyYes: '密钥', keyNo: '无密钥（本地端点）',
  provNone: '（不指定，用环境默认）', notConf: '（未配置）',
  lockHint: '这是一个受保护的部署。输入访问口令一次，这台设备之后免输。',
  lockPh: '访问口令', unlock: '解锁', lockErr: '口令不对，再试一次。',
  apTitle: '🙋 需要你批准 — ', allow: '允许', allowS: '本会话都允许', deny: '拒绝',
  pkgTitle: '把当前项目打包成部署包', pkgReady: '📦 部署包已生成', pkgDl: '下载', pkgFiles: '个文件',
  lmTitle: '本地模型（Ollama）', lmHint: '在本机跑的开源模型，不用 API、不用 key。注意两个数：磁盘是下载占的硬盘，内存是回答问题时占的运行内存（闲置 5 分钟自动卸载释放）。',
  lmOff: '这台服务器还没装 Ollama。先在服务器上跑 scripts/setup-local-model.sh，再打开设置。',
  lmUse: '使用', lmUsing: '使用中', lmPull: '下载', lmDel: '删除', lmDisk: '磁盘', lmRam: '内存', lmPulling: '下载中…', lmFailed: '下载失败——点「下载」可以断点续传',
  attach: '添加图片 / 视频 / 文件', editAct: '编辑', delConfirm: '确认删除？', attTooBig: '每个文件要小于 10 MB', attTooMany: '一次最多 6 个文件',
  okOnce: '✓ 已允许（仅这次）', okSession: '✓ 已允许（本会话内同类操作不再问）', denied: '✕ 已拒绝',
  imported: '已导入团队「{name}」，共 {n} 个机器人。', importFail: '⚠ 导入失败：',
  sessExp: '登录已失效，请重新输入访问口令', noMsg: '暂无消息',
  lockHintAcct: '用你的账号登录。第一次使用时，先创建管理员账号。',
  lockNamePh: '账号名', lockPassPh: '密码（至少 8 位）', loginBtn: '登录',
  createAcct: '创建管理员账号', setupHint: '还没有任何账号——下面创建的就是第一个（管理员）账号。',
  lockUseToken: '改用访问口令登录', lockUseAcct: '改用账号登录',
  searchPh: '搜索 Agent…', fAll: '全部',
  st_running: '运行中', st_awaiting_approval: '等待审批', st_idle: '待命', st_offline: '离线',
  online: '可用', wsCurrent: '当前工作区', wsOpen: '打开',
  qaTitle: '快速操作', qaNew: '新建任务', qaTeam: '管理团队', qaImport: '导入项目', qaTasks: '任务中心',
  tabTeam: '团队', tabTasks: '任务', tabWs: '工作区', tabSettings: '设置',
  tasksTitle: '任务中心', refresh: '刷新', wsTitle2: '工作区', teamTitle: '团队',
  tg_done: '已完成', tg_failed: '失败', tg_cancelled: '已取消', noTasks: '还没有任务记录——给某个 Agent 派点活吧。',
  tStop: '停止', tRetry: '重试', tView: '查看', stoppedNote: '⏹ 已停止。',
  errRetry: '重试', errCopy: '复制错误', errCopied: '已复制',
  wsEmpty: '这个工作区还是空的。', wsTotals: '{files} 个文件 · {size}',
  acctTitle: '账号', logout: '退出登录', pwOldPh: '当前密码', pwNewPh: '新密码（至少 8 位）', pwChange: '修改密码', pwOk: '密码已修改。',
  usersTitle: '账号管理（仅管理员）', uAdd: '添加账号', roleMember: '成员', roleOwner: '管理员',
  meLine: '{name} · {role}', legacyNote: '你正在用旧的访问口令登录。建议创建个人账号；等大家都有账号后，在服务器上删掉 START_AGENTS_ACCESS_TOKEN 即可彻底退役口令。',
  volTitle: '志愿者计划', volDesc: '无报酬、无义务：想来就来，想走就走，不要求做任何事。加入的账号会预先记下「志愿者额度等级」——后面独立内置模型上线、开始计额度时，志愿者自动拥有更多额度。',
  volJoin: '加入志愿者计划', volLeave: '退出计划', volJoined: '你已于 {date} 加入 · 额度等级：志愿者', volNot: '尚未加入 · 目前已有 {n} 位志愿者', volNeedAcct: '志愿者身份记在账号上——先创建一个账号（退出后注册，或让管理员给你加一个）。',
  lmCat_code: '代码', lmCat_general: '通用', lmCat_reasoning: '推理', lmCat_vision: '视觉',
  stopTitle: '停止生成', volBadge: '志愿者',

};

const tw = {
  ...zh,
  newBot: '新增機器人', importTeam: '匯入團隊', exportTeam: '匯出', pickBot: '選擇一個機器人', msgPh: '輸入訊息…',
  tryHint: '試試：list files 看工作區 · read 檔案名 · note 記一筆 · run 指令（要審批）',
  dNew: '新增機器人', dEdit: '編輯機器人', fName: '名字', fProvider: '模型供應商', fPersona: '人設',
  fPersonaPh: '這個機器人是誰？應該怎麼工作？', del: '刪除', cancel: '取消', save: '儲存',
  sTitle: '模型供應商', sHint: '金鑰在伺服器上加密保存，之後不再明文顯示，只留遮罩提示。強開源模型優先；所有預設都直連供應商。',
  noProv: '還沒有供應商，在下面新增一個。用「API 模型」引擎的機器人需要先有供應商。',
  preset: '預設', pLabel: '名稱', pLabelPh: '例如：我的 DeepSeek', pBase: '介面地址',
  pKey: 'API 金鑰', pKeyPh: 'sk-…（本機 Ollama 可不填）', addProv: '新增供應商', close: '關閉',
  audit: '最近動態', noAudit: '暫無記錄。', keyYes: '金鑰', keyNo: '無金鑰（本機端點）',
  provNone: '（不指定，用環境預設）', notConf: '（未設定）',
  lockHint: '這是一個受保護的部署。輸入存取口令一次，這台裝置之後免輸。',
  lockPh: '存取口令', unlock: '解鎖', lockErr: '口令不對，再試一次。',
  apTitle: '🙋 需要你批准 — ', allow: '允許', allowS: '本工作階段都允許', deny: '拒絕',
  okOnce: '✓ 已允許（僅這次）', okSession: '✓ 已允許（本工作階段同類操作不再問）', denied: '✕ 已拒絕',
  imported: '已匯入團隊「{name}」，共 {n} 個機器人。', importFail: '⚠ 匯入失敗：',
  sessExp: '登入已失效，請重新輸入存取口令', noMsg: '暫無訊息',
  lockHintAcct: '用你的帳號登入。第一次使用時，先建立管理員帳號。',
  lockNamePh: '帳號名', lockPassPh: '密碼（至少 8 位）', loginBtn: '登入',
  createAcct: '建立管理員帳號', setupHint: '還沒有任何帳號——下面建立的就是第一個（管理員）帳號。',
  lockUseToken: '改用訪問口令登入', lockUseAcct: '改用帳號登入',
  searchPh: '搜尋 Agent…', fAll: '全部',
  st_running: '運行中', st_awaiting_approval: '等待審批', st_idle: '待命', st_offline: '離線',
  online: '可用', wsCurrent: '目前工作區', wsOpen: '開啟',
  qaTitle: '快速操作', qaNew: '新建任務', qaTeam: '管理團隊', qaImport: '匯入專案', qaTasks: '任務中心',
  tabTeam: '團隊', tabTasks: '任務', tabWs: '工作區', tabSettings: '設定',
  tasksTitle: '任務中心', refresh: '重新整理', wsTitle2: '工作區', teamTitle: '團隊',
  tg_done: '已完成', tg_failed: '失敗', tg_cancelled: '已取消', noTasks: '還沒有任務記錄——給某個 Agent 派點活吧。',
  tStop: '停止', tRetry: '重試', tView: '查看', stoppedNote: '⏹ 已停止。',
  errRetry: '重試', errCopy: '複製錯誤', errCopied: '已複製',
  wsEmpty: '這個工作區還是空的。', wsTotals: '{files} 個文件 · {size}',
  acctTitle: '帳號', logout: '登出', pwOldPh: '目前密碼', pwNewPh: '新密碼（至少 8 位）', pwChange: '修改密碼', pwOk: '密碼已修改。',
  usersTitle: '帳號管理（僅管理員）', uAdd: '新增帳號', roleMember: '成員', roleOwner: '管理員',
  meLine: '{name} · {role}', legacyNote: '你正在用舊的訪問口令登入。建議建立個人帳號；等大家都有帳號後，在伺服器上刪掉 START_AGENTS_ACCESS_TOKEN 即可徹底退役口令。',
  volTitle: '志願者計畫', volDesc: '無報酬、無義務：想來就來，想走就走，不要求做任何事。加入的帳號會預先記下「志願者額度等級」——後面獨立內建模型上線、開始計額度時，志願者自動擁有更多額度。',
  volJoin: '加入志願者計畫', volLeave: '退出計畫', volJoined: '你已於 {date} 加入 · 額度等級：志願者', volNot: '尚未加入 · 目前已有 {n} 位志願者', volNeedAcct: '志願者身分記在帳號上——先建立一個帳號（登出後註冊，或讓管理員給你加一個）。',
  lmCat_code: '程式', lmCat_general: '通用', lmCat_reasoning: '推理', lmCat_vision: '視覺',
  stopTitle: '停止生成', volBadge: '志願者',

};

const ja = {
  ...en,
  newBot: '新規ボット', models: '⚙ モデル', importTeam: 'チーム読込', exportTeam: '書出',
  pickBot: 'ボットを選択', send: '送信', msgPh: 'メッセージ…',
  dNew: '新規ボット', dEdit: 'ボット編集', fName: '名前', fEngine: 'エンジン', fProvider: 'モデル提供元',
  fPersona: 'ペルソナ', del: '削除', cancel: 'キャンセル', save: '保存',
  sTitle: 'モデルプロバイダ', preset: 'プリセット', pLabel: 'ラベル', pBase: 'ベースURL',
  pKey: 'APIキー', addProv: 'プロバイダ追加', close: '閉じる', audit: '最近の活動', noAudit: 'まだありません。',
  lockPh: 'アクセストークン', unlock: 'ロック解除', allow: '許可', allowS: 'このセッション中すべて許可', deny: '拒否',
  okOnce: '✓ 許可しました（今回のみ）', okSession: '✓ 許可しました（このセッション）', denied: '✕ 拒否しました',
  apTitle: '🙋 承認が必要です — ', noMsg: 'メッセージはまだありません',
};

const ko = {
  ...en,
  newBot: '새 봇', models: '⚙ 모델', importTeam: '팀 가져오기', exportTeam: '내보내기',
  pickBot: '봇 선택', send: '전송', msgPh: '메시지…',
  dNew: '새 봇', dEdit: '봇 편집', fName: '이름', fEngine: '엔진', fProvider: '모델 제공자',
  fPersona: '페르소나', del: '삭제', cancel: '취소', save: '저장',
  sTitle: '모델 제공자', preset: '프리셋', pLabel: '라벨', pBase: '기본 URL',
  pKey: 'API 키', addProv: '제공자 추가', close: '닫기', audit: '최근 활동', noAudit: '아직 없습니다.',
  lockPh: '액세스 토큰', unlock: '잠금 해제', allow: '허용', allowS: '이 세션 동안 모두 허용', deny: '거부',
  okOnce: '✓ 허용됨(이번만)', okSession: '✓ 허용됨(이 세션)', denied: '✕ 거부됨',
  apTitle: '🙋 승인이 필요합니다 — ', noMsg: '아직 메시지가 없습니다',
};

const es = {
  ...en,
  newBot: 'Nuevo bot', models: '⚙ Modelos', importTeam: 'Importar equipo', exportTeam: 'Exportar',
  pickBot: 'Elige un bot', send: 'Enviar', msgPh: 'Mensaje…',
  dNew: 'Nuevo bot', dEdit: 'Editar bot', fName: 'Nombre', fEngine: 'Motor', fProvider: 'Proveedor de modelo',
  fPersona: 'Personalidad', del: 'Eliminar', cancel: 'Cancelar', save: 'Guardar',
  sTitle: 'Proveedores de modelo', preset: 'Preajuste', pLabel: 'Etiqueta', pBase: 'URL base',
  pKey: 'Clave API', addProv: 'Añadir proveedor', close: 'Cerrar', audit: 'Actividad reciente', noAudit: 'Aún nada.',
  lockPh: 'Token de acceso', unlock: 'Desbloquear', allow: 'Permitir', allowS: 'Permitir toda la sesión', deny: 'Denegar',
  okOnce: '✓ Permitido una vez', okSession: '✓ Permitido esta sesión', denied: '✕ Denegado',
  apTitle: '🙋 Se necesita aprobación — ', noMsg: 'Sin mensajes todavía',
};

const fr = {
  ...en,
  newBot: 'Nouveau bot', models: '⚙ Modèles', importTeam: 'Importer l’équipe', exportTeam: 'Exporter',
  pickBot: 'Choisir un bot', send: 'Envoyer', msgPh: 'Message…',
  dNew: 'Nouveau bot', dEdit: 'Modifier le bot', fName: 'Nom', fEngine: 'Moteur', fProvider: 'Fournisseur de modèle',
  fPersona: 'Persona', del: 'Supprimer', cancel: 'Annuler', save: 'Enregistrer',
  sTitle: 'Fournisseurs de modèles', preset: 'Préréglage', pLabel: 'Libellé', pBase: 'URL de base',
  pKey: 'Clé API', addProv: 'Ajouter un fournisseur', close: 'Fermer', audit: 'Activité récente', noAudit: 'Rien pour le moment.',
  lockPh: 'Jeton d’accès', unlock: 'Déverrouiller', allow: 'Autoriser', allowS: 'Tout autoriser (session)', deny: 'Refuser',
  okOnce: '✓ Autorisé une fois', okSession: '✓ Autorisé pour la session', denied: '✕ Refusé',
  apTitle: '🙋 Approbation requise — ', noMsg: 'Aucun message',
};

const de = {
  ...en,
  newBot: 'Neuer Bot', models: '⚙ Modelle', importTeam: 'Team importieren', exportTeam: 'Exportieren',
  pickBot: 'Bot auswählen', send: 'Senden', msgPh: 'Nachricht…',
  dNew: 'Neuer Bot', dEdit: 'Bot bearbeiten', fName: 'Name', fEngine: 'Engine', fProvider: 'Modellanbieter',
  fPersona: 'Persona', del: 'Löschen', cancel: 'Abbrechen', save: 'Speichern',
  sTitle: 'Modellanbieter', preset: 'Preset', pLabel: 'Bezeichnung', pBase: 'Basis-URL',
  pKey: 'API-Schlüssel', addProv: 'Anbieter hinzufügen', close: 'Schließen', audit: 'Letzte Aktivität', noAudit: 'Noch nichts.',
  lockPh: 'Zugangstoken', unlock: 'Entsperren', allow: 'Erlauben', allowS: 'Für diese Sitzung erlauben', deny: 'Ablehnen',
  okOnce: '✓ Einmal erlaubt', okSession: '✓ Für die Sitzung erlaubt', denied: '✕ Abgelehnt',
  apTitle: '🙋 Genehmigung nötig — ', noMsg: 'Noch keine Nachrichten',
};

const ru = {
  ...en,
  newBot: 'Новый бот', models: '⚙ Модели', importTeam: 'Импорт команды', exportTeam: 'Экспорт',
  pickBot: 'Выберите бота', send: 'Отправить', msgPh: 'Сообщение…',
  dNew: 'Новый бот', dEdit: 'Изменить бота', fName: 'Имя', fEngine: 'Движок', fProvider: 'Провайдер модели',
  fPersona: 'Персона', del: 'Удалить', cancel: 'Отмена', save: 'Сохранить',
  sTitle: 'Провайдеры моделей', preset: 'Пресет', pLabel: 'Название', pBase: 'Базовый URL',
  pKey: 'API-ключ', addProv: 'Добавить провайдера', close: 'Закрыть', audit: 'Последняя активность', noAudit: 'Пока пусто.',
  lockPh: 'Токен доступа', unlock: 'Разблокировать', allow: 'Разрешить', allowS: 'Разрешать в этой сессии', deny: 'Запретить',
  okOnce: '✓ Разрешено один раз', okSession: '✓ Разрешено на сессию', denied: '✕ Запрещено',
  apTitle: '🙋 Нужно разрешение — ', noMsg: 'Сообщений пока нет',
};

const pt = {
  ...en,
  newBot: 'Novo bot', models: '⚙ Modelos', importTeam: 'Importar equipe', exportTeam: 'Exportar',
  pickBot: 'Escolha um bot', send: 'Enviar', msgPh: 'Mensagem…',
  dNew: 'Novo bot', dEdit: 'Editar bot', fName: 'Nome', fEngine: 'Motor', fProvider: 'Provedor de modelo',
  fPersona: 'Persona', del: 'Excluir', cancel: 'Cancelar', save: 'Salvar',
  sTitle: 'Provedores de modelo', preset: 'Predefinição', pLabel: 'Rótulo', pBase: 'URL base',
  pKey: 'Chave API', addProv: 'Adicionar provedor', close: 'Fechar', audit: 'Atividade recente', noAudit: 'Nada ainda.',
  lockPh: 'Token de acesso', unlock: 'Desbloquear', allow: 'Permitir', allowS: 'Permitir nesta sessão', deny: 'Negar',
  okOnce: '✓ Permitido uma vez', okSession: '✓ Permitido nesta sessão', denied: '✕ Negado',
  apTitle: '🙋 Aprovação necessária — ', noMsg: 'Sem mensagens ainda',
};

const vi = {
  ...en,
  newBot: 'Bot mới', models: '⚙ Mô hình', importTeam: 'Nhập đội', exportTeam: 'Xuất',
  pickBot: 'Chọn một bot', send: 'Gửi', msgPh: 'Tin nhắn…',
  dNew: 'Bot mới', dEdit: 'Sửa bot', fName: 'Tên', fEngine: 'Engine', fProvider: 'Nhà cung cấp mô hình',
  fPersona: 'Tính cách', del: 'Xoá', cancel: 'Huỷ', save: 'Lưu',
  sTitle: 'Nhà cung cấp mô hình', preset: 'Mẫu có sẵn', pLabel: 'Nhãn', pBase: 'URL gốc',
  pKey: 'API key', addProv: 'Thêm nhà cung cấp', close: 'Đóng', audit: 'Hoạt động gần đây', noAudit: 'Chưa có gì.',
  lockPh: 'Mã truy cập', unlock: 'Mở khoá', allow: 'Cho phép', allowS: 'Cho phép cả phiên này', deny: 'Từ chối',
  okOnce: '✓ Đã cho phép một lần', okSession: '✓ Đã cho phép trong phiên', denied: '✕ Đã từ chối',
  apTitle: '🙋 Cần bạn phê duyệt — ', noMsg: 'Chưa có tin nhắn',
};

const th = {
  ...en,
  newBot: 'บอทใหม่', models: '⚙ โมเดล', importTeam: 'นำเข้าทีม', exportTeam: 'ส่งออก',
  pickBot: 'เลือกบอท', send: 'ส่ง', msgPh: 'ข้อความ…',
  dNew: 'บอทใหม่', dEdit: 'แก้ไขบอท', fName: 'ชื่อ', fEngine: 'เอนจิน', fProvider: 'ผู้ให้บริการโมเดล',
  fPersona: 'บุคลิก', del: 'ลบ', cancel: 'ยกเลิก', save: 'บันทึก',
  sTitle: 'ผู้ให้บริการโมเดล', preset: 'ค่าตั้งต้น', pLabel: 'ป้ายชื่อ', pBase: 'Base URL',
  pKey: 'API key', addProv: 'เพิ่มผู้ให้บริการ', close: 'ปิด', audit: 'กิจกรรมล่าสุด', noAudit: 'ยังไม่มีข้อมูล',
  lockPh: 'โทเค็นเข้าใช้', unlock: 'ปลดล็อก', allow: 'อนุญาต', allowS: 'อนุญาตทั้งเซสชันนี้', deny: 'ปฏิเสธ',
  okOnce: '✓ อนุญาตครั้งเดียว', okSession: '✓ อนุญาตในเซสชันนี้', denied: '✕ ปฏิเสธแล้ว',
  apTitle: '🙋 ต้องการการอนุมัติ — ', noMsg: 'ยังไม่มีข้อความ',
};

const id = {
  ...en,
  newBot: 'Bot baru', models: '⚙ Model', importTeam: 'Impor tim', exportTeam: 'Ekspor',
  pickBot: 'Pilih bot', send: 'Kirim', msgPh: 'Pesan…',
  dNew: 'Bot baru', dEdit: 'Edit bot', fName: 'Nama', fEngine: 'Mesin', fProvider: 'Penyedia model',
  fPersona: 'Persona', del: 'Hapus', cancel: 'Batal', save: 'Simpan',
  sTitle: 'Penyedia model', preset: 'Preset', pLabel: 'Label', pBase: 'URL dasar',
  pKey: 'Kunci API', addProv: 'Tambah penyedia', close: 'Tutup', audit: 'Aktivitas terakhir', noAudit: 'Belum ada.',
  lockPh: 'Token akses', unlock: 'Buka kunci', allow: 'Izinkan', allowS: 'Izinkan sesi ini', deny: 'Tolak',
  okOnce: '✓ Diizinkan sekali', okSession: '✓ Diizinkan sesi ini', denied: '✕ Ditolak',
  apTitle: '🙋 Perlu persetujuan — ', noMsg: 'Belum ada pesan',
};

const ar = {
  ...en,
  newBot: 'بوت جديد', models: '⚙ النماذج', importTeam: 'استيراد فريق', exportTeam: 'تصدير',
  pickBot: 'اختر بوتًا', send: 'إرسال', msgPh: 'رسالة…',
  dNew: 'بوت جديد', dEdit: 'تعديل البوت', fName: 'الاسم', fEngine: 'المحرك', fProvider: 'مزوّد النموذج',
  fPersona: 'الشخصية', del: 'حذف', cancel: 'إلغاء', save: 'حفظ',
  sTitle: 'مزوّدو النماذج', preset: 'إعداد مسبق', pLabel: 'التسمية', pBase: 'الرابط الأساسي',
  pKey: 'مفتاح API', addProv: 'إضافة مزوّد', close: 'إغلاق', audit: 'النشاط الأخير', noAudit: 'لا شيء بعد.',
  lockPh: 'رمز الوصول', unlock: 'فتح', allow: 'سماح', allowS: 'السماح طوال الجلسة', deny: 'رفض',
  okOnce: '✓ تم السماح مرة واحدة', okSession: '✓ تم السماح لهذه الجلسة', denied: '✕ تم الرفض',
  apTitle: '🙋 يلزم موافقتك — ', noMsg: 'لا رسائل بعد',
};

const hi = {
  ...en,
  newBot: 'नया बॉट', models: '⚙ मॉडल', importTeam: 'टीम आयात करें', exportTeam: 'निर्यात',
  pickBot: 'एक बॉट चुनें', send: 'भेजें', msgPh: 'संदेश…',
  dNew: 'नया बॉट', dEdit: 'बॉट संपादित करें', fName: 'नाम', fEngine: 'इंजन', fProvider: 'मॉडल प्रदाता',
  fPersona: 'व्यक्तित्व', del: 'हटाएँ', cancel: 'रद्द करें', save: 'सहेजें',
  sTitle: 'मॉडल प्रदाता', preset: 'प्रीसेट', pLabel: 'लेबल', pBase: 'बेस URL',
  pKey: 'API कुंजी', addProv: 'प्रदाता जोड़ें', close: 'बंद करें', audit: 'हाल की गतिविधि', noAudit: 'अभी कुछ नहीं।',
  lockPh: 'एक्सेस टोकन', unlock: 'अनलॉक', allow: 'अनुमति दें', allowS: 'इस सत्र में सब अनुमति दें', deny: 'अस्वीकार',
  okOnce: '✓ एक बार अनुमति दी', okSession: '✓ इस सत्र के लिए अनुमति', denied: '✕ अस्वीकृत',
  apTitle: '🙋 आपकी स्वीकृति चाहिए — ', noMsg: 'अभी कोई संदेश नहीं',
};

export const DICT = { zh, tw, en, ja, ko, es, fr, de, ru, pt, vi, th, id, ar, hi };

export function getLang() {
  const saved = localStorage.getItem('sa-lang');
  if (saved && DICT[saved]) return saved;
  const nav = (navigator.language || 'en').toLowerCase();
  if (nav.startsWith('zh-tw') || nav.startsWith('zh-hk')) return 'tw';
  if (nav.startsWith('zh')) return 'zh';
  const base = nav.split('-')[0];
  return DICT[base] ? base : 'en';
}

export function makeT(lang) {
  const dict = DICT[lang] || en;
  return (key, vars) => {
    let s = dict[key] ?? en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace('{' + k + '}', v);
    return s;
  };
}
