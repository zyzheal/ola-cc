# Plugin 系统功能设计与实现规范

这份文档描述了 Claude Code `/plugins` 命令的完整功能设计，可供其他 agent 参考实现类似功能。

---

## 一、系统架构概览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           CLI Entry Point                               │
│                    src/cli/handlers/plugins.ts                          │
│           (claude plugin install/uninstall/enable/disable)              │
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Interactive UI Layer                             │
│                  src/commands/plugin/PluginSettings.tsx                 │
│  ┌─────────────┬─────────────┬─────────────┬─────────────────────────┐ │
│  │  Discover   │  Installed  │ Marketplaces│       Errors            │ │
│  │  Plugins    │  Plugins    │   Manage    │      (Tab)              │ │
│  └─────────────┴─────────────┴─────────────┴─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       Core Operations Layer                             │
│               src/services/plugins/pluginOperations.ts                  │
│  • installPluginOp()  • uninstallPluginOp()  • setPluginEnabledOp()    │
│  • updatePluginOp()   • findReverseDependents()                        │
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Utility Services Layer                           │
│  ┌────────────────┐ ┌─────────────────┐ ┌────────────────────────────┐ │
│  │ pluginLoader   │ │ marketplaceMgr  │ │ pluginIdentifier           │ │
│  │ • cachePlugin  │ │ • addMarketplace│ │ • parsePluginIdentifier    │ │
│  │ • loadAll      │ │ • refresh       │ │ • createPluginId           │ │
│  └────────────────┘ └─────────────────┘ └────────────────────────────┘ │
│  ┌────────────────┐ ┌─────────────────┐ ┌────────────────────────────┐ │
│  │ installedPlugins│ │ pluginOptions   │ │ pluginPolicy             │ │
│  │ • loadV2       │ │ • save/load     │ │ • isBlockedByPolicy       │ │
│  └────────────────┘ └─────────────────┘ └────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Data Storage Layer                              │
│  ~/.claude/settings.json          ~/.claude/plugins/                   │
│  ~/.claude/settings.local.json    - known_marketplaces.json            │
│  ~/.claude/pluginSecrets/         - installed_plugins_v2.json          │
│                                   - cache/{marketplace}/{plugin}/      │
│                                   - marketplaces/{name}/               │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 二、核心数据结构定义

### 2.1 插件标识符 (Plugin Identifier)

```typescript
/**
 * 插件唯一标识符格式：name@marketplace
 * 示例："my-plugin@anthropics/claude-code-plugins"
 */
interface PluginIdentifier {
  name: string;       // 插件名称，kebab-case
  marketplace: string; // 市场名称或源标识符
}

/**
 * 作用域类型 - 决定配置写入哪个 settings 文件
 */
type PluginScope = 'user' | 'project' | 'local' | 'managed'

/**
 * 作用域优先级 (高 → 低)
 * managed > local > project > user
 * 
 * 实现规则:
 * 1. 读取时：合并所有作用域，高优先级覆盖低优先级
 * 2. 写入时：默认写入 user，除非指定其他作用域
 * 3. 删除时：从指定作用域删除
 */
```

### 2.2 插件清单 (Plugin Manifest)

```typescript
interface PluginManifest {
  name: string;         // 唯一标识，kebab-case，不能包含空格
  version?: string;     // 语义化版本 (semver)
  description?: string; // 用户 facing 描述
  author?: {
    name: string;
    email?: string;
    url?: string;
  };
  
  // 组件路径配置
  commands?: string | string[];      // 命令目录/文件
  agents?: string | string[];        // Agent 目录/文件
  skills?: string | string[];        // Skill 目录/文件
  hooks?: string;                    // hooks.json 路径
  mcpServers?: string | object;      // MCP 服务器配置
  lspServers?: string | object;      // LSP 服务器配置
  
  // 用户配置 Schema
  userConfig?: {
    [key: string]: {
      type: 'string' | 'number' | 'boolean' | 'secret';
      title: string;
      description?: string;
      required?: boolean;
      default?: any;
    }
  };
  
  // 依赖声明
  dependencies?: string[];  // 依赖的插件 ID 列表
}
```

### 2.3 市场配置 (Marketplace Config)

