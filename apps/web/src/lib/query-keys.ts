/**
 * 跨页面共享的查询键。
 * 关键约束：同一 queryKey 必须对应唯一的数据形状——AI 模型页与系统配置页
 * 曾各自以同一键缓存“配置”和“配置 + 运行环境”，先打开哪个页面就决定了缓存形状，
 * 另一个页面随后读到的字段全部落空，保存时会把整份配置重置为默认值。
 */

/** 系统配置（含只读运行环境）：AdminConfigPage / AdminAiConfigPage / AdminInitPage 共用。 */
export const ADMIN_CONFIG_QUERY_KEY = ['admin', 'config'] as const;

/** 知识库索引状态：按仓库维度缓存（索引按仓库隔离）。 */
export const ADMIN_KNOWLEDGE_QUERY_KEY = ['admin', 'knowledge'] as const;

/** 后台用户列表。 */
export const ADMIN_USERS_QUERY_KEY = ['admin', 'users'] as const;

/** 后台角色列表。 */
export const ADMIN_ROLES_QUERY_KEY = ['admin', 'roles'] as const;

/** 仓库候选列表（发起审查、Hook 安装、知识库切换共用）。 */
export const REPOS_QUERY_KEY = ['repos'] as const;
