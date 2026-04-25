#!/usr/bin/env bun
/**
 * 发布构建共享配置
 *
 * 所有 publish 相关脚本共用的常量和配置。
 */

/** 发布到 npm 的包名 */
export const PUBLISH_PACKAGE_NAME = '@zyzheal/ola-cc'

/** 发布包的 npm scope */
export const PUBLISH_SCOPE = '@zyzheal'

/** 发布包的基础名（不含 scope） */
export const PUBLISH_BASE_NAME = 'ola-cc'
