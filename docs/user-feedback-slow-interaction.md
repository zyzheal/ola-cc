# 用户反馈：交互反应慢

## 问题描述
- 用户反馈交互反应慢
- 当前使用 glm51 模型（GLM-5.1）
- API 端点：https://zhenze-huhehaote.cmecloud.cn/api/coding

## 排查结果

### 网络测试
- 连接延迟：~0.2秒（正常）

### 近期代码改动
1. **NATS 事件系统**
   - 本地 NATS 服务器管理
   - EventRouter（支持 NATS + 内存队列 Fallback）
   - 事件转发集成

2. **Goal 功能修复**
   - auto-accept 和 compact 继续
   - 复杂决策自动审查机制
   - goalRuntime accounting.turn 重置

## 待确认
- 切换到 qwen 模型后是否改善？
- 慢是每次都发生，还是特定操作时才发生？

## 记录时间
2026-05-13