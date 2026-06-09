# Compact 关键能力补齐计划

## 背景
深度对比评审发现 ola-cc compact 系统在 3 个关键能力上落后于 Headroom：
1. Token估算精度 — `*4/3` 填充系数 vs Headroom的模型特定字符密度
2. 分层行重要性检测 — 简单关键词匹配 vs Headroom的Tiered+Aho-Corasick
3. 混合相关性搜索 — 无嵌入 vs Headroom的BM25+Embedding自适应融合

## 实现计划

### Task 1: Token估算校准 (高优先级，低复杂度)
- 修改 `src/services/tokenEstimation.ts`，按模型类型使用不同字符/token比
- Claude模型: 3.5 cpt, 通用: 4.0 cpt
- 公式: `max(1, int(chars/cpt + 0.5))` (round-half-up)
- 影响: compact质量评分、预算决策、微压缩触发

### Task 2: 分层行重要性检测 (高优先级，中复杂度)
- 新建 `src/services/compact/lineImportance.ts`
- 实现 Tiered 分层检测器 + 置信度级联
- 5类别: Error(0.95), Warning(0.75), Security(0.85), Importance(0.60), Markdown(0.45)
- 集成到 microCompact.ts 的 shouldProtectToolResult

### Task 3: 混合相关性搜索 (中优先级，高复杂度)
- 新建 `src/services/search/hybridScorer.ts`
- BM25 + 自适应α调参(UUID/数字ID/主机名检测)
- 集成到 toolRanker.ts
- 注意: 无嵌入依赖，纯BM25+boost fallback
