#!/usr/bin/env node

/**
 * Agent Tool System 演示脚本
 *
 * 展示如何使用Agent智能检测系统替代原有的37个硬编码detector
 */

import { agentDetectorTool } from './AgentDetectorTool.js'
import { AgentToolSystemFactory } from './AgentToolSystem.js'

// 演示代码样本
const sampleCode = `
import React from 'react';
import { message } from 'antd';

const UserProfile = ({ userId }) => {
  const [user, setUser] = React.useState(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    setLoading(true);
    fetch('/api/user/' + userId)
      .then(res => res.json())
      .then(data => {
        setUser(data);
      })
      .catch(error => {
        // 缺少错误反馈
        console.error('加载失败:', error);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [userId]);

  if (loading) {
    return <div>加载中...</div>;
  }

  if (!user) {
    // 缺少空状态
    return null;
  }

  return (
    <div>
      <h1>{user.name}</h1>
      <p>{user.email}</p>
      <button onClick={() => message.success('保存成功')}>
        保存
      </button>
    </div>
  );
};

export default UserProfile;
`

console.log('🚀 Agent Tool System 演示')
console.log('=====================================\n')

// 1. 展示工具基本信息
console.log('📋 工具信息:')
console.log(`名称: ${agentDetectorTool.name}`)
console.log(`描述: ${agentDetectorTool.description}`)
console.log(`并发安全: ${agentDetectorTool.isConcurrencySafe({ code: '', fileType: 'tsx' })}`)
console.log(`启用状态: ${agentDetectorTool.isEnabled()}`)
console.log(`只读模式: ${agentDetectorTool.isReadOnly({ code: '', fileType: 'tsx' })}`)
console.log('')

// 2. 演示项目类型检测
console.log('🔍 项目类型检测:')
const projectContexts = [
  { type: 'frontend', features: ['tsx', 'css', 'antd'] },
  { type: 'backend', features: ['ts', 'api', 'database'] },
  { type: 'fullstack', features: ['tsx', 'ts', 'api', 'database'] }
]

projectContexts.forEach(context => {
  console.log(`- ${context.type} 项目: ${context.features.join(', ')}`)
})

console.log('')

// 3. 演示检测策略
console.log('🎯 检测策略:')
const strategies = [
  { name: 'security', priority: 'high', desc: '安全风险检测' },
  { name: 'ux', priority: 'medium', desc: '用户体验检测' },
  { name: 'quality', priority: 'medium', desc: '代码质量检测' },
  { name: 'performance', priority: 'low', desc: '性能优化检测' },
  { name: 'all', priority: 'high', desc: '全量检测' }
]

strategies.forEach(strategy => {
  console.log(`- ${strategy.name} (${strategy.priority}): ${strategy.desc}`)
})

console.log('')

// 4. 模拟检测结果展示
console.log('📊 模拟检测结果:')
console.log('```json')
console.log(JSON.stringify({
  code: sampleCode,
  fileType: 'tsx',
  analysis: {
    intent: '用户信息页面组件',
    riskLevel: 'medium',
    confidence: 85,
    evidence: ['缺少错误反馈', '缺少空状态处理'],
    suggestions: ['添加message.error()提示', '添加Empty组件']
  },
  detection: {
    issues: [
      {
        type: 'missing-feedback',
        description: 'API请求失败时缺少用户反馈',
        severity: 'warning',
        location: 'catch块'
      },
      {
        type: 'missing-empty',
        description: '用户数据为空时缺少Empty组件',
        severity: 'info',
        location: 'return语句'
      }
    ],
    strategy: 'all',
    confidence: 85,
    suggestions: ['添加错误处理和用户反馈', '完善空状态处理']
  },
  learningApplied: true
}, null, 2))
console.log('```')

// 5. 展示优势对比
console.log('')
console.log('✨ Agent Tool System 优势:')
console.log('1. 🧠 智能理解: 基于自然语言理解代码意图')
console.log('2. 🔧 自适应: 根据项目类型动态调整检测策略')
console.log('3. 📈 持续学习: 记录误报，自动优化检测准确度')
console.log('4. 🎯 精准检测: 37个硬编码规则 → 智能分析引擎')
console.log('5. 💡 上下文感知: 结合项目结构提供精准建议')
console.log('')

// 6. 与传统AST对比
console.log('🔄 vs 传统AST检测:')
console.log('传统方式:')
console.log('❌ 硬编码规则维护困难')
console.log('❌ 无法理解代码业务逻辑')
console.log('❌ 高误报率，需要人工筛选')
console.log('❌ 难以适应新场景')
console.log('')
console.log('Agent方式:')
console.log('✅ 智能推理理解业务')
console.log('✅ 自适应调整策略')
console.log('✅ 持续学习优化')
console.log('✅ 灵活扩展新场景')
console.log('')

console.log('🎉 演示完成！Agent Tool System 已准备就绪。')