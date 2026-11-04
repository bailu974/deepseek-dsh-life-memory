# dsh-life-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的**会遗忘的记忆**插件。

上下文放不下的时候，它把最旧的几轮对话蒸馏成几个关键词线索，**从历史里物理删除**；
之后你提到那件事，它顺着线索用 `recall_from_clues` 把记忆重新长出来。

> 不存原文，只存线索。像人一样遗忘，也需要时像人一样回忆。

---

## 它做什么

```
上下文 ≤ 阈值        什么都不做
上下文 > 阈值
  → 挑最旧的「已完成」轮次
  → 抽关键词 + 线索种子，写进本地 SQLite
  → 把那段历史替换成一条「记忆已折叠」提示
  → 需要时：recall_from_clues(关键词) 顺着线索回想
```

线索库默认在 `~/.dsh/life-memory/memory.db`（SQLite，不联网、不外传）。

---

## 这个版本修了什么

原本的想法来自 [`@tuhengyu/dsh-full-life-memory`](https://www.npmjs.com/package/@tuhengyu/dsh-full-life-memory)（MIT）。
实际跑下来发现几个会**让机制彻底失效**的问题，这个版本全部修掉了：

| # | 问题 | 后果 | 修法 |
|---|---|---|---|
| 1 | 选区间时从「事件日志里最旧的轮次」挑，但它们上次折叠时已被整段替换掉 | **每个会话只会折叠一次**，之后上下文无限增长（实测单步涨到 68 万 token） | 先算出「surface 上还真实存在的轮次」，再从中挑最旧的 |
| 2 | `forgetTurns` 在内部被 clamp 成 10 | 配多大都只能切 10 轮，想「一次砍到位」做不到 | 上限放宽到 200 |
| 3 | 估算按 `chars / 3` 算 token | 中文被低估约 1.8 倍，永远算不够，于是把能切的都切光 | 改成 `chars × 0.6`（中文约 0.6 token/字） |
| 4 | 一次只切固定轮数，溢出多少都慢慢磨 | 每轮都触发折叠，缓存刚建立就被冲掉 | 按「还差多少」累计切，一次压回阈值以下 |
| 5 | 全局一套参数 | QQ 聊天和桌面会话需求相反（一个要瘦，一个要缓存友好） | 支持按会话分策略（`qqPolicy`） |
| 6 | `lastCutTurn` 是**插件级全局变量** | **跨会话互相挡住**：A 折完把「上次切到第 7 轮」写进全局，B 走到第 7 轮直接跳过 —— 那一整轮永不遗忘 | 改成按 `agentId` 分开的 Map，会话之间互不影响 |
| 7 | 同一轮只折一次就锁死 | 一轮里上下文暴涨时折不动，表现为「挤牙膏」 | 允许同一轮最多折 3 次（每次都重新过阈值判断） |
| 8 | 最旧那段不合格就 `return` | `spanIsBalanced` 不过或提不出线索 → 直接放弃，**这个会话从此永不折叠**且无提示 | 往后退最多 3 段再试，而不是放弃 |
| 9 | 先写库、后改历史，失败不补偿 | surface 替换抛错时线索已落库，重试会留下重复行 | 替换失败就删掉刚写的那条线索 |
| 10 | 崩溃残留的 `compaction/start` | `compactionActive` 永远为真 → 这个会话再也不折 | 距离事件末尾太远的 unpaired start 视为失效 |

外加：折叠提示、失败时的日志、以及「折叠后仍能继续折叠」的回归测试。

---

### 会话之间互不干扰

折叠状态按会话分开记（`agentId` → `{ turn, count }`），所以：

- A 会话折完，B 会话走到**同一个轮次号**照样会折
- 同一轮最多折 3 次，避免一步一刀把当前轮掏空
- 某段不合格（工具没闭合 / 提不出线索）时会往后退一段再试

> ⚠️ **线索库本身不按会话隔离**：`recall_from_clues` 会在整个库里搜。
> 单人桌面没问题；一个 DSH 实例同时服务多个真人时，给他们各自配不同的 `dbPath`（或不同 profile）。

## 配置

用户配置在 `<家>/life-memory/config.json`，或直接改 profile 的 `cordis.patch.yml`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `dbPath` | `<家>/life-memory/memory.db` | 线索库位置 |
| `limit` | 5 | 一次 recall 最多取几条线索 |
| `maxPromptChars` | 1800 | recall 拼出来的回忆最长多少字符 |
| `autoForget` | true | 关掉就只记线索、不自动折叠 |
| `forgetThresholdTokens` | 20000 | 会话超过多少 token 开始遗忘 |
| `forgetTurns` | 200 | 单次最多切几轮（200 = 一次砍到位） |
| `keepCompletedTurns` | 5 | 最近多少轮永远保留 |

### 按会话分策略

QQ 聊天希望上下文尽量小（每轮都贵），桌面会话希望少折叠（折叠会作废缓存）。用 `qqPolicy` 分开配：

```yaml
sessionsFile: 'E:/ai/qq-bridge/state/sessions.json'   # 能认出哪些 session 走激进策略的 JSON（旧名 qqSessionsFile 仍可用）
qqPolicy:
  aggressive:          # QQ 会话：一次砍到阈值、只留 5 轮
    forgetThresholdTokens: 20000
    forgetTurns: 200
    keepCompletedTurns: 5
  gentle:              # 其它会话：阈值更高、留更多轮
    forgetThresholdTokens: 60000
    forgetTurns: 10
    keepCompletedTurns: 20
```

`sessionsFile` 里的文件只要能被递归扫出 `session-...` 形式的 id 即可（桥接的 `sessions.json` 正好是这个形状）。
带 mtime 缓存，文件改了会自动跟上。

**不只 QQ**：任何 DSH 会话都能列进来。刷 B 站、刷微博、定时任务这些插件跑在各自会话里，
默认走 `gentle`（60k / 留 20 轮）；如果希望它们也压得狠一点，把那些 session id 加进同一个文件就行。

---

## 工具：`recall_from_clues`

被折叠掉的对话，靠它顺着线索重建：

```
recall_from_clues(keyword)   # keyword 给一个具体词，比整句好
```

- 只读本地 SQLite，返回一段**重建的记忆提示**，不是原文
- 最多 `limit` 条线索、`maxPromptChars` 字符
- 找不到就返回 `found: false`

> ⚠️ 如果你在 QQ 桥接那类「工具白名单」环境里用它，记得把 `recall_from_clues` 加进执行期白名单，
> 否则会出现「工具看得见、一调就被拒」的情况。

---

## 安装

```bash
# 本地目录（推荐）
dsh plugin --profile desktop add link:/path/to/deepseek-dsh-life-memory

# 从 GitHub（需要本机装了 git）
dsh plugin --profile desktop add https://github.com/bailu974/deepseek-dsh-life-memory
```

装好后 profile 的 `dsh.profile.bundles` 里会多一项 `life-memory`。

---

## 开发

```bash
node --test     # 5 个测试：一次砍到位 / 折完还能再折 / 保留轮次 / 工具配对 / 边界
```

测试里的假会话故意只实现插件真正用到的几个接口（`surface.nodes` / `snapshotEvents` / `eventAt` / `deriveEventMessage`），
所以它同时也是「插件到底依赖 session 的哪些能力」的说明。

---

## 致谢与许可

MIT。

思路与原始实现来自 [`@tuhengyu/dsh-full-life-memory`](https://www.npmjs.com/package/@tuhengyu/dsh-full-life-memory)（作者 tuhengyu，MIT）。
本仓库在其基础上修了上面列的 5 个问题，并补了测试。
