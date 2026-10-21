import { useState } from 'react';
import type { ReactElement } from 'react';
import { Button, Popover, Space, Switch, Tag, Typography } from 'antd';
import { DownOutlined, RightOutlined } from '@ant-design/icons';
import type { IdentifiedFinding } from '@ai-review/shared/api';
import { diffStats, isLineInRanges, parseUnifiedDiff } from '../lib/diff';
import type { DiffFile, LineRange } from '../lib/diff';
import { EmptyState } from './EmptyState';

export type DiffViewerProps = {
  diffText: string | null;
  findings: IdentifiedFinding[];
  /** 点击行尾问题标记时定位到发现卡片 */
  onSelectFinding?: (finding: IdentifiedFinding) => void;
};

function rangesByFile(findings: readonly IdentifiedFinding[]): Map<string, LineRange[]> {
  const map = new Map<string, LineRange[]>();
  for (const finding of findings) {
    const key = finding.filePath.replace(/\\/g, '/');
    const ranges = map.get(key) ?? [];
    ranges.push({ start: finding.lineStart, end: finding.lineEnd });
    map.set(key, ranges);
  }
  return map;
}

function findFileRanges(file: DiffFile, index: Map<string, LineRange[]>): LineRange[] {
  const direct = index.get(file.path) ?? index.get(file.oldPath);
  return direct ?? [];
}

/** 基于统一 diff 的代码差异视图：文件分组、双行号、问题行标记与折叠。 */
export function DiffViewer(props: DiffViewerProps): ReactElement {
  // React Compiler 会缓存该派生结果，无需手写 useMemo
  const files = parseUnifiedDiff(props.diffText);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [wrap, setWrap] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);

  if (props.diffText === null || props.diffText.trim() === '') {
    return (
      <EmptyState
        title="这份报告没有可用的 diff"
        description="审查记录可能来自 CLI 直跑，或该提交未产生文本差异。"
      />
    );
  }
  if (files.length === 0) {
    return (
      <EmptyState
        title="无法解析 diff 内容"
        description="差异可能不是标准 unified diff 格式，请下载原始报告查看。"
      />
    );
  }

  const index = rangesByFile(props.findings);
  const filesWithIssues = files.filter((file) => findFileRanges(file, index).length > 0);
  const visibleFiles = onlyIssues ? filesWithIssues : files;
  const stats = diffStats(files);

  const toggle = (path: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="diff-viewer">
      <div className="diff-toolbar">
        <Space wrap size={12}>
          <Typography.Text strong>
            {files.length} 个文件
            <span className="diff-stat-add"> +{stats.additions}</span>
            <span className="diff-stat-del"> −{stats.deletions}</span>
          </Typography.Text>
          <Space size={6}>
            <Switch size="small" checked={wrap} onChange={setWrap} aria-label="自动换行" />
            <Typography.Text type="secondary">自动换行</Typography.Text>
          </Space>
          <Space size={6}>
            <Switch
              size="small"
              checked={onlyIssues}
              onChange={setOnlyIssues}
              aria-label="仅看含问题的文件"
            />
            <Typography.Text type="secondary">仅看含问题的文件</Typography.Text>
          </Space>
        </Space>
        <Space>
          <Button size="small" onClick={() => setCollapsed(new Set())}>
            全部展开
          </Button>
          <Button size="small" onClick={() => setCollapsed(new Set(files.map((f) => f.path)))}>
            全部折叠
          </Button>
        </Space>
      </div>

      {onlyIssues && visibleFiles.length === 0 ? (
        <EmptyState
          title="已开启「仅看含问题的文件」"
          description="当前 diff 中没有与发现关联的文件。"
        />
      ) : null}

      {visibleFiles.map((file) => {
        const ranges = findFileRanges(file, index);
        const isCollapsed = collapsed.has(file.path);
        return (
          <section className="diff-file" key={file.path}>
            <header className="diff-file-head">
              <button
                type="button"
                className="diff-file-toggle"
                onClick={() => toggle(file.path)}
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? <RightOutlined /> : <DownOutlined />}
                <span className="diff-file-path">{file.path}</span>
              </button>
              <Space size={6} wrap>
                {file.isNew ? <Tag color="green">新增文件</Tag> : null}
                {file.isDeleted ? <Tag color="red">删除文件</Tag> : null}
                {file.isBinary ? <Tag>二进制</Tag> : null}
                {ranges.length > 0 ? <Tag color="warning">{ranges.length} 处问题</Tag> : null}
                <span className="diff-stat-add">+{file.additions}</span>
                <span className="diff-stat-del">−{file.deletions}</span>
              </Space>
            </header>
            {isCollapsed ? null : file.isBinary ? (
              <div className="diff-empty">二进制文件不展示逐行差异。</div>
            ) : (
              <div className={`diff-body${wrap ? ' is-wrap' : ''}`}>
                {file.hunks.map((hunk) => (
                  <div className="diff-hunk" key={`${file.path}:${hunk.header}`}>
                    <div className="diff-hunk-head">{hunk.header}</div>
                    <table className="diff-table">
                      <tbody>
                        {hunk.lines.map((line, lineIndex) => {
                          const flagged =
                            line.newLine !== null && isLineInRanges(line.newLine, ranges);
                          const related = flagged
                            ? props.findings.filter(
                                (finding) =>
                                  finding.filePath.replace(/\\/g, '/') === file.path &&
                                  line.newLine !== null &&
                                  line.newLine >= finding.lineStart &&
                                  line.newLine <= finding.lineEnd,
                              )
                            : [];
                          const className = [
                            'diff-line',
                            `diff-line-${line.kind}`,
                            flagged ? 'is-flagged' : '',
                          ]
                            .filter(Boolean)
                            .join(' ');
                          const marker = related.length > 0;
                          return (
                            <tr className={className} key={`${hunk.header}:${lineIndex}`}>
                              <td className="diff-gutter diff-gutter-old">{line.oldLine ?? ''}</td>
                              <td className="diff-gutter diff-gutter-new">
                                {line.newLine ?? ''}
                                {marker ? (
                                  <Popover
                                    trigger="click"
                                    placement="right"
                                    content={
                                      <div className="diff-finding-popover">
                                        {related.map((finding) => (
                                          <div key={finding.id} className="diff-finding-item">
                                            <Space size={6}>
                                              <Tag
                                                color={
                                                  finding.severity === 'BLOCKER'
                                                    ? 'error'
                                                    : finding.severity === 'WARNING'
                                                      ? 'warning'
                                                      : 'default'
                                                }
                                              >
                                                {finding.severity}
                                              </Tag>
                                              <Typography.Text strong>
                                                {finding.title}
                                              </Typography.Text>
                                            </Space>
                                            <Typography.Paragraph
                                              type="secondary"
                                              ellipsis={{ rows: 3 }}
                                              style={{ margin: '6px 0 0' }}
                                            >
                                              {finding.description}
                                            </Typography.Paragraph>
                                            {props.onSelectFinding === undefined ? null : (
                                              <Button
                                                size="small"
                                                type="link"
                                                style={{ paddingInline: 0 }}
                                                onClick={() => props.onSelectFinding?.(finding)}
                                              >
                                                在发现列表中查看
                                              </Button>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    }
                                  >
                                    <button
                                      type="button"
                                      className="diff-flag"
                                      aria-label="打开问题卡片"
                                    >
                                      <span
                                        className={`diff-flag-dot severity-${related[0]?.severity.toLowerCase() ?? 'warning'}`}
                                      />
                                    </button>
                                  </Popover>
                                ) : null}
                              </td>
                              <td className="diff-code">{line.text === '' ? ' ' : line.text}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
