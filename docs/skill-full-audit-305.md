# 全量技能评审报告（305 个有效技能）

## 总览

| 指标 | 值 |
|------|-----|
| 总技能数 | 305 |
| 平均分 | 76.7/100 |
| 最高分 | 93 (systematic-debugging, subagent-driven-development) |
| 最低分 | 60 (enterprise-agent-ops, nanoclaw-repl) |
| 中位数 | 78 |

## 来源分布

| 来源 | 数量 | 平均分 |
|------|------|--------|
| ECC (导入) | 192 | 76 |
| local (原生) | 66 | 79 |
| community | 39 | 77 |
| 其他 | 8 | 75 |

## 分数等级分布

| 等级 | 分数范围 | 数量 | 占比 |
|------|---------|------|------|
| Excellent | >= 90 | 2 | 0.7% |
| Very Good | 80-89 | 121 | 39.7% |
| Good | 70-79 | 157 | 51.5% |
| Basic | 60-69 | 25 | 8.2% |
| Poor | < 60 | 0 | 0% |


## 按功能域分类


### 上下文管理 (3 个, 平均 80 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| context-budget | 80 | 135 | ECC | Audits Claude Code context window consumption across agents, |
| strategic-compact | 80 | 169 | ECC | Suggests manual context compaction at logical intervals to p |
| token-budget-advisor | 80 | 133 | community | >- |

### 产品与运营 (6 个, 平均 74 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| production-scheduling | 83 | 238 | ECC | > |
| internal-comms | 76 | 70 | local | A set of resources to help me write all kinds of internal co |
| product-lens | 73 | 92 | ECC | Use this skill to validate the "why" before building, run pr |
| investor-materials | 71 | 96 | ECC | Create and update pitch decks, one-pagers, investor memos, a |
| investor-outreach | 71 | 91 | ECC | Draft cold emails, warm intro blurbs, follow-ups, update ema |
| product-capability | 70 | 141 | ECC | Translate PRD intent, roadmap asks, or product discussions i |

### 代码审查 (7 个, 平均 78 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| design-doc-reviewer | 88 | 1255 | local | Use when reviewing design documents, architecture docs, API  |
| receiving-code-review | 86 | 263 | local | Use when receiving code review feedback, before implementing |
| orion-reviewing | 83 | 183 | local | To assess the health of an orion-managed skill, check its ma |
| requesting-code-review | 83 | 149 | local | Use when completing tasks, implementing major features, or b |
| scientific-thinking-literature-review | 75 | 192 | community | Systematic literature-review workflow for academic, biomedic |
| flutter-dart-code-review | 70 | 435 | ECC | Library-agnostic Flutter/Dart code review checklist covering |
| prediction-market-risk-review | 63 | 60 | ECC | Review prediction-market, basket, oracle, and trading-agent  |

### 供应链与贸易 (7 个, 平均 75 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| carrier-relationship-management | 83 | 212 | ECC | > |
| inventory-demand-planning | 83 | 247 | ECC | > |
| logistics-exception-management | 83 | 222 | ECC | > |
| returns-reverse-logistics | 83 | 240 | ECC | > |
| ito-market-intelligence | 68 | 60 | ECC | Research prediction-market events, venues, underliers, liqui |
| ito-basket-compare | 63 | 63 | ECC | Compare Itô prediction-market baskets against a user's knowl |
| ito-trade-planner | 63 | 67 | ECC | Build a non-advisory prediction-market trade planning worksh |

