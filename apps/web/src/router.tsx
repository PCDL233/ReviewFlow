import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  Outlet,
  useNavigate,
} from '@tanstack/react-router';
import { lazy } from 'react';
import type { ReactElement } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { User } from '@ai-review/shared/api';
import { fetchMe } from './api/auth';
import { AUTH_QUERY_KEY } from './hooks/use-auth';
import { canAccessPath, firstPermittedAdminPath, hasAdminAccess } from './permissions';
import { queryClient } from './query-client';
import { NotFoundPage, RouteErrorState, RouteLoading } from './components/RouteState';
import { parseReviewSearch, serializeReviewSearch } from './lib/search-params';
import type { ReviewSearch } from './lib/search-params';
import { AdminLayout } from './layouts/AdminLayout';
import { UserLayout } from './layouts/UserLayout';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { ProfilePage } from './pages/ProfilePage';
import { RegisterPage } from './pages/RegisterPage';

// —— 方案 11：路由级懒加载 ——
// 重量级页面（后台管理、统计图表、报告详情/差异、审查列表/运行）按需分包，缩小首屏 bundle；
// 登录/注册/首页/个人中心保持急切加载以保证首屏即时渲染。
/* eslint-disable @typescript-eslint/naming-convention -- 懒加载组件须保留 PascalCase 供 JSX/路由使用 */
const AdminOverviewPage = lazy(() =>
  import('./pages/admin/AdminOverviewPage').then((m) => ({ default: m.AdminOverviewPage })),
);
const AdminUsersPage = lazy(() =>
  import('./pages/admin/AdminUsersPage').then((m) => ({ default: m.AdminUsersPage })),
);
const AdminRolesPage = lazy(() =>
  import('./pages/admin/AdminRolesPage').then((m) => ({ default: m.AdminRolesPage })),
);
const AdminConfigPage = lazy(() =>
  import('./pages/admin/AdminConfigPage').then((m) => ({ default: m.AdminConfigPage })),
);
const AdminRulesPage = lazy(() =>
  import('./pages/admin/AdminRulesPage').then((m) => ({ default: m.AdminRulesPage })),
);
const AdminLoginLogsPage = lazy(() =>
  import('./pages/admin/AdminLogsPage').then((m) => ({ default: m.AdminLoginLogsPage })),
);
const AdminOperationLogsPage = lazy(() =>
  import('./pages/admin/AdminLogsPage').then((m) => ({ default: m.AdminOperationLogsPage })),
);
const AdminAiConfigPage = lazy(() =>
  import('./pages/admin/AdminAiConfigPage').then((m) => ({ default: m.AdminAiConfigPage })),
);
const AdminToolsPage = lazy(() =>
  import('./pages/admin/AdminToolsPage').then((m) => ({ default: m.AdminToolsPage })),
);
const AdminInitPage = lazy(() =>
  import('./pages/admin/AdminInitPage').then((m) => ({ default: m.AdminInitPage })),
);
const AdminHookPage = lazy(() =>
  import('./pages/admin/AdminHookPage').then((m) => ({ default: m.AdminHookPage })),
);
const AdminMetricsPage = lazy(() =>
  import('./pages/admin/AdminMetricsPage').then((m) => ({ default: m.AdminMetricsPage })),
);
const AdminObservabilityPage = lazy(() =>
  import('./pages/admin/AdminObservabilityPage').then((m) => ({
    default: m.AdminObservabilityPage,
  })),
);
const AdminKnowledgePage = lazy(() =>
  import('./pages/admin/AdminKnowledgePage').then((m) => ({ default: m.AdminKnowledgePage })),
);
const ReportDetailView = lazy(() =>
  import('./views/ReportDetailView').then((m) => ({ default: m.ReportDetailView })),
);
const ReviewListView = lazy(() =>
  import('./views/ReviewListView').then((m) => ({ default: m.ReviewListView })),
);
const RunReviewView = lazy(() =>
  import('./views/RunReviewView').then((m) => ({ default: m.RunReviewView })),
);
const StatisticsView = lazy(() =>
  import('./views/StatisticsView').then((m) => ({ default: m.StatisticsView })),
);
/* eslint-enable @typescript-eslint/naming-convention */

type RouterContext = { queryClient: QueryClient };

/** 路由守卫共享逻辑：未登录 → 登录页（携带回跳地址） */
async function requireUser(context: RouterContext, href: string): Promise<User> {
  const user = await context.queryClient.fetchQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: fetchMe,
    staleTime: Infinity,
    retry: false,
  });
  if (user === null) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is implemented as a thrown control-flow value.
    throw redirect({ to: '/login', search: { redirect: href } });
  }
  return user;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: NotFound,
});

/** /login 与 /register 共用的回跳参数校验（仅字符串，缺省时不产出键以适配 exactOptionalPropertyTypes） */
const redirectSearch = (search: Record<string, unknown>): { redirect?: string } => {
  if (typeof search.redirect !== 'string') return {};
  return { redirect: search.redirect };
};

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: redirectSearch,
  component: LoginRoute,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  validateSearch: redirectSearch,
  component: RegisterRoute,
});

function LoginRoute(): ReactElement {
  const { redirect } = loginRoute.useSearch();
  return <LoginPage {...(redirect !== undefined ? { redirect } : {})} />;
}

function RegisterRoute(): ReactElement {
  const { redirect } = registerRoute.useSearch();
  return <RegisterPage {...(redirect !== undefined ? { redirect } : {})} />;
}

