import fs from 'fs'

async function applyFixes() {
  const queryPath = 'src/query.ts'
  let content = fs.readFileSync(queryPath, 'utf8')

  // 1. 移除reactiveCompact和collapseOwnsIt的限制
  content = content.replace(
    /if \(\s*!compactionResult\s*&&\s*querySource\s*!==\s*"compact"\s*&&\s*querySource\s*!==\s*"session_memory"\s*&&\s*!\(\s*reactiveCompact\?\.\sisReactiveCompactEnabled\(\)\s*&&\s*isAutoCompactEnabled\(\)\s*\)\s*&&\s*!collapseOwnsIt\s*\) {/g,
    `if (
				!compactionResult &&
				querySource !== "compact" &&
				querySource !== "session_memory"
			) {`
  )

  // 2. 添加isAboveAutoCompactThreshold到解构
  content = content.replace(
    /const \{ isAtBlockingLimit \} = calculateTokenWarningState/,
    'const { isAtBlockingLimit, isAboveAutoCompactThreshold } = calculateTokenWarningState'
  )

  // 3. 更新日志输出
  content = content.replace(
    /\[QUERY LOOP\] checkpoint: isAtBlockingLimit=\$\{isAtBlockingLimit\}/,
    `[QUERY LOOP] checkpoint: isAtBlockingLimit=${'$'}{isAtBlockingLimit}, isAboveAutoCompactThreshold=${'$'}{isAboveAutoCompactThreshold}`
  )

  // 4. 添加压缩机会调试日志
  const debugLogInsert = `				// Record potential compact opportunity
				if (isAboveAutoCompactThreshold) {
					logForDebugging?.(
						\`[QUERY LOOP] auto-compact threshold reached: tokens=${'$'}{tokenCount}, threshold=${'$'}{getAutoCompactThreshold(modelForCheck)}\`
					);
				}`

  const insertPattern = /if \(isAtBlockingLimit\) {/
  if (content.match(insertPattern)) {
    content = content.replace(insertPattern, `${debugLogInsert}\n\n				if (isAtBlockingLimit) {`)
  }

  fs.writeFileSync(queryPath, content)
  console.log('✅ 所有修复已应用')
}

applyFixes().catch(console.error)