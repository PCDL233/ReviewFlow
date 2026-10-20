import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildToolsMcpServer } from '@ai-review/tools';

/**
 * 为一次 HTTP 请求创建无状态 MCP 传输层。
 *
 * 选择无状态模式（不生成 sessionId）的理由：本项目暴露的是四个无副作用的只读分析工具，
 * 不需要跨请求的消息历史；无状态模式不必维护会话映射，进程重启也不会留下悬挂会话。
 * @returns 可直接接收入站 Request 的传输层
 */
export function createMcpTransport(): WebStandardStreamableHTTPServerTransport {
  return new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
}

/**
 * 处理一次 MCP over HTTP 调用。
 * 每次请求新建 server + transport：工具本身是纯函数，无跨请求状态，
 * 这样既避免并发共享单例的竞态，也保证连接用完即释放。
 * @param request 入站 Request
 * @returns MCP 协议响应
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const server = buildToolsMcpServer();
  const transport = createMcpTransport();
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // 无状态模式下请求结束即结束传输；关闭失败不影响已生成的响应
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}
