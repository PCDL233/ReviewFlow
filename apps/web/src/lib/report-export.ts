/** 打印样式：去掉屏幕端的灰底与卡片阴影，避免打印出大片色块和空白页。 */
const PRINT_CSS = `
@media print {
  @page { margin: 14mm; }
  html, body { background: #fff !important; }
  .wrap { max-width: none; padding: 0; }
  .panel { border: 0; border-radius: 0; padding: 0; margin: 0 0 16px; break-inside: avoid; }
  h1, h2 { break-after: avoid; }
  tr, li { break-inside: avoid; }
}
`;

/**
 * 给服务端渲染的 HTML 报告注入打印样式。
 *
 * 导出端点的 HTML 自带屏幕配色（灰底 + 卡片），直接打印会浪费墨粉且易出现空白页，
 * 这里只在文档层面追加 @media print 覆盖，不改动报告正文，便于与页面预览保持一致。
 */
export function buildPrintHtml(documentHtml: string): string {
  const style = `<style>${PRINT_CSS}</style>`;
  const headEnd = documentHtml.indexOf('</head>');
  if (headEnd === -1) return `${style}${documentHtml}`;
  return `${documentHtml.slice(0, headEnd)}${style}${documentHtml.slice(headEnd)}`;
}

/**
 * 在新窗口打开报告并唤起打印对话框（用户可选择"另存为 PDF"）。
 *
 * 窗口必须在 await 之前同步打开：浏览器只允许在用户手势内 open，
 * 异步拿到 HTML 后再 open 会被拦截。因此调用方先拿窗口，再拉取 HTML 写入。
 */
export function openReportWindow(): Window | null {
  return window.open('', '_blank', 'width=1024,height=768');
}

/** 把报告写入已打开的窗口，并在文档就绪后唤起打印对话框。 */
export function printReportInto(win: Window, documentHtml: string): void {
  win.document.open();
  win.document.write(buildPrintHtml(documentHtml));
  win.document.close();
  // 部分浏览器写入后 readyState 已是 complete，load 不会再触发，故双保险
  const triggerPrint = (): void => {
    win.focus();
    win.print();
  };
  if (win.document.readyState === 'complete') {
    window.setTimeout(triggerPrint, 0);
    return;
  }
  win.addEventListener('load', triggerPrint, { once: true });
}
