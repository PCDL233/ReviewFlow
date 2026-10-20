import type { ReactElement } from 'react';
import { ArrowRightOutlined, HistoryOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { Button, Progress, Statistic, Tag } from 'antd';

export type WelcomePanelProps = {
  username: string;
  role: 'admin' | 'user' | undefined;
  totalReviews: number;
  avgRiskScore: number;
  loading: boolean;
  onRun: () => void;
  onHistory: () => void;
};

function greetingOf(hour: number): string {
  if (hour < 6) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

/** 工作台首屏：问候、角色、质量环与两条主路径，避免和下方快捷入口重复。 */
export function WelcomePanel(props: WelcomePanelProps): ReactElement {
  const hour = new Date().getHours();
  const risk = Math.max(0, Math.min(100, Math.round(props.avgRiskScore)));
  const riskColor = risk >= 70 ? 'var(--error)' : risk >= 40 ? 'var(--warning)' : 'var(--success)';

  return (
    <section className="home-hero" aria-labelledby="home-greeting">
      <div className="home-hero-copy">
        <div className="home-greeting" id="home-greeting">
          {greetingOf(hour)}，{props.username}
          {props.role === 'admin' ? (
            <Tag color="gold" variant="filled">
              管理员
            </Tag>
          ) : null}
        </div>
        <h1 className="home-hero-title">今天也从一次清晰的审查开始。</h1>
        <p className="home-hero-sub">
          查看团队最近的风险发现，发起一轮新的审查，或继续跟进尚未处理的报告。
        </p>
        <div className="home-hero-actions">
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={props.onRun}>
            发起审查
          </Button>
          <Button icon={<HistoryOutlined />} onClick={props.onHistory}>
            查看历史报告
          </Button>
        </div>
      </div>
      <div className="home-hero-side">
        <div className="home-score">
          <Progress
            type="circle"
            size={92}
            percent={risk}
            strokeColor={riskColor}
            railColor="var(--line)"
            format={() => (
              <span className="home-score-label">
                <strong>{props.loading ? '—' : risk}</strong>
                <span>平均风险</span>
              </span>
            )}
          />
          <span className="home-score-label">0–100 · 越低越好</span>
        </div>
        <Statistic
          className="home-hero-stat"
          title="累计审查"
          value={props.totalReviews}
          loading={props.loading}
          suffix={<span style={{ fontSize: 11, color: 'var(--faint)' }}>次</span>}
        />
        <Button
          type="text"
          className="home-hero-more"
          icon={<ArrowRightOutlined />}
          aria-label="查看统计分析"
          onClick={props.onHistory}
        />
      </div>
    </section>
  );
}
