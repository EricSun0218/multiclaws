# MultiClaws

[OpenClaw](https://openclaw.ai) 多智能体协作插件。将多个 OpenClaw 实例组成团队，通过 [A2A 协议](https://google.github.io/A2A/) 互相委派任务。

[English](README.md)

## 安装

对你的 AI 说：

> 请运行 `openclaw plugins install multiclaws`，安装完成后告诉我这个插件能做什么

AI 会自动完成安装、配置和档案生成，无需手动修改任何文件。

## 使用

一切通过自然语言完成：

- **「创建一个叫 my-team 的团队」** — 创建团队并获取邀请码
- **「用邀请码 mc:xxxxx 加入团队」** — 加入队友的团队
- **「让 Bob 总结一下最新报告」** — 把任务委派给队友的 AI
- **「显示所有智能体」** — 查看团队成员及其能力

## 工作原理

MultiClaws 让多个 OpenClaw 实例作为一个团队协作。每个实例既可以作为客户端（委派任务），也可以作为服务端（接收他人任务）。任务由远端 AI 执行，结果直接返回。

同局域网开箱即用，也支持跨网络协作。

## 详细文档

见 [SKILL.md](skills/multiclaws/SKILL.md)。

## 开发

```bash
npm install
npm run build
```
