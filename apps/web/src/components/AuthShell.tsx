import { useEffect } from 'react';
import type { ReactElement, ReactNode } from 'react';
import {
  CheckCircleFilled,
  LineChartOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { BrandMark } from './Brand';
import { AuthPreview } from './AuthPreview';

export type AuthShellProps = {
  mode: 'login' | 'register';
  title: string;
  subtitle: string;
  error?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
};

const POINTS = [
  { icon: <SafetyCertificateOutlined />, text: '确定性静态分析先行，能由工具判断的不交给模型' },
  { icon: <ThunderboltOutlined />, text: '正确性、安全性、性能三维并行审查，分钟级反馈' },
  { icon: <LineChartOutlined />, text: '风险趋势与发现沉淀，让每次合并都有据可依' },
];

/** 登录 / 注册共用外壳：品牌叙事、能力点与装饰性审查预览。 */
export function AuthShell(props: AuthShellProps): ReactElement {
  useEffect(() => {
    document.title = `${props.mode === 'login' ? '登录' : '注册'} · ReviewFlow`;
  }, [props.mode]);

  const headline =
    props.mode === 'login' ? (
      <>
        让代码质量
        <br />
        成为团队的共识。
      </>
    ) : (
      <>
        从第一次提交，
        <br />
        建立团队的审查习惯。
      </>
    );

  const description =
    props.mode === 'login'
      ? '从一次提交，到整个团队的工程质量。用更清晰的洞察，把时间花在真正重要的地方。'
      : '建立你的质量工作区，集中管理审查记录、风险趋势与团队协作反馈。';

  return (
    <div className="auth-shell">
      <aside className="auth-visual">
        <div className="auth-visual-glow" aria-hidden="true" />
        <div className="auth-visual-grid" aria-hidden="true" />
        <div className="auth-brand">
          <BrandMark />
          <div>
            <div className="auth-brand-title">ReviewFlow</div>
            <div className="auth-brand-subtitle">CODE REVIEW CONSOLE</div>
          </div>
        </div>
        <div className="auth-visual-copy">
          <div className="auth-eyebrow">AI CODE REVIEW</div>
          <h1 className="auth-visual-title">{headline}</h1>
          <p className="auth-visual-description">{description}</p>
          <ul className="auth-points">
            {POINTS.map((point) => (
              <li key={point.text}>
                <span className="auth-point-icon">{point.icon}</span>
                <span>{point.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <AuthPreview />
        <div className="auth-quote">
          <CheckCircleFilled /> 静态分析优先 · 证据可追溯 · 结果可回放
        </div>
      </aside>
      <main className="auth-form-side">
        <div className="auth-form-wrap">
          <div className="auth-mobile-brand">
            <BrandMark />
            <div>
              <div className="auth-brand-title">ReviewFlow</div>
              <div className="auth-brand-subtitle">CODE REVIEW CONSOLE</div>
            </div>
          </div>
          <div className="auth-form-head">
            <div className="auth-form-kicker">
              {props.mode === 'login' ? 'WELCOME BACK' : 'CREATE WORKSPACE'}
            </div>
            <h2 className="auth-form-title">{props.title}</h2>
            <p className="auth-form-subtitle">{props.subtitle}</p>
          </div>
          {props.error ? <div className="auth-form-error">{props.error}</div> : null}
          {props.children}
          <div className="auth-footnote">{props.footer}</div>
        </div>
      </main>
    </div>
  );
}
