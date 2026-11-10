# rankland-broadcast-hub

## 准备

1. 安装并使用 Node.js 16（推荐使用 fnm 自动切换版本）
2. 安装并使用 pnpm v8
3. 运行 `pnpm run init` 安装依赖

## 开发

1. 运行 `npm run dev`
2. 在浏览器中打开 <http://127.0.0.1:3001/>

## 构建

1. 运行 `npm run build`

## 部署

模板使用 PM2 作为生产环境部署工具，运行 `npm run deploy` 或 `npm run deploy:foreground`。

## 开发指南

### 目录结构

本项目模板采用了基于运行时 -> 模块的目录分层结构：

```
src/
  common/
  server/
```

### 后端开发

服务端使用 bwcx，提供简洁的 OOP 开发体验，参考 [bwcx 文档](https://bwcxjs.github.io/bwcx/)。

### ai coding
本项目 AI Coding 采取 Spec Coding 的方案，基于 [spec-Kit](https://github.com/github/spec-kit)。

如果你需要开发新的独立功能模块请使用 spec-kit 并进行开发（推荐使用 Codex CLI、Claude Code、CodeBuddy Code）。

若只是修复 bug 等简单工作，vibe coding 即可。