```typescript
interface MarketplaceConfig {
  name: string;  // 市场唯一标识，kebab-case
  
  source: 
    | { source: 'github'; repo: 'owner/repo'; branch?: string }
    | { source: 'git'; url: string }
    | { source: 'url'; url: string }
    | { source: 'directory'; path: string }
    | { source: 'file'; path: string };
  
  installLocation: string;  // 安装/缓存路径
  lastUpdated?: string;     // ISO 8601 时间戳
  autoUpdate?: boolean;     // 是否自动更新
}

/**
 * 市场源解析规则
 */
function parseMarketplaceInput(input: string): ParsedMarketplace {
  // 1. owner/repo 格式 → GitHub
  if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(input)) {
    return { source: 'github', repo: input };
  }
  
  // 2. https:// 开头 → URL 市场
  if (input.startsWith('https://')) {
    return { source: 'url', url: input };
  }
  
  // 3. git@ 开头 → Git SSH
  if (input.startsWith('git@')) {
    return { source: 'git', url: input };
  }
  
  // 4. ./ 或 / 开头 → 本地路径
  if (input.startsWith('./') || input.startsWith('/')) {
    return { source: 'directory', path: resolve(input) };
  }
  
  throw new Error('Invalid marketplace source format');
}
```

### 2.4 安装记录 (Installation Record)

```typescript
/**
 * installed_plugins_v2.json 结构
 */
interface InstalledPluginsV2 {
  plugins: {
    [pluginId: string]: InstallationEntry[];
  };
}

interface InstallationEntry {
  scope: 'user' | 'project' | 'local' | 'managed';
  installPath: string;      // 缓存路径
  version?: string;         // 安装版本
  installedAt: string;      // ISO 8601
  lastUpdated?: string;     // ISO 8601
  projectPath?: string;     // project/local 作用域的项目路径
  gitCommitSha?: string;    // Git 源提交哈希
}
```

---

## 三、核心功能流程

### 3.1 安装插件流程 (installPlugin)

```
┌─────────────────────────────────────────────────────────────────┐
│ Step 1: 解析插件标识符                                          │
├─────────────────────────────────────────────────────────────────┤
│ input: "my-plugin" 或 "my-plugin@marketplace"                   │
│                                                                 │
│ if input contains '@':                                          │
│   name = input.split('@')[0]                                    │
│   marketplace = input.split('@')[1]                             │
│ else:                                                           │
│   name = input                                                  │
│   marketplace = searchAllMarketplaces(name)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: 在市场配置中查找插件条目                                │
├─────────────────────────────────────────────────────────────────┤
│ function findPluginInMarketplace(name, marketplace?):           │
│   marketplaces = loadKnownMarketplacesConfig()                  │
│                                                                 │
│   for [mktName, mktConfig] in marketplaces:                     │
│     if marketplace && mktName !== marketplace: continue         │
│                                                                 │
│     marketData = loadMarketplace(mktName)                       │
│       ├─ github: git clone/pull 到 cache                        │
│       ├─ url: axios GET 保存响应                                │
│       └─ directory: fs.readdir 读取 plugin.json                 │
│                                                                 │
│     entry = marketData.plugins.find(p => p.name === name)       │
│     if entry: return { entry, marketplaceName: mktName }        │
│                                                                 │
│   throw new Error(`Plugin "${name}" not found`)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: 策略检查 (Policy Check)                                 │
├─────────────────────────────────────────────────────────────────┤
│ if isPluginBlockedByPolicy(pluginId):                           │
│   throw new Error('Plugin blocked by enterprise policy')        │
│                                                                 │
│ function isPluginBlockedByPolicy(pluginId):                     │
│   source = extractSource(pluginId)                              │
│   blocked = getSettings().blockedMarketplaces || []             │
│   allowed = getSettings().allowedMarketplaces || []             │
│                                                                 │
│   if blocked.includes(source): return true                      │
│   if allowed.length > 0 && !allowed.includes(source): return true│
│   return false                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 4: 写入 Settings (声明意图)                                │
├─────────────────────────────────────────────────────────────────┤
│ settings = getSettingsForSource(scope)                          │
│                                                                 │
│ newEnabledPlugins = { ...settings.enabledPlugins }              │
│ newEnabledPlugins[pluginId] = true                              │
│                                                                 │
│ updateSettingsForSource(scope, {                                │
│   enabledPlugins: newEnabledPlugins                             │
│ })                                                              │
│                                                                 │
│ // 注意：先写 settings，后缓存插件                              │
│ // 这样重启时可以 reconciliation 声明但未缓存的插件             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 5: 缓存插件内容                                            │
├─────────────────────────────────────────────────────────────────┤
│ function cachePlugin(source, pluginId):                         │
│                                                                 │
│   if source is github/git:                                      │
│     tempDir = mkdtemp('/tmp/plugin-clone-')                     │
│     exec(`git clone ${source.url} ${tempDir}`)                  │
│     exec(`git checkout ${source.branch || 'main'}`, {cwd})      │
│     commitSha = exec(`git rev-parse HEAD`, {cwd}).trim()        │
│     rm(`${tempDir}/.git`, { recursive: true })                  │
│                                                                 │
│   version = calculatePluginVersion(                             │
│     pluginId, source, manifest, clonePath, commitSha            │
│   )                                                             │
│                                                                 │
│   cachePath = getVersionedCachePath(pluginId, version)          │
│   copyDir(clonePath, cachePath)                                 │
│                                                                 │
│   return { path: cachePath, version, gitCommitSha }             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 6: 更新安装记录                                            │
├─────────────────────────────────────────────────────────────────┤
│ installData = loadInstalledPluginsV2()                          │
│                                                                 │
│ if !installData.plugins[pluginId]:                              │
│   installData.plugins[pluginId] = []                            │
│                                                                 │
│ existingIndex = installData.plugins[pluginId].findIndex(        │
│   e => e.scope === scope && e.projectPath === projectPath       │
│ )                                                               │
│                                                                 │
│ if existingIndex >= 0:                                          │
│   installData.plugins[pluginId][existingIndex] = {              │
│     scope, projectPath, installPath: cachePath,                 │
│     version, gitCommitSha, installedAt: isoNow(),               │
│     lastUpdated: isoNow()                                       │
│   }                                                             │
│ else:                                                           │
│   installData.plugins[pluginId].push({                          │
│     scope, projectPath, installPath: cachePath,                 │
│     version, gitCommitSha, installedAt: isoNow()                │
│   })                                                            │
│                                                                 │
│ saveInstalledPluginsV2(installData)                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 7: 清除缓存并检查配置                                      │
├─────────────────────────────────────────────────────────────────┤
│ clearAllCaches()  // 强制重新加载插件                           │
│                                                                 │
│ // 检查是否需要用户配置                                         │
│ plugin = findPluginOptionsTarget(pluginId)                      │
│ if plugin && hasUnconfiguredOptions(plugin):                    │
│   showPluginOptionsFlow(plugin, pluginId)                       │
│                                                                 │
│ function hasUnconfiguredOptions(plugin):                        │
│   saved = loadPluginOptions(pluginId)                           │
│   for [key, schema] in Object.entries(plugin.manifest.userConfig):│
│     if schema.required && !(key in saved):                      │
│       return true                                               │
│   return false                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

### 3.2 卸载插件流程 (uninstallPlugin)

```
┌─────────────────────────────────────────────────────────────────┐
│ Step 1: 查找插件                                                │
├─────────────────────────────────────────────────────────────────┤
│ allPlugins = loadAllPlugins()                                   │
│ plugin = allPlugins.find(p => p.name === name || p.source === pluginId)│
│                                                                 │
│ if !plugin:                                                     │
│   // 可能已从市场删除，查 installed_plugins_v2.json             │
│   installedData = loadInstalledPluginsV2()                      │
│   if installedData.plugins[pluginId]:                           │
│     pluginId = resolveDelistedPluginId(name, installedData)     │
│   else:                                                         │
│     throw new Error('Plugin not found')                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: 检查反向依赖                                            │
├─────────────────────────────────────────────────────────────────┤
│ function findReverseDependents(pluginId, allPlugins):           │
│   dependents = []                                               │
│                                                                 │
│   for plugin in allPlugins:                                     │
│     if plugin.manifest.dependencies?.includes(pluginId):        │
│       dependents.push(plugin.name)                              │
│                                                                 │
│   return dependents                                             │
│                                                                 │
│ // 仅警告，不阻止卸载 (避免 tombstone 问题)                     │
│ if dependents.length > 0:                                       │
│   warn(`Warning: ${dependents.join(', ')} depends on this plugin`)│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: 从 Settings 删除                                         │
├─────────────────────────────────────────────────────────────────┤
│ settings = getSettingsForSource(scope)                          │
│                                                                 │
│ newEnabledPlugins = { ...settings.enabledPlugins }              │
│ delete newEnabledPlugins[pluginId]  // 或设置为 undefined        │
│                                                                 │
│ updateSettingsForSource(scope, {                                │
│   enabledPlugins: newEnabledPlugins                             │
│ })                                                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 4: 从安装记录删除                                          │
├─────────────────────────────────────────────────────────────────┤
│ installData = loadInstalledPluginsV2()                          │
│                                                                 │
│ if installData.plugins[pluginId]:                               │
│   installData.plugins[pluginId] = installData.plugins[pluginId] │
│     .filter(e => !(e.scope === scope && e.projectPath === projectPath))│
│                                                                 │
│   if installData.plugins[pluginId].length === 0:                │
│     delete installData.plugins[pluginId]                        │
│                                                                 │
│ saveInstalledPluginsV2(installData)                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 5: 清理缓存和数据 (如是最后作用域)                         │
├─────────────────────────────────────────────────────────────────┤
│ if noRemainingInstallations(pluginId):                          │
│   // 标记旧版本为孤立                                           │
│   markPluginVersionOrphaned(oldInstallPath)                     │
│                                                                 │
│   // 删除插件选项                                               │
│   deletePluginOptions(pluginId)                                 │
│     ├─ delete settings.pluginConfigs[pluginId]                  │
│     └─ delete secureStorage.pluginSecrets[pluginId]             │
│                                                                 │
│   // 删除数据目录                                               │
│   deletePluginDataDir(pluginId)                                 │
│     └─ rm(`${getPluginDataDir(pluginId)}`, { recursive: true }) │
│                                                                 │
│ clearAllCaches()                                                │
└─────────────────────────────────────────────────────────────────┘
```

---

### 3.3 启用/禁用插件流程 (setPluginEnabled)

```
┌─────────────────────────────────────────────────────────────────┐
│ Step 1: 解析插件 ID 和作用域                                     │
├─────────────────────────────────────────────────────────────────┤
│ function resolvePluginFromSettings(plugin, scope?):             │
│                                                                 │
│   if scope is explicit:                                         │
│     settings = getSettingsForSource(scope)                      │
│     if settings.enabledPlugins[plugin]:                         │
│       return { pluginId: plugin, scope }                        │
│     if plugin includes '@':                                     │
│       return { pluginId: plugin, scope }                        │
│     throw new Error('Plugin not found in scope')                │
│                                                                 │
│   else:  // 自动检测最具体作用域                                │
│     for checkScope in ['local', 'project', 'user']:             │
│       settings = getSettingsForSource(checkScope)               │
│       for key in Object.keys(settings.enabledPlugins):          │
│         if key === plugin || key.startsWith(`${plugin}@`):      │
│           return { pluginId: key, scope: checkScope }           │
│                                                                 │
│   throw new Error('Plugin not found in any settings scope')     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: 策略检查 (仅启用时)                                     │
├─────────────────────────────────────────────────────────────────┤
│ if enabled && isPluginBlockedByPolicy(pluginId):                │
│   throw new Error('Plugin blocked by policy')                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: 检查当前状态 (幂等性)                                   │
├─────────────────────────────────────────────────────────────────┤
│ isCurrentlyEnabled = getPluginEditableScopes().has(pluginId)    │
│                                                                 │
│ if enabled === isCurrentlyEnabled:                              │
│   return { success: false, message: 'Already ${enabled ? "enabled" : "disabled"}' }│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 4: 写入 Settings                                            │
├─────────────────────────────────────────────────────────────────┤
│ settings = getSettingsForSource(scope)                          │
│                                                                 │
│ updateSettingsForSource(scope, {                                │
│   enabledPlugins: {                                             │
│     ...settings.enabledPlugins,                                 │
│     [pluginId]: enabled                                         │
│   }                                                             │
│ })                                                              │
│                                                                 │
│ clearAllCaches()  // 强制重新加载                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 5: 检查反向依赖 (仅禁用时)                                 │
├─────────────────────────────────────────────────────────────────┤
│ if !enabled:                                                    │
│   allPlugins = loadAllPlugins()                                 │
│   dependents = findReverseDependents(pluginId, allPlugins)      │
│                                                                 │
│   if dependents.length > 0:                                     │
│     warn(`${dependents.join(', ')} depends on this plugin`)     │
└─────────────────────────────────────────────────────────────────┘
```

---

### 3.4 更新插件流程 (updatePlugin)

```
┌─────────────────────────────────────────────────────────────────┐
│ Step 1: 获取市场最新条目                                        │
├─────────────────────────────────────────────────────────────────┤
│ pluginInfo = await getPluginById(plugin)                        │
│ if !pluginInfo:                                                 │
│   throw new Error('Plugin not found in marketplace')            │
│                                                                 │
│ entry = pluginInfo.entry                                        │
│ marketplaceInstallLocation = pluginInfo.marketplaceInstallLocation│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: 获取当前安装信息                                        │
├─────────────────────────────────────────────────────────────────┤
│ diskData = loadInstalledPluginsFromDisk()                       │
│ installations = diskData.plugins[pluginId]                      │
│ installation = installations.find(i => i.scope === scope)       │
│                                                                 │
│ oldVersion = installation.version                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: 下载/获取最新源                                         │
├─────────────────────────────────────────────────────────────────┤
│ if entry.source is remote (github/git/url):                     │
│   cacheResult = cachePlugin(entry.source, { manifest })         │
│   sourcePath = cacheResult.path                                 │
│   newVersion = cacheResult.version                              │
│   gitCommitSha = cacheResult.gitCommitSha                       │
│   shouldCleanupSource = true                                    │
│                                                                 │
│ else:  // 本地源                                                │
│   sourcePath = resolve(marketplaceInstallLocation, entry.source)│
│   manifest = loadPluginManifest(sourcePath)                     │
│   newVersion = calculatePluginVersion(pluginId, source, manifest, sourcePath)│
│   shouldCleanupSource = false                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 4: 检查是否已最新                                          │
├─────────────────────────────────────────────────────────────────┤
│ versionedPath = getVersionedCachePath(pluginId, newVersion)     │
│ zipPath = getVersionedZipCachePath(pluginId, newVersion)        │
│                                                                 │
│ isUpToDate =                                                    │
│   installation.version === newVersion ||                        │
│   installation.installPath === versionedPath ||                 │
│   installation.installPath === zipPath                          │
│                                                                 │
│ if isUpToDate:                                                  │
│   return { success: true, alreadyUpToDate: true, newVersion }   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 5: 复制到版本化缓存                                        │
├─────────────────────────────────────────────────────────────────┤
│ versionedPath = copyPluginToVersionedCache(                     │
│   sourcePath, pluginId, newVersion, entry                       │
│ )                                                               │
│                                                                 │
│ // 删除 .git 目录                                                 │
│ rm(`${versionedPath}/.git`, { recursive: true, force: true })   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 6: 更新安装记录                                            │
├─────────────────────────────────────────────────────────────────┤
│ oldVersionPath = installation.installPath                       │
│                                                                 │
│ updateInstallationPathOnDisk(                                   │
│   pluginId, scope, projectPath, versionedPath, newVersion, gitCommitSha│
│ )                                                               │
│                                                                 │
│ // 清理旧版本 (如不再被引用)                                    │
│ updatedData = loadInstalledPluginsFromDisk()                    │
│ isOldVersionStillReferenced = Object.values(updatedData.plugins)│
│   .some(installations =>                                        │
│     installations.some(inst => inst.installPath === oldVersionPath)│
│   )                                                             │
│                                                                 │
│ if !isOldVersionStillReferenced:                                │
│   markPluginVersionOrphaned(oldVersionPath)                     │
│                                                                 │
│ if shouldCleanupSource:                                         │
│   rm(sourcePath, { recursive: true, force: true })              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 四、缓存机制设计

