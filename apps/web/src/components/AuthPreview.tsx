import type { ReactElement } from 'react';
import { Tag } from 'antd';

/** 登录页的装饰性“审查结果”预览，用纯 CSS 组件表达产品能力，不依赖图片资源。 */
export function AuthPreview(): ReactElement {
  return (
    <div className="auth-preview" aria-hidden="true">
      <div className="auth-preview-top">
        <span className="auth-preview-dot" />
        <span className="auth-preview-dot" />
        <span className="auth-preview-dot" />
        <span className="auth-preview-file">src/auth/session.ts</span>
        <span className="auth-preview-stat auth-preview-add">+42</span>
        <span className="auth-preview-stat auth-preview-del">−7</span>
      </div>
      <div className="auth-preview-code">
        <div className="auth-preview-line">
          <span className="auth-preview-no">18</span>
          <span className="auth-preview-sign"> </span>
          <span>export async function createSession(user: User) {'{'}</span>
        </div>
        <div className="auth-preview-line auth-preview-line-remove">
          <span className="auth-preview-no">19</span>
          <span className="auth-preview-sign">−</span>
          <span> return db.insert(sessions).values(user)</span>
        </div>
        <div className="auth-preview-line auth-preview-line-add auth-preview-line-finding">
          <span className="auth-preview-no">19</span>
          <span className="auth-preview-sign">+</span>
          <span> if (!user.id) throw new Error('missing user')</span>
        </div>
        <div className="auth-preview-line auth-preview-line-add">
          <span className="auth-preview-no">20</span>
          <span className="auth-preview-sign">+</span>
          <span>
            {' '}
            return db.insert(sessions).values({'{'} ...user, createdAt: now() {'}'})
          </span>
        </div>
        <div className="auth-preview-line">
          <span className="auth-preview-no">21</span>
          <span className="auth-preview-sign"> </span>
          <span>{'}'}</span>
        </div>
      </div>
      <div className="auth-preview-findings">
        <div className="auth-preview-finding">
          <Tag color="error" variant="filled">
            BLOCKER
          </Tag>
          <span>会话创建缺少过期时间校验</span>
          <span className="auth-preview-confidence">92%</span>
        </div>
        <div className="auth-preview-finding">
          <Tag color="warning" variant="filled">
            WARNING
          </Tag>
          <span>错误信息可能泄露内部字段</span>
          <span className="auth-preview-confidence">78%</span>
        </div>
      </div>
      <div className="auth-preview-footer">
        <span>综合风险评分</span>
        <strong>32</strong>
        <span className="auth-preview-score-suffix">/100</span>
        <span className="auth-preview-badge">可合并</span>
      </div>
    </div>
  );
}
