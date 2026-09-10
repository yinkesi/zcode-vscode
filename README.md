# ZCode Chat for VSCode

在 VSCode 侧边栏直接使用 ZCode（GLM 编程助手）：和它对话，它能读写当前工作区的文件、运行命令、修改代码——和在 ZCode 桌面版里一样的完整 Agent 能力。

## 工作原理

插件并不自己实现模型调用，而是把你的消息转发给本机已安装的 **ZCode CLI**（`zcode.cjs`，ZCode 桌面版自带）的无头模式（`zcode -p --json`）：

- 工作目录自动设置为当前 VSCode 工作区，因此 ZCode 可以直接读写你的项目文件；
- 登录凭据（Coding Plan API Key）自动从 ZCode 桌面端的共享配置 `~/.zcode/v2/config.json` 读取并解密，**无需额外登录**；
- 通过 `--resume <sessionId>` 实现多轮对话，会话按工作区隔离，重启 VSCode 后自动续接。

## 前置条件

1. 已安装并登录 ZCode 桌面版（本机已安装于 `D:\code\ZCode`）；
2. 已安装 Node.js（`node` 在 PATH 中即可）。

## 安装

方式一（推荐）：安装 vsix 包

```
code --install-extension zcode-local.zcode-chat-0.1.0.vsix
```

方式二：把整个 `zcode-vscode` 文件夹复制到 `%USERPROFILE%\.vscode\extensions\` 下，重启 VSCode。

> Cursor 同样可用：`cursor --install-extension <vsix 路径>`。

## 使用

- 面板位于**右侧辅助侧栏**，与 聊天/Copilot、Codex 同一区域（顶部标签切换）；
- 统一唤起方式：**Ctrl+Alt+Z**（或点击右侧栏顶部的 "ZCode" 标签）；
- 关闭：面板标题栏的 **✕ 按钮**（或 Ctrl+Alt+B 收起整个右侧栏）；
- 输入框中 Enter 发送、Shift+Enter 换行；
- **选择模型**：点击顶栏的模型芯片（如 `GLM-5.3-Flash ▾`），从套餐可用模型中切换，对下一条消息生效；
- **文件引用**：
  - `📎 当前文件`：把当前编辑器中的文件作为附件传给 ZCode；
  - `＋ 引用文件`：快速搜索工作区中的任意文件并附加（可多选累加，发送后清空）；
- **工作区感知**：每次发送会自动附带当前工作区、你正在查看的文件（含光标行号）和打开的标签页列表，输入区上方的 "Agent 可见" 栏实时显示将要共享的上下文，消息气泡上也会标注；
- **工作过程直播**：Agent 运行期间实时滚动显示它的每一步操作（读取/编辑文件、运行命令、搜索等，来自 ZCode 会话记录），完成后收进回复上方的 "⚡ 工作过程" 折叠块，可展开回看；
- **上下文用量**：每条回复下方显示耗时、token 消耗与上下文占用（如 `上下文 30.6k / 1000k`）；
- **@ 引用**：在输入框中键入 `@` 可快速搜索并引用工作区文件；
- 命令面板（Ctrl+Shift+P）中可用：`ZCode: 新会话`、`ZCode: 选择模型`、`ZCode: 引用文件…`、`ZCode: 把选中代码发给 ZCode`；
- 发送后 ZCode 会自主工作（读文件、改代码、跑命令），完成后回复结果；期间可点 **■ 停止** 中断。

## 配置项（设置中搜索 "zcodeChat"）

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `zcodeChat.cliPath` | 自动检测 | zcode.cjs 完整路径 |
| `zcodeChat.nodePath` | `node` | 运行 CLI 的 node 路径 |
| `zcodeChat.model` | `GLM-5.3-Flash` | 模型 ID，如 `GLM-5.3` |
| `zcodeChat.mode` | `yolo` | 权限模式：`yolo` 全自动 / `edit` 自动改文件 / `plan` 只读规划 |
| `zcodeChat.apiKey` | 自动读取 | Coding Plan API Key（`id.secret` 格式） |
| `zcodeChat.baseURL` | 自动读取 | API Base URL |
| `zcodeChat.providerId` | `builtin:bigmodel-coding-plan` | 凭据提供方 ID |

## 故障排查

- **提示未找到 ZCode CLI**：在设置中把 `zcodeChat.cliPath` 指向 `zcode.cjs`（桌面版安装目录下 `resources\glm\zcode.cjs`）。
- **提示无法读取桌面端配置**：先打开 ZCode 桌面版确认已登录，再回到 VSCode 重试；或在设置中手动填写 `zcodeChat.apiKey`。
- **想临时只读不改动**：把 `zcodeChat.mode` 改为 `plan`。