### 4.1 目录结构

```
~/.claude/plugins/
├── cache/
│   └── {marketplace-name}/
│       └── {plugin-name}/
│           └── {version}/
│               ├── plugin.json
│               ├── commands/
│               ├── agents/
│               └── ...
├── marketplaces/
│   ├── {marketplace-name}/       # Git 克隆的市场数据
│   └── {marketplace-name}.json   # URL 市场的缓存
├── known_marketplaces.json       # 市场配置
└── installed_plugins_v2.json     # 安装记录
```

### 4.2 版本计算规则

```typescript
/**
 * 计算插件版本的优先级规则
 */
async function calculatePluginVersion(
  pluginId: string,
  source: PluginSource,
  manifest: PluginManifest | null,
  installPath: string,
  entryVersion?: string,
  gitCommitSha?: string
): Promise<string> {
  // 1. Git 源优先使用 commit SHA
  if (gitCommitSha) {
    return gitCommitSha;
  }
  
  // 2. manifest.version (semver)
  if (manifest?.version) {
    return manifest.version;
  }
  
  // 3. marketplace.json 中的 version 字段
  if (entryVersion) {
    return entryVersion;
  }
  
  // 4. 从 Git 仓库获取
  if (source is github/git) {
    const gitRoot = findGitRoot(installPath);
    if (gitRoot) {
      const sha = exec(`git rev-parse HEAD`, { cwd: gitRoot }).trim();
      return sha;
    }
  }
  
  // 5. 回退到 'unknown'
  return 'unknown';
}
```