// —— 用户端（登录即可访问）。无路径布局路由：id 仅用于路由标识，不参与 URL 前缀 ——
const userRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: UserLayout,
  beforeLoad: async ({ context, location }) => {
    const user = await requireUser(context, location.href);
    // RBAC：无该路由权限时回首页；但若已在首页（兜底页），不再重定向以避免死循环
    if (location.pathname !== '/' && !canAccessPath(user.permissions, location.pathname)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is implemented as a thrown control-flow value.
      throw redirect({ to: '/' });
    }
  },
});

const homeRoute = createRoute({
  getParentRoute: () => userRoute,
  path: '/',
  component: HomePage,
});

const runRoute = createRoute({
  getParentRoute: () => userRoute,
  path: '/run',
  component: RunRoute,
});

function RunRoute(): ReactElement {
  const navigate = useNavigate();
  return (
    <RunReviewView
      onOpenReport={(reviewId) => {
        if (reviewId !== '') {
          void navigate({ to: '/reviews/$reviewId', params: { reviewId } });
        }
      }}
    />
  );
}

const reviewsRoute = createRoute({
  getParentRoute: () => userRoute,
  path: '/reviews',
  // 筛选与分页全部由 URL 承载：刷新 / 后退 / 分享链接可复现同一视图
  validateSearch: (search: Record<string, unknown>): ReviewSearch => parseReviewSearch(search),
  component: ReviewsRoute,
});

function ReviewsRoute(): ReactElement {
  const navigate = useNavigate();
  const search = reviewsRoute.useSearch();
  return (
    <ReviewListView
      search={search}
      onSearchChange={(next) =>
        void navigate({ to: '/reviews', search: serializeReviewSearch(next), replace: true })
      }
      onOpen={(reviewId) => void navigate({ to: '/reviews/$reviewId', params: { reviewId } })}
    />
  );
}

const reviewDetailRoute = createRoute({
  getParentRoute: () => userRoute,
  path: '/reviews/$reviewId',
  component: ReviewDetailRoute,
});

function ReviewDetailRoute(): ReactElement {
  const { reviewId } = reviewDetailRoute.useParams();
  const navigate = useNavigate();
  return <ReportDetailView reviewId={reviewId} onBack={() => void navigate({ to: '/reviews' })} />;
}

const statsRoute = createRoute({
  getParentRoute: () => userRoute,
  path: '/stats',
  component: StatisticsView,
});

const profileRoute = createRoute({
  getParentRoute: () => userRoute,
  path: '/profile',
  component: ProfilePage,
});

// —— 管理后台（仅 admin；非 admin 回用户端首页）——
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: AdminLayout,
  beforeLoad: async ({ context, location }) => {
    const user = await requireUser(context, location.href);
    // 具备任一管理权限（admin 角色 / '*' / 任一 /admin* 页面）即可进入管理后台
    if (!hasAdminAccess(user.permissions, user.role)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is implemented as a thrown control-flow value.
      throw redirect({ to: '/' });
    }
  },
});

const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  beforeLoad: async ({ context }) => {
    const user = await requireUser(context, '');
    // 无系统概览（/admin）权限时，落到第一个可访问的管理子页面
    if (!canAccessPath(user.permissions, '/admin')) {
      const first = firstPermittedAdminPath(user.permissions);
      if (first !== null) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is implemented as a thrown control-flow value.
        throw redirect({ to: first });
      }
    }
  },
  component: AdminOverviewPage,
});

const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/users',
  component: AdminUsersPage,
});

const adminRolesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/roles',
  component: AdminRolesPage,
});

const adminConfigRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/config',
  component: AdminConfigPage,
});

const adminRulesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/rules',
  component: AdminRulesPage,
});

const adminLoginLogsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/login-logs',
  component: AdminLoginLogsPage,
});

const adminOperationLogsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/operation-logs',
  component: AdminOperationLogsPage,
});

const adminAiConfigRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/ai',
  component: AdminAiConfigPage,
});

const adminToolsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/tools',
  component: AdminToolsPage,
});

const adminInitRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/init',
  component: AdminInitPage,
});

const adminHookRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/hook',
  component: AdminHookPage,
});

const adminMetricsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/metrics',
  component: AdminMetricsPage,
});

const adminObservabilityRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/observability',
  component: AdminObservabilityPage,
});

const adminKnowledgeRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/knowledge',
  component: AdminKnowledgePage,
});

function NotFound(): ReactElement {
  return <NotFoundPage />;
}

/** 路由级错误兜底：懒加载分包失败、beforeLoad 异常等统一呈现，避免白屏 */
function RouteErrorFallback({ error }: { error: unknown }): ReactElement {
  return <RouteErrorState error={error} />;
}

export const routeTree = rootRoute.addChildren([
  loginRoute,
  registerRoute,
  userRoute.addChildren([
    homeRoute,
    runRoute,
    reviewsRoute,
    reviewDetailRoute,
    statsRoute,
    profileRoute,
  ]),
  adminRoute.addChildren([
    adminIndexRoute,
    adminUsersRoute,
    adminRolesRoute,
    adminConfigRoute,
    adminRulesRoute,
    adminLoginLogsRoute,
    adminOperationLogsRoute,
    adminAiConfigRoute,
    adminToolsRoute,
    adminInitRoute,
    adminHookRoute,
    adminMetricsRoute,
    adminObservabilityRoute,
    adminKnowledgeRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPendingComponent: RouteLoading,
  defaultErrorComponent: RouteErrorFallback,
  defaultPreload: 'intent',
  scrollRestoration: true,
});

// 渲染期补上 queryClient（保持 createRouter 的类型签名简单）
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
