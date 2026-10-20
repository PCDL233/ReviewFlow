import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { CheckOutlined, CopyOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';

export type CodeBlockProps = {
  code: string;
  title?: string;
  maxHeight?: number;
  showLineNumbers?: boolean;
  className?: string;
};

/** 代码/脚本展示块：等宽字体、可选行号、复制反馈，供 Hook 脚本、配置与片段复用。 */
export function CodeBlock(props: CodeBlockProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.code);
      setCopied(true);
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const lines = props.code.split('\n');

  return (
    <div className={`code-block${props.className === undefined ? '' : ` ${props.className}`}`}>
      <div className="code-block-head">
        <span className="code-block-title">{props.title ?? '代码'}</span>
        <Tooltip title={copied ? '已复制' : '复制全部'}>
          <Button
            type="text"
            size="small"
            className="code-block-copy"
            icon={copied ? <CheckOutlined /> : <CopyOutlined />}
            aria-label={copied ? '已复制' : '复制代码'}
            onClick={() => void handleCopy()}
          >
            {copied ? '已复制' : '复制'}
          </Button>
        </Tooltip>
      </div>
      <pre
        className="code-block-body"
        style={props.maxHeight === undefined ? {} : { maxHeight: props.maxHeight }}
      >
        <code>
          {props.showLineNumbers
            ? lines.map((line, index) => (
                <span className="code-line" key={`${index}-${line}`}>
                  <span className="code-line-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="code-line-text">{line === '' ? ' ' : line}</span>
                </span>
              ))
            : props.code}
        </code>
      </pre>
    </div>
  );
}