### 其他 (57 个, 平均 77 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| task-decomposer | 88 | 1717 | local | Use when breaking down features into subtasks, generating ex |
| java-coding-standards | 85 | 383 | ECC | Java coding standards for Spring Boot and Quarkus services:  |
| prompt-optimizer | 85 | 398 | community | >- |
| uncloud | 85 | 343 | ECC | Use when managing an Uncloud cluster — deploying services, c |
| algorithmic-art | 83 | 447 | local | Creating algorithmic art using p5.js with seeded randomness  |
| code-tour | 83 | 236 | ECC | Create CodeTour `.tour` files — persona-targeted, step-by-st |
| codebase-onboarding | 83 | 233 | ECC | Analyze an unfamiliar codebase and generate a structured onb |
| energy-procurement | 83 | 228 | ECC | > |
| laravel-plugin-discovery | 83 | 229 | ECC | Discover and evaluate Laravel packages via LaraPlugins.io MC |
| laravel-tdd | 83 | 283 | ECC | Test-driven development for Laravel with PHPUnit and Pest, f |
| openclaw-persona-forge | 83 | 288 | community | 为 OpenClaw AI Agent 锻造完整的龙虾灵魂方案。根据用户偏好或随机抽卡， 输出身份定位、灵魂描述(SOU |
| quality-nonconformance | 83 | 260 | ECC | > |
| algorithm-trainer | 81 | 243 | local | Use when developing a local algorithm practice system with d |
| accessibility | 80 | 146 | ECC | Design, implement, and audit inclusive digital products usin |
| claude-devfleet | 80 | 103 | community | Orchestrate multi-agent coding tasks via Claude DevFleet — p |
| continuous-learning-v2 | 80 | 360 | ECC | Instinct-based learning system that observes sessions via ho |
| cost-tracking | 80 | 147 | community | Track and report Claude Code token usage, spending, and budg |
| django-verification | 80 | 469 | ECC | Verification loop for Django projects: migrations, linting,  |
| laravel-verification | 80 | 179 | ECC | Verification loop for Laravel projects: env checks, linting, |
| lead-intelligence | 80 | 321 | ECC | AI-native lead intelligence and outreach pipeline. Replaces  |
| quarkus-tdd | 80 | 811 | ECC | Test-driven development for Quarkus 3.x LTS using JUnit 5, M |
| quarkus-verification | 80 | 479 | ECC | Verification loop for Quarkus projects: build, static analys |
| santa-method | 80 | 306 | "Ronald Skelton - Founder, RapportScore.ai" | Multi-agent adversarial verification with convergence loop.  |
| bun-runtime | 78 | 84 | ECC | Bun as runtime, package manager, bundler, and test runner. W |
| nextjs-turbopack | 78 | 57 | ECC | Next.js 16+ and Turbopack — incremental bundling, FS caching |
| regex-vs-llm-structured-text | 78 | 220 | ECC | Decision framework for choosing between regex and LLM when p |
| repo-scan | 78 | 78 | community | Cross-stack source code asset audit — classifies every file, |
| springboot-verification | 78 | 231 | ECC | Verification loop for Spring Boot projects: build, static an |
| verification-before-completion | 78 | 183 | local | Use when about to claim work is complete, fixed, or passing, |
| canary-watch | 75 | 107 | ECC | Use this skill to monitor and verify a deployed URL after re |
| coding-standards | 75 | 549 | ECC | Baseline cross-project coding conventions for naming, readab |
| connections-optimizer | 75 | 189 | ECC | Reorganize the user's X and LinkedIn network with review-fir |
| continuous-learning | 75 | 131 | ECC | [DEPRECATED - use continuous-learning-v2] Legacy v1 stop-hoo |
| cpp-coding-standards | 75 | 723 | ECC | C++ coding standards based on the C++ Core Guidelines (isocp |
| django-celery | 75 | 457 | ECC | Django + Celery async task patterns — configuration, task de |
| django-tdd | 75 | 729 | ECC | Django testing strategies with pytest-django, TDD methodolog |
| flox-environments | 75 | 496 | Flox | Create reproducible, cross-platform development environments |
| ios-icon-gen | 75 | 157 | community | Generate iOS app icons as PNG imagesets for Xcode asset cata |
| react-performance | 75 | 574 | ECC | React and Next.js performance optimization patterns adapted  |
| springboot-tdd | 75 | 158 | ECC | Test-driven development for Spring Boot using JUnit 5, Mocki |
| swift-actor-persistence | 75 | 143 | ECC | Thread-safe data persistence in Swift using actors — in-memo |
| browser-qa | 73 | 87 | ECC | Use this skill to automate visual testing and UI interaction |
| fal-ai-media | 73 | 288 | ECC | Unified media generation via fal.ai MCP — image, video, and  |
| foundation-models-on-device | 73 | 243 | local | Apple FoundationModels framework for on-device LLM — text ge |
| jira-integration | 73 | 293 | ECC | Use this skill when retrieving Jira tickets, analyzing requi |
| kotlin-coroutines-flows | 73 | 284 | ECC | Kotlin Coroutines and Flow patterns for Android and KMP — st |
| opensource-pipeline | 73 | 255 | ECC | Open-source pipeline: fork, sanitize, and package private pr |
| swift-concurrency-6-2 | 73 | 216 | local | Swift 6.2 Approachable Concurrency — single-threaded by defa |
| angular-developer | 70 | 154 | ECC | Generates Angular code and provides architectural guidance.  |
| cost-aware-llm-pipeline | 70 | 183 | ECC | Cost optimization patterns for LLM API usage — model routing |
| gateguard | 70 | 125 | community | Fact-forcing gate that blocks Edit/Write/Bash (including Mul |
| make-interfaces-feel-better | 70 | 151 | community | Apply concrete design-engineering details that make interfac |
| hermes-imports | 68 | 88 | ECC | Convert local Hermes operator workflows into sanitized ECC s |
| ck | 65 | 147 | community | Persistent per-project memory for Claude Code. Auto-loads pr |
| ai-first-engineering | 63 | 51 | ECC | Engineering operating model for teams where AI agents genera |
| latency-critical-systems | 63 | 73 | ECC | Use for latency-sensitive systems such as realtime dashboard |
| nanoclaw-repl | 60 | 33 | ECC | Operate and extend NanoClaw v2, ECC's zero-dependency sessio |

### 前端与设计 (18 个, 平均 76 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| mcp-builder | 86 | 271 | local | Guide for creating high-quality MCP (Model Context Protocol) |
| motion-ui | 85 | 575 | ECC | Production-ready UI motion system for React/Next.js. Use whe |
| theme-factory | 83 | 102 | local | Toolkit for styling artifacts with a theme. These artifacts  |
| blender-motion-state-inspection | 80 | 164 | ECC | Use this skill when inspecting Blender characters, rigs, pos |
| dashboard-builder | 80 | 108 | ECC direct-port adaptation | Build monitoring dashboards that answer real operator questi |
| team-builder | 80 | 168 | community | Interactive agent picker for composing and dispatching paral |
| ui-demo | 80 | 465 | ECC | Record polished UI demo videos using Playwright. Use when th |
| brand-guidelines | 78 | 116 | local | Applies Anthropic's official brand colors and typography to  |
| web-artifacts-builder | 78 | 108 | local | Suite of tools for creating elaborate, multi-component claud |
| api-connector-builder | 75 | 120 | ECC direct-port adaptation | Build a new API connector or provider by matching the target |
| frontend-a11y | 75 | 446 | community | > |
| frontend-slides | 75 | 184 | ECC | Create stunning, animation-rich HTML presentations from scra |
| motion-advanced | 75 | 596 | local | Advanced motion patterns for React / Next.js — drag & drop,  |
| motion-foundations | 73 | 299 | local | Motion tokens, spring presets, performance rules, device ada |
| ui-to-vue | 70 | 134 | community | Use when the user has UI screenshots or design exports that  |
| brand-voice | 68 | 97 | ECC | Build a source-derived writing style profile from real posts |
| ecc-guide | 65 | 189 | community | Guide users through ECC's current agents, skills, commands,  |
| remotion-video-creation | 65 | 43 | local | Best practices for Remotion - Video creation in React. 29 do |

### 医疗健康 (1 个, 平均 63 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| ralphinho-rfc-pipeline | 63 | 67 | ECC | RFC-driven multi-agent DAG execution pattern with quality ga |

### 多媒体 (4 个, 平均 77 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| slack-gif-creator | 81 | 297 | local | Knowledge and utilities for creating animated GIFs optimized |
| videodb | 80 | 374 | ECC | See, Understand, Act on video and audio. See- ingest from lo |
| video-editing | 75 | 310 | ECC | AI-assisted video editing workflows for cutting, structuring |
| manim-video | 73 | 89 | ECC | Build reusable Manim explainers for technical concepts, grap |

### 安全与合规 (21 个, 平均 78 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| click-path-audit | 83 | 244 | community | Trace every user-facing button/touchpoint through its full s |
| customs-trade-compliance | 83 | 263 | ECC | > |
| orion-deep-audit | 83 | 193 | local | Deep semantic code audit for silent-bypass / constraint-viol |
| production-audit | 83 | 206 | community | Local-evidence production readiness audit for shipped apps,  |
| security-bounty-hunter | 81 | 99 | ECC direct-port adaptation | Hunt for exploitable, bounty-worthy security issues in repos |
| defi-amm-security | 80 | 166 | ECC direct-port adaptation | Security checklist for Solidity AMM contracts, liquidity poo |
| healthcare-phi-compliance | 80 | 145 | Health1 Super Speciality Hospitals — contributed by Dr. Keyur Patel | Protected Health Information (PHI) and Personally Identifiab |
| llm-trading-agent-security | 80 | 146 | ECC direct-port adaptation | Security patterns for autonomous trading agents with wallet  |
| perl-security | 80 | 503 | ECC | Comprehensive Perl security covering taint mode, input valid |
| agent-architecture-audit | 78 | 256 | oh-my-agent-check | Full-stack diagnostic for agent and LLM applications. Audits |
| hipaa-compliance | 78 | 78 | ECC direct-port adaptation | HIPAA-specific entrypoint for healthcare privacy and securit |
| laravel-security | 78 | 285 | ECC | Laravel security best practices for authn/authz, validation, |
| automation-audit-ops | 75 | 142 | ECC | Evidence-first automation inventory and overlap audit workfl |
| django-security | 75 | 593 | ECC | Django security best practices, authentication, authorizatio |
| quarkus-security | 75 | 467 | ECC | Quarkus Security best practices for authentication, authoriz |
| security-review | 75 | 503 | ECC | Use this skill when adding authentication, handling user inp |
| security-scan | 75 | 167 | ECC | Scan your Claude Code configuration (.claude/ directory) for |
| workspace-surface-audit | 75 | 125 | ECC | Audit the active repo, MCP servers, plugins, connectors, env |
| safety-guard | 73 | 75 | ECC | Use this skill to prevent destructive operations when workin |
| springboot-security | 73 | 272 | ECC | Spring Security best practices for authn/authz, validation,  |
| ecc-tools-cost-audit | 70 | 160 | ECC | Evidence-first ECC Tools burn and billing audit workflow. Us |

### 工作流与规划 (15 个, 平均 79 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| brainstorming | 86 | 208 | local | You MUST use this before any creative work - creating featur |
| finishing-a-development-branch | 86 | 294 | local | Use when implementation is complete, all tests pass, and you |
| executing-plans | 83 | 119 | local | Use when you have a written implementation plan to execute i |
| plan-orchestrate | 83 | 262 | ECC | Read a plan document, decompose it into steps, design a per- |
| writing-skills | 83 | 672 | local | Use when creating new skills, editing existing skills, or ve |
| using-git-worktrees | 81 | 265 | local | Use when starting feature work that needs isolation from cur |
| skill-scout | 80 | 140 | community | Search existing local, marketplace, GitHub, and web skill so |
| find-skills | 78 | 180 | local | Helps users discover and install agent skills when they ask  |
| plankton-code-quality | 78 | 236 | community | Write-time code quality enforcement using Plankton — auto-fo |
| skill-creator | 78 | 523 | local | Create new skills, modify and improve existing skills, and m |
| using-superpowers | 78 | 166 | local | Use when starting any conversation - establishes how to find |
| darwin-skill | 73 | 196 | local | >- |
| skill-comply | 73 | 58 | ECC | Visualize whether skills, rules, and agent definitions are a |
| writing-plans | 73 | 194 | local | Use when you have a spec or requirements for a multi-step ta |
| skill-stocktake | 70 | 194 | ECC | Use when auditing Claude skills and commands for quality. Su |

### 数据与存储 (3 个, 平均 76 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| clickhouse-io | 80 | 439 | ECC | ClickHouse database patterns, query optimization, analytics, |
| database-migrations | 80 | 429 | ECC | Database migration best practices for schema changes, data m |
| data-throughput-accelerator | 68 | 72 | ECC | Use when large data ingestion, backfill, export, ETL, wareho |

### 文件处理 (7 个, 平均 78 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| docx | 83 | 638 | local | Use this skill whenever the user wants to create, read, edit |
| pdf | 83 | 360 | local | Use this skill whenever the user wants to do anything with P |
| pptx | 81 | 284 | local | Use this skill any time a .pptx file is involved in any way  |
| doc-coauthoring | 78 | 413 | local | Guide users through a structured workflow for co-authoring d |
| xlsx | 78 | 329 | local | Use this skill any time a spreadsheet file is the primary in |
| nutrient-document-processing | 70 | 167 | ECC | Process, convert, OCR, extract, redact, sign, and fill docum |
| visa-doc-translate | 70 | 117 | local | Translate visa application documents (images) to English and |

### 测试与评估 (23 个, 平均 76 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| kotlin-testing | 85 | 824 | ECC | Kotlin testing patterns with Kotest, MockK, coroutine testin |
| eval-harness | 83 | 270 | ECC | Formal evaluation framework for Claude Code sessions impleme |
| healthcare-eval-harness | 83 | 207 | Health1 Super Speciality Hospitals — contributed by Dr. Keyur Patel | Patient safety evaluation harness for healthcare application |
| iterative-retrieval | 83 | 211 | ECC | Pattern for progressively refining context retrieval to solv |
| test-driven-development | 83 | 401 | local | Use when implementing any feature or bugfix, before writing  |
| webapp-testing | 83 | 138 | local | Toolkit for interacting with and testing local web applicati |
| react-testing | 80 | 423 | ECC | React component testing with React Testing Library, Vitest/J |
| rust-testing | 80 | 500 | ECC | Rust testing patterns including unit tests, integration test |
| agent-eval | 75 | 145 | ECC | Head-to-head comparison of coding agents (Claude Code, Aider |
| ai-regression-testing | 75 | 385 | ECC | Regression testing strategies for AI-assisted development. S |
| cpp-testing | 75 | 324 | ECC | Use only when writing/updating/fixing C++ tests, configuring |
| csharp-testing | 75 | 321 | ECC | C# and .NET testing patterns with xUnit, FluentAssertions, m |
| golang-testing | 75 | 720 | ECC | Go testing patterns including table-driven tests, subtests,  |
| perl-testing | 75 | 475 | ECC | Perl testing patterns using Test2::V0, Test::More, prove run |
| python-testing | 75 | 816 | ECC | Python testing strategies using pytest, TDD methodology, fix |
| tdd-workflow | 75 | 463 | ECC | Use this skill when writing new features, fixing bugs, or re |
| windows-desktop-e2e | 75 | 887 | ECC | E2E testing for Windows native desktop apps (WPF, WinForms,  |
| benchmark | 73 | 93 | ECC | Use this skill to measure performance baselines, detect regr |
| fsharp-testing | 73 | 280 | ECC | F# testing patterns with xUnit, FsUnit, Unquote, FsCheck pro |
| e2e-testing | 70 | 326 | ECC | Playwright E2E testing patterns, Page Object Model, configur |
| scientific-thinking-scholar-evaluation | 70 | 160 | community | Structured scholarly-work evaluation for papers, proposals,  |
| swift-protocol-di-testing | 70 | 190 | ECC | Protocol-based dependency injection for testable Swift code  |
| benchmark-optimization-loop | 63 | 69 | ECC | Use when the user asks to make something faster, try many va |

### 研究与文档 (7 个, 平均 75 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| docs-navigator | 83 | 376 | local | Use when navigating large project documentation — scans docs |
| deep-research | 80 | 159 | ECC | Multi-source deep research using firecrawl and exa MCPs. Sea |
| documentation-lookup | 75 | 119 | ECC | Use up-to-date library and framework docs via Context7 MCP i |
| exa-search | 75 | 107 | ECC | Neural search via Exa MCP for web, code, and company researc |
| search-first | 75 | 182 | ECC | Research-before-coding workflow. Search for existing tools,  |
| market-research | 71 | 75 | ECC | Conduct market research, competitive analysis, investor due  |
| prediction-market-oracle-research | 63 | 63 | ECC | Research prediction markets as data sources or oracle signal |

### 网络与基础设施 (9 个, 平均 76 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| homelab-vlan-segmentation | 85 | 311 | community | Segmenting home networks into VLANs for IoT, guest, trusted, |
| network-config-validation | 83 | 210 | community | Pre-deployment checks for router and switch configuration, i |
| homelab-network-setup | 80 | 129 | community | Practical home and homelab network planning for gateways, sw |
| network-interface-health | 80 | 152 | community | Diagnose interface errors, drops, CRCs, duplex mismatches, f |
| homelab-wireguard-vpn | 75 | 305 | community | WireGuard VPN server setup, peer configuration, key generati |
| homelab-pihole-dns | 73 | 274 | community | Pi-hole installation, blocklist management, DNS-over-HTTPS s |
| homelab-network-readiness | 70 | 169 | community | Readiness checklist for homelab VLAN segmentation, local DNS |
| netmiko-ssh-automation | 70 | 173 | community | Safe Python Netmiko patterns for read-only collection, bound |
| network-bgp-diagnostics | 70 | 167 | community | Diagnostics-only BGP troubleshooting patterns for neighbor s |

### 营销与内容 (5 个, 平均 76 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| seo | 80 | 154 | ECC | Audit, plan, and implement SEO improvements across technical |
| crosspost | 78 | 111 | ECC | Multi-platform content distribution across X, LinkedIn, Thre |
| marketing-campaign | 78 | 113 | ECC | End-to-end marketing campaign planning and execution. Covers |
| content-engine | 73 | 131 | ECC | Create platform-native content systems for X, LinkedIn, TikT |
| article-writing | 71 | 79 | ECC | Write articles, guides, blog posts, tutorials, newsletter is |

### 设计与架构 (14 个, 平均 77 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| code-design-analyzer | 83 | 1399 | local | Use when analyzing existing code against design documents, i |
| design-constraint | 83 | 738 | local | Use when the user asks to check frontend interactions, code  |
| design-architect | 81 | 299 | local | Use when designing a new system architecture from scratch —  |
| blueprint | 80 | 105 | community | >- |
| canvas-design | 78 | 172 | local | Create beautiful visual art in .png and .pdf documents using |
| design-system | 78 | 82 | ECC | Use this skill to generate or audit design systems, check vi |
| hexagonal-architecture | 78 | 276 | ECC | Design, implement, and refactor Ports & Adapters systems wit |
| frontend-design | 76 | 85 | local | Create distinctive, production-grade frontend interfaces wit |
| android-clean-architecture | 75 | 339 | ECC | Clean Architecture patterns for Android and Kotlin Multiplat |
| api-design | 75 | 523 | ECC | REST API design patterns including resource naming, status c |
| architecture-decision-records | 75 | 179 | ECC | Capture architectural decisions made during Claude Code sess |
| recsys-pipeline-architect | 75 | 114 | community | Design composable recommendation, ranking, and feed pipeline |
| liquid-glass-design | 73 | 279 | local | iOS 26 Liquid Glass design system — dynamic glass material w |
| frontend-design-direction | 68 | 92 | community | Set an ECC-specific frontend design direction for production |

### 调试与排错 (3 个, 平均 81 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| systematic-debugging | 93 | 334 | local | Use when encountering any bug, test failure, or unexpected b |
| agent-introspection-debugging | 75 | 153 | ECC | Structured self-debugging workflow for AI agent failures usi |
| error-handling | 75 | 376 | ECC | Patterns for robust error handling across TypeScript, Python |

### 部署与运维 (25 个, 平均 74 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| orion-workflow | 86 | 244 | local | Use when you need to define and execute multi-skill executio |
| autonomous-loops | 85 | 616 | ECC | Patterns and architectures for autonomous Claude Code loops  |
| council | 83 | 203 | ECC | Convene a four-voice council for ambiguous decisions, tradeo |
| customer-billing-ops | 80 | 140 | ECC | Operate customer billing workflows such as subscriptions, re |
| evm-token-decimals | 80 | 130 | ECC direct-port adaptation | Prevent silent decimal mismatch bugs across EVM chains. Cove |
| dmux-workflows | 75 | 191 | ECC | Multi-agent orchestration using dmux (tmux pane manager for  |
| email-ops | 75 | 121 | ECC | Evidence-first mailbox triage, drafting, send verification,  |
| finance-billing-ops | 75 | 127 | ECC | Evidence-first revenue, pricing, refunds, team-billing, and  |
| git-workflow | 75 | 715 | ECC | Git workflow patterns including branching strategies, commit |
| messages-ops | 75 | 104 | ECC | Evidence-first live messaging workflow for ECC. Use when the |
| mle-workflow | 75 | 346 | ECC | Production machine-learning engineering workflow for data co |
| research-ops | 75 | 112 | ECC | Evidence-first current-state research workflow for ECC. Use  |
| terminal-ops | 75 | 109 | ECC | Evidence-first repo execution workflow for ECC. Use when the |
| unified-notifications-ops | 75 | 187 | ECC | Operate notifications as one ECC-native workflow across GitH |
| github-ops | 73 | 144 | ECC | GitHub repository operations, automation, and management. Is |
| google-workspace-ops | 73 | 95 | ECC | Operate across Google Drive, Docs, Sheets, and Slides as one |
| knowledge-ops | 73 | 154 | ECC | Knowledge base management, ingestion, sync, and retrieval ac |
| project-flow-ops | 70 | 111 | ECC | Operate execution flow across GitHub and Linear by triaging  |
| scientific-db-pubmed-database | 70 | 175 | community | Direct PubMed and NCBI E-utilities search workflows for biom |
| scientific-db-uspto-database | 70 | 177 | community | USPTO patent and trademark data workflow for official record |
| scientific-pkg-gget | 70 | 166 | community | gget CLI and Python workflow for quick genomic database quer |
| social-graph-ranker | 70 | 154 | ECC | Weighted social-graph ranking for warm intro discovery, brid |
| social-publisher | 70 | 115 | community | Agent-driven scheduling and publishing of social media posts |
| recursive-decision-ledger | 63 | 79 | ECC | Use when the user asks for repeated rollouts, marked decisio |
| enterprise-agent-ops | 60 | 50 | ECC | Operate long-lived agent workloads with observability, secur |

### 配置与指南 (4 个, 平均 76 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| rules-distill | 83 | 264 | ECC | Scan skills to extract cross-cutting principles and distill  |
| nodejs-keccak256 | 80 | 102 | ECC direct-port adaptation | Prevent Ethereum hashing bugs in JavaScript and TypeScript.  |
| configure-ecc | 75 | 384 | ECC | Interactive installer for Everything Claude Code — guides us |
| hookify-rules | 65 | 128 | local | This skill should be used when the user asks to create a hoo |

### 语言/框架模式 (37 个, 平均 77 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| dart-flutter-patterns | 85 | 563 | ECC | Production-ready Dart and Flutter patterns covering null saf |
| fastapi-patterns | 85 | 327 | community | FastAPI patterns for async APIs, dependency injection, Pydan |
| kotlin-exposed-patterns | 85 | 719 | ECC | JetBrains Exposed ORM patterns including DSL queries, DAO pa |
| kotlin-patterns | 85 | 711 | ECC | Idiomatic Kotlin patterns, best practices, and conventions f |
| laravel-patterns | 85 | 415 | ECC | Laravel architecture patterns, routing/controllers, Eloquent |
| redis-patterns | 85 | 403 | ECC | Redis data structure patterns, caching strategies, distribut |
| vite-patterns | 85 | 449 | ECC | Vite build tool patterns including config, plugins, HMR, env |
| healthcare-cdss-patterns | 83 | 245 | Health1 Super Speciality Hospitals — contributed by Dr. Keyur Patel | Clinical Decision Support System (CDSS) development patterns |
| tinystruct-patterns | 83 | 203 | ECC | Expert guidance for developing with the tinystruct Java fram |
| healthcare-emr-patterns | 80 | 159 | Health1 Super Speciality Hospitals — contributed by Dr. Keyur Patel | EMR/EHR development patterns for healthcare applications. Cl |
| perl-patterns | 80 | 504 | ECC | Modern Perl 5.36+ idioms, best practices, and conventions fo |
| react-patterns | 80 | 341 | ECC | React 18/19 patterns including hooks discipline, server/clie |
| rust-patterns | 80 | 499 | ECC | Idiomatic Rust patterns, ownership, error handling, traits,  |
| mcp-server-patterns | 78 | 69 | ECC | Build MCP servers with Node/TypeScript SDK — tools, resource |
| backend-patterns | 75 | 561 | ECC | Backend architecture patterns, API design, database optimiza |
| deployment-patterns | 75 | 427 | ECC | Deployment workflows, CI/CD pipeline patterns, Docker contai |
| django-patterns | 75 | 734 | ECC | Django architecture patterns, REST API design with DRF, ORM  |
| docker-patterns | 75 | 364 | ECC | Docker and Docker Compose patterns for local development, co |
| dotnet-patterns | 75 | 321 | ECC | Idiomatic C# and .NET patterns, conventions, dependency inje |
| frontend-patterns | 75 | 642 | ECC | Frontend development patterns for React, Next.js, state mana |
| golang-patterns | 75 | 674 | ECC | Idiomatic Go patterns, best practices, and conventions for b |
| kotlin-ktor-patterns | 75 | 689 | ECC | Ktor server patterns including routing DSL, plugins, authent |
| motion-patterns | 75 | 435 | local | Production-ready animation patterns for React / Next.js — bu |
| prisma-patterns | 75 | 371 | ECC | Prisma ORM patterns for TypeScript backends — schema design, |
| python-patterns | 75 | 750 | ECC | Pythonic idioms, PEP 8 standards, type hints, and best pract |
| pytorch-patterns | 75 | 396 | ECC | PyTorch deep learning patterns and best practices for buildi |
| quarkus-patterns | 75 | 722 | ECC | Quarkus 3.x LTS architecture patterns with Camel for messagi |
| springboot-patterns | 75 | 314 | ECC | Spring Boot architecture patterns, REST API design, layered  |
| compose-multiplatform-patterns | 73 | 299 | ECC | Compose Multiplatform and Jetpack Compose patterns for KMP p |
| nestjs-patterns | 73 | 230 | ECC | NestJS architecture patterns for modules, controllers, provi |
| swiftui-patterns | 73 | 259 | local | SwiftUI architecture patterns, state management with @Observ |
| cisco-ios-patterns | 70 | 163 | community | Cisco IOS and IOS-XE review patterns for show commands, conf |
| content-hash-cache-pattern | 70 | 161 | ECC | Cache expensive file processing results using SHA-256 conten |
| jpa-patterns | 70 | 151 | ECC | JPA/Hibernate patterns for entity design, relationships, que |
| mysql-patterns | 70 | 412 | ECC | MySQL and MariaDB schema, query, indexing, transaction, repl |
| postgres-patterns | 70 | 147 | ECC | PostgreSQL database patterns for query optimization, schema  |
| nuxt4-patterns | 68 | 100 | ECC | Nuxt 4 app patterns for hydration safety, performance, route |

### Agent与自动化 (14 个, 平均 75 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| subagent-driven-development | 93 | 320 | local | Use when executing implementation plans with independent tas |
| dispatching-parallel-agents | 86 | 209 | local | Use when facing 2+ independent tasks that can be worked on w |
| data-scraper-agent | 85 | 764 | community | Build a fully automated AI-powered data collection agent for |
| agent-payment-x402 | 83 | 224 | community | Add x402 payment execution to AI agents with per-task budget |
| autonomous-agent-harness | 78 | 273 | ECC | Transform Claude Code into a fully autonomous agent system w |
| gan-style-harness | 78 | 278 | ECC-community | GAN-inspired Generator-Evaluator agent harness for building  |
| agentic-os | 75 | 387 | ECC | Build persistent multi-agent operating systems on Claude Cod |
| verification-loop | 75 | 126 | ECC | A comprehensive verification system for Claude Code sessions |
| agent-sort | 73 | 215 | ECC | Build an evidence-backed ECC install plan for a specific rep |
| continuous-agent-loop | 70 | 103 | ECC | Patterns for continuous autonomous agent loops with quality  |
| ito-data-atlas-agent | 68 | 63 | ECC | Design background Data Atlas style agents for Itô basket res |
| agent-harness-construction | 63 | 73 | ECC | Design and optimize AI agent action spaces, tool definitions |
| agentic-engineering | 63 | 67 | ECC | Operate as an agentic engineer using eval-first execution, d |
| parallel-execution-optimizer | 63 | 72 | ECC | Use when the user wants a task done much faster through para |

### API与集成 (2 个, 平均 78 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| claude-api | 83 | 357 | local | Build, debug, and optimize Claude API / Anthropic SDK apps.  |
| x-api | 73 | 234 | ECC | X/Twitter API integration for posting tweets, threads, readi |

### Orion生态 (13 个, 平均 83 分)

| 技能 | 分数 | 行数 | 来源 | 用途 |
|------|------|------|------|------|
| orion-repairing | 86 | 216 | local | When an orion-managed skill is failing, scoring below thresh |
| orion-alerts | 83 | 182 | local | Use when you need to monitor skill health trends, set up sco |
| orion-analytics | 83 | 159 | local | Use when you need to analyze execution history, query JSONL  |
| orion-archive | 83 | 139 | local | Use when you need to safely retire, deprecate, or archive a  |
| orion-assessor | 83 | 116 | local | Use when a quick lightweight assessment of an orion skill is |
| orion-batch | 83 | 192 | local | Use when you need to perform batch operations on multiple or |
| orion-crystallizing | 83 | 153 | local | Use when a skill has proven itself with consistently high sc |
| orion-dashboard | 83 | 129 | local | To get an overview of all orion-managed skills showing their |
| orion-gap-detect | 83 | 138 | local | Analyze task requirements against existing skill registry to |
| orion-rollback | 83 | 143 | local | Use when you need to restore a crystallized skill to a previ |
| orion-scoring | 83 | 168 | local | After any orion-managed skill execution to rate performance  |
| orion-using | 83 | 197 | local | Entry point for the orion skill ecosystem. Routes to create/ |
| orion-creating | 81 | 261 | local | Use when a new reusable skill needs to be built — detected b |
