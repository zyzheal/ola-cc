// Probe the actual memory held by message content (base64 images, thinking blocks)
// This simulates what happens during a long conversation.

const fs = await import('fs/promises')

// Count base64 image/PDF content in session transcript
const sessionDir = process.env.HOME + '/.ola-cc/sessions'
let totalBase64Bytes = 0
let totalMsgCount = 0

try {
  const files = await fs.readdir(sessionDir)
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue
    const path = sessionDir + '/' + f
    const stat = await fs.stat(path)
    if (stat.size < 1024 * 1024) continue // skip small files
    
    console.log(`Session: ${f} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
    
    let base64InFile = 0
    let msgCount = 0
    const data = await fs.readFile(path, 'utf-8')
    for (const line of data.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry.type === 'message' && entry.message?.content) {
          msgCount++
          const content = JSON.stringify(entry.message.content)
          // Check for base64 data (data:image, data:application)
          const base64Matches = content.match(/data:(?:image|application)\/\w+;base64,[A-Za-z0-9+/=]+/g) || []
          for (const m of base64Matches) {
            base64InFile += m.length
          }
          // Check for large thinking blocks
          if (content.includes('"type":"thinking"') && content.length > 100000) {
            base64InFile += content.length
          }
        }
      } catch { /* skip parse errors */ }
    }
    totalBase64Bytes += base64InFile
    totalMsgCount += msgCount
    console.log(`  Messages: ${msgCount}, Base64 data: ${(base64InFile / 1024 / 1024).toFixed(1)} MB`)
    break // just check the largest one
  }
} catch (e) {
  console.log(`No session dir or error: ${e.message}`)
}

console.log(`\nTotal base64 data across sessions: ${(totalBase64Bytes / 1024 / 1024).toFixed(1)} MB`)
console.log(`Total messages: ${totalMsgCount}`)