### 4.3 缓存清理策略

```typescript
/**
 * 标记版本为孤立 (可被清理)
 * 当下次 housekeeping 运行时清理
 */
async function markPluginVersionOrphaned(installPath: string): Promise<void> {
  const orphanFile = `${installPath}/.claude-plugin/orphaned.json`;
  await writeFile(orphanFile, JSON.stringify({
    orphanedAt: new Date().toISOString(),
    reason: 'no-longer-referenced'
  }));
}

/**
 * Housekeeping 清理逻辑 (启动时运行)
 */
async function cleanupOrphanedVersions(): Promise<void> {
  const cacheDir = getPluginCachePath();
  const entries = await readdir(cacheDir, { recursive: true });
  
  for (const entry of entries) {
    if (entry.isDirectory() && exists(`${entry}/.claude-plugin/orphaned.json`)) {
      const orphanData = JSON.parse(readFile(`${entry}/.claude-plugin/orphaned.json`));
      const orphanedAt = new Date(orphanData.orphanedAt);
      const daysSinceOrphaned = (Date.now() - orphanedAt.getTime()) / (1000 * 60 * 60 * 24);
      
      // 7 天后清理
      if (daysSinceOrphaned > 7) {
        await rm(entry, { recursive: true, force: true });
      }
    }
  }
}
```

