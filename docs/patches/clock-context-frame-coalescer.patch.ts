/**
 * ClockContext FrameCoalescer 集成补丁 (v3 — 已实施)
 *
 * 状态: ✅ 已集成到 src/ink/components/ClockContext.tsx
 * 三层防护架构全部完成:
 *   第1层: ClockContext FrameCoalescer (本补丁) — tick 合并 + setTimeout(0) flush
 *   第2层: reconciler setTimeout(0) — ink.tsx scheduleRender (已有)
 *   第3层: FrameScheduler — src/ink/FrameScheduler.ts + ink.tsx onRender 集成
 *
 * 改造 createClock() 中的 tick() 函数:
 * - 旧: tick() 直接调用每个 subscriber 的 onChange()
 * - 新: tick() 标记 dirty，setTimeout(0, flush) 统一调用
 *
 * 修复记录:
 *   P1: setImmediate → setTimeout(0) 兼容 Bun (Dr. Perf)
 *   R3: 移除 skipCounter — 降频在 FrameScheduler 层处理,
 *       ClockContext 层只做合并, 不做跳帧, 避免动画卡顿 (Dr. React)
 *
 * 原理:
 * - 借鉴 ListenerDedup (store.ts) 的帧去重思想
 * - 借鉴 BufferedWriter 的延迟刷新模式
 * - React 18 ConcurrentRoot 自动批处理同一同步块中的多个 setState
 *
 * 效果:
 * - 每帧最多 1 次 React commit (而非 N 次，N = 组件数)
 * - setTimeout(0) 让路给 I/O (兼容 Bun)
 * - 不论有多少动画组件，渲染频率 = tick 频率
 *
 * 文件: src/ink/components/ClockContext.tsx
 * 行号: 18-28 (tick 函数)
 *
 * ═══════════════════════════════════════════════════════════════
 * 改造前:
 * ═══════════════════════════════════════════════════════════════
 *
 *   function tick(): void {
 *     const _t0 = performance.now();
 *     tickTime = Date.now() - startTime;
 *     for (const onChange of subscribers.keys()) {
 *       onChange();
 *     }
 *     const elapsed = performance.now() - _t0;
 *     if (elapsed > 50) {
 *       process.stderr.write(`[TICK_SLOW] tick() took ${elapsed.toFixed(0)}ms (${subscribers.size} subs)\n`);
 *     }
 *   }
 *
 * ═══════════════════════════════════════════════════════════════
 * 改造后:
 * ═══════════════════════════════════════════════════════════════
 *
 *   // FrameCoalescer: 借鉴 ListenerDedup (store.ts) + BufferedWriter
 *   // 将多个 tick 合并为一次 setTimeout(0) 回调
 *   // React 18 ConcurrentRoot 在同一同步块中自动批处理所有 setState
 *   let flushScheduled = false
 *
 *   function tick(): void {
 *     tickTime = Date.now() - startTime
 *     if (!flushScheduled) {
 *       flushScheduled = true
 *       // setTimeout(0): 兼容 Node.js 和 Bun
 *       // 在 I/O 回调之后、下一个 timer 之前执行
 *       // 比 queueMicrotask 不阻塞 I/O
 *       setTimeout(flush, 0)
 *     }
 *     // 调试: 记录合并率
 *     if (_CPU_DEBUG) {
 *       _tickCount++
 *     }
 *   }
 *
 *   function flush(): void {
 *     if (!flushScheduled) return
 *     flushScheduled = false
 *
 *     // 同步调用所有 subscriber
 *     // React 18 ConcurrentRoot 自动批处理: 多个 setState → 1次 commit
 *     const _t0 = _CPU_DEBUG ? performance.now() : 0
 *     for (const onChange of subscribers.keys()) {
 *       onChange()
 *     }
 *     // 调试: 记录 flush 耗时
 *     if (_CPU_DEBUG) {
 *       const elapsed = performance.now() - _t0
 *       _flushCount++
 *       if (elapsed > 50) {
 *         _log(`[tick_slow] flush took ${elapsed.toFixed(1)}ms (${subscribers.size} subs, ${_tickCount} ticks coalesced)`)
 *       }
 *       _tickCount = 0
 *     }
 *   }
 *
 * ═══════════════════════════════════════════════════════════════
 * 不需要的部分 (已删除):
 * ═══════════════════════════════════════════════════════════════
 *
 *   ~~skipCounter~~ — 删除
 *   ~~自适应降频逻辑~~ — 删除, 由 FrameScheduler.shouldRender() 处理
 *
 *   原因 (Dr. React R3):
 *     在 ClockContext 层跳帧会导致动画不连贯 (卡顿感)。
 *     降频应该在 FrameScheduler 层处理 — 它知道帧耗时,
 *     可以做出更智能的决策。ClockContext 层只负责合并,
 *     不做丢弃。
 *
 * ═══════════════════════════════════════════════════════════════
 * 与 FrameScheduler 的协作:
 * ═══════════════════════════════════════════════════════════════
 *
 *   ClockContext (第1层): 合并多个 tick → 单次 flush
 *     ↓
 *   React: 批处理 setState → 单次 commit
 *     ↓
 *   reconciler (第2层): setTimeout(0) → onRender
 *     ↓
 *   FrameScheduler (第3层): shouldRender() 检查帧预算
 *     ↓ (如果预算充足)
 *   onRender(): 渲染 + writeDiffToTerminal
 *
 *   FrameScheduler 的自适应降频通过 getIntervalMs() 影响
 *   scheduleRender 的 throttle 间隔, 不影响 ClockContext 的 tick 频率。
 *   这样动画时间源保持稳定, 只是渲染输出频率降低。
 */

export const PATCH_INFO = {
  file: 'src/ink/components/ClockContext.tsx',
  lines: '18-48',
  description: 'ClockContext tick() → FrameCoalescer (setTimeout(0) flush)',
  version: 'v3-implemented',
  status: 'IMPLEMENTED',
  fixes: [
    'P1: setImmediate → setTimeout(0) for Bun compatibility',
    'R3: Removed skipCounter — dedup only, no frame dropping at clock level',
  ],
  dependencies: [
    'src/ink/FrameScheduler.ts (Layer 3 — implemented)',
    'src/ink/ink.tsx scheduleRender setTimeout(0) (Layer 2 — already existed)',
  ],
  risk: 'low',
  reversible: true,
}
