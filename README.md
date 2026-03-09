# MultiClaws

让多个 OpenClaw 实例通过 [A2A 协议](https://google.github.io/A2A/) 组成团队、互相委派任务。

## 安装

对你的 AI 说：

> 请运行 `openclaw plugin install multiclaws`，安装完成后告诉我你能做什么

AI 会自动完成安装、配置和档案生成，无需手动修改任何文件。

## 使用

一切通过自然语言完成：

- **「创建一个叫 my-team 的团队」** — 创建团队并获取邀请码
- **「用邀请码 mc:xxxxx 加入团队」** — 加入队友的团队
- **「让 Bob 总结一下最新报告」** — 把任务委派给队友的 AI
- **「显示所有智能体」** — 查看团队成员及其能力

## 跨网络

同局域网开箱即用。不同网络安装 [Tailscale](https://tailscale.com/download)，插件自动检测。

## 详细文档

见 [SKILL.md](skills/multiclaws/SKILL.md)。

## 开发

```bash
pnpm install
pnpm run build
pnpm test
```