---

## 五、错误处理系统

### 5.1 错误类型定义

```typescript
type PluginError =
  | { type: 'plugin-not-found'; pluginId: string; marketplace: string }
  | { type: 'marketplace-not-found'; marketplace: string; availableMarketplaces: string[] }
  | { type: 'marketplace-load-failed'; marketplace: string; reason: string }
  | { type: 'git-auth-failed'; gitUrl: string; authType: 'ssh' | 'https' }
  | { type: 'git-timeout'; gitUrl: string; operation: 'clone' | 'pull' }
  | { type: 'network-error'; url: string; details?: string }
  | { type: 'manifest-parse-error'; manifestPath: string; parseError: string }
  | { type: 'manifest-validation-error'; manifestPath: string; validationErrors: string[] }
  | { type: 'mcp-config-invalid'; serverName: string; validationError: string }
  | { type: 'dependency-unsatisfied'; dependency: string; reason: 'not-enabled' | 'not-found' }
  | { type: 'marketplace-blocked-by-policy'; marketplace: string; blockedByBlocklist?: boolean }
  | { type: 'generic-error'; error: string };
```

### 5.2 错误消息生成

```typescript
function getPluginErrorMessage(error: PluginError): string {
  switch (error.type) {
    case 'plugin-not-found':
      return `Plugin "${error.pluginId}" not found in marketplace "${error.marketplace}"`;
    
    case 'marketplace-not-found':
      return error.availableMarketplaces.length > 0
        ? `Marketplace "${error.marketplace}" not found. Available: ${error.availableMarketplaces.join(', ')}`
        : `Marketplace "${error.marketplace}" not found`;
    
    case 'git-auth-failed':
      return `Git ${error.authType.toUpperCase()} authentication failed for ${error.gitUrl}`;
    
    case 'dependency-unsatisfied':
      return error.reason === 'not-enabled'
        ? `Dependency "${error.dependency}" is disabled — enable it or remove this plugin`
        : `Dependency "${error.dependency}" not found in any configured marketplace`;
    
    // ... 其他错误类型
    
    default:
      return error.message;
  }
}
```

---

## 六、UI 组件状态机

### 6.1 ViewState 类型定义

```typescript
type ViewState =
  // 发现插件
  | { type: 'discover-plugins'; targetPlugin?: string }
  
  // 浏览市场
  | { type: 'browse-marketplace'; targetMarketplace: string; targetPlugin?: string }
  
  // 管理插件
  | { type: 'manage-plugins'; targetPlugin?: string; action?: 'enable' | 'disable' | 'uninstall' }
  
  // 市场管理
  | { type: 'marketplace-list' }
  | { type: 'add-marketplace'; initialValue?: string }
  | { type: 'manage-marketplaces'; targetMarketplace: string; action?: 'remove' | 'update' }
  
  // 验证插件
  | { type: 'validate'; path: string }
  
  // 错误处理
  | { type: 'errors' }
  
  // 默认菜单
  | { type: 'menu' };
```

### 6.2 状态转换规则

```typescript
/**
 * 从解析的命令生成初始视图状态
 */
function getInitialViewState(parsedCommand: ParsedCommand): ViewState {
  switch (parsedCommand.type) {
    case 'install':
      if (parsedCommand.marketplace) {
        // 有市场源 → 浏览特定市场
        return {
          type: 'browse-marketplace',
          targetMarketplace: parsedCommand.marketplace,
          targetPlugin: parsedCommand.plugin
        };
      }
      // 无市场源 → 发现插件
      return { type: 'discover-plugins', targetPlugin: parsedCommand.plugin };
    
    case 'manage':
      return { type: 'manage-plugins' };
    
    case 'uninstall':
      return {
        type: 'manage-plugins',
        targetPlugin: parsedCommand.plugin,
        action: 'uninstall'
      };
    
    case 'enable':
      return {
        type: 'manage-plugins',
        targetPlugin: parsedCommand.plugin,
        action: 'enable'
      };
    
    case 'marketplace':
      switch (parsedCommand.action) {
        case 'list':
          return { type: 'marketplace-list' };
        case 'add':
          return { type: 'add-marketplace', initialValue: parsedCommand.target };
        case 'remove':
          return {
            type: 'manage-marketplaces',
            targetMarketplace: parsedCommand.target,
            action: 'remove'
          };
        case 'update':
          return {
            type: 'manage-marketplaces',
            targetMarketplace: parsedCommand.target,
            action: 'update'
          };
        default:
          return { type: 'marketplace-list' };
      }
    
    default:
      return { type: 'discover-plugins' };
  }
}
```

---

## 七、配置存储设计

### 7.1 Settings 结构

```typescript
interface Settings {
  // 启用的插件
  enabledPlugins: {
    [pluginId: string]: boolean;
  };
  
  // 额外市场配置
  extraKnownMarketplaces: {
    [marketplaceName: string]: DeclaredMarketplace;
  };
  
  // 插件配置 (非敏感)
  pluginConfigs: {
    [pluginId: string]: {
      options: Record<string, any>;
      mcpServers?: Record<string, any>;
    };
  };
  
  // 阻止的市场
  blockedMarketplaces?: string[];
  
  // 允许的市场 (企业模式)
  allowedMarketplaces?: string[];
}
```

### 7.2 敏感数据存储

```typescript
interface SecureStorage {
  // 插件密钥
  pluginSecrets: {
    [pluginId: string]: {
      [key: string]: string;  // 所有值都转为字符串
    };
  };
}

/**
 * 保存插件选项 — 按 sensitive 字段拆分存储
 */
function savePluginOptions(
  pluginId: string,
  values: PluginOptionValues,
  schema: PluginOptionSchema
): void {
  const nonSensitive: PluginOptionValues = {};
  const sensitive: Record<string, string> = {};
  
  // 按 schema 分类
  for (const [key, value] of Object.entries(values)) {
    if (schema[key]?.sensitive === true) {
      sensitive[key] = String(value);
    } else {
      nonSensitive[key] = value;
    }
  }
  
  // 先写敏感数据 (keychain)
  if (Object.keys(sensitive).length > 0) {
    const storage = getSecureStorage();
    const existing = storage.read()?.pluginSecrets?.[pluginId] || {};
    
    // 删除不再敏感的值
    for (const key of Object.keys(existing)) {
      if (key in nonSensitive) {
        delete existing[key];
      }
    }
    
    storage.update({
      pluginSecrets: {
        ...storage.read().pluginSecrets,
        [pluginId]: { ...existing, ...sensitive }
      }
    });
  }
  
  // 后写非敏感数据 (settings.json)
  if (Object.keys(nonSensitive).length > 0) {
    updateSettingsForSource('userSettings', {
      pluginConfigs: {
        ...settings.pluginConfigs,
        [pluginId]: {
          ...settings.pluginConfigs?.[pluginId],
          options: nonSensitive
        }
      }
    });
  }
  
  clearPluginOptionsCache();
}
```

---

## 八、实现检查清单

实现类似系统时，需完成以下模块:

```
□ 1. 核心数据结构
  □ PluginManifest Schema (Zod/JSON Schema)
  □ PluginIdentifier 解析函数
  □ MarketplaceSource 解析函数

□ 2. 存储层
  □ settings.json 读写
  □ installed_plugins_v2.json 管理
  □ secureStorage 封装 (keychain/.credentials.json)

□ 3. 缓存层
  □ getVersionedCachePath()
  □ copyPluginToVersionedCache()
  □ cachePlugin() - Git/URL 源处理

□ 4. 市场管理
  □ loadKnownMarketplacesConfig()
  □ addMarketplaceSource()
  □ refreshMarketplace()

□ 5. 核心操作
  □ installPluginOp()
  □ uninstallPluginOp()
  □ setPluginEnabledOp()
  □ updatePluginOp()

□ 6. 错误处理
  □ PluginError 类型定义
  □ getPluginErrorMessage()
  □ getErrorGuidance()

□ 7. 策略系统
  □ isPluginBlockedByPolicy()
  □ validateOfficialNameSource()

□ 8. UI 组件 (可选)
  □ PluginSettings 主容器
  □ DiscoverPlugins
  □ ManagePlugins
  □ AddMarketplace
  □ PluginErrors
```

---

## 九、快捷键系统设计

```
┌─────────────────────────────────────────────────────────────────┐
│ 全局快捷键 (所有视图)                                           │
├─────────────────────────────────────────────────────────────────┤
│ Ctrl+C / Ctrl+D  → 退出                                         │
│ Tab / 1,2,3,4    → 切换标签页                                   │
│ Esc            → 返回/退出搜索                                  │
│ /              → 进入搜索模式                                   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Discover 视图                                                   │
├─────────────────────────────────────────────────────────────────┤
│ ↑/↓            → 上下选择                                       │
│ Enter          → 查看详情                                      │
│ i              → 快速安装                                      │
│ Space          → 标记待安装                                    │
│ Esc            → 返回主菜单                                    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Manage 视图                                                     │
├─────────────────────────────────────────────────────────────────┤
│ ↑/↓            → 上下选择                                      │
│ Enter          → 查看详情                                      │
│ e              → enable                                        │
│ d              → disable                                       │
│ u              → update                                        │
│ U              → uninstall                                     │
│ m              → 查看 MCP 详情                                  │
│ o              → 配置选项                                      │
│ Space          → 标记待操作                                    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Errors 视图                                                     │
├─────────────────────────────────────────────────────────────────┤
│ ↑/↓            → 上下选择                                      │
│ Enter          → 执行推荐操作                                  │
│ Esc            → 返回                                          │
└─────────────────────────────────────────────────────────────────┘
```

---

文档版本：1.0  
最后更新：2026-04-11
