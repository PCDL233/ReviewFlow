import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, Typography } from 'antd';
import type { LoginInput } from '@ai-review/shared/api';
import { useAuth, useLogin } from '../hooks/use-auth';
import { getErrorMessage } from '../parse-response';
import { safeRedirectTarget } from '../lib/redirect';
import { AuthShell } from '../components/AuthShell';

export type LoginPageProps = { redirect?: string };

export function LoginPage(props: LoginPageProps): ReactElement {
  const { user } = useAuth();
  const navigate = useNavigate();
  const loginMutation = useLogin();
  const [formError, setFormError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (user !== null) {
      void navigate({ to: safeRedirectTarget(props.redirect), replace: true });
    }
  }, [user, navigate, props.redirect]);

  const handleFinish = async (values: LoginInput): Promise<void> => {
    setFormError(undefined);
    try {
      await loginMutation.mutateAsync(values);
      await navigate({ to: safeRedirectTarget(props.redirect), replace: true });
    } catch (error) {
      setFormError(getErrorMessage(error));
    }
  };

  return (
    <AuthShell
      mode="login"
      title="欢迎回来"
      subtitle="登录你的 ReviewFlow 工作区，继续查看团队代码质量。"
      error={
        formError === undefined ? undefined : (
          <Alert
            type="error"
            showIcon
            closable
            title="登录失败"
            description={formError}
            onClose={() => setFormError(undefined)}
          />
        )
      }
      footer={
        <Typography.Paragraph className="auth-switch">
          还没有账号？{' '}
          <Typography.Link
            onClick={() =>
              void navigate({
                to: '/register',
                search: props.redirect === undefined ? {} : { redirect: props.redirect },
              })
            }
          >
            创建新工作区
          </Typography.Link>
        </Typography.Paragraph>
      }
    >
      <Form<LoginInput>
        className="auth-form"
        layout="vertical"
        requiredMark={false}
        onFinish={(values) => void handleFinish(values)}
      >
        <Form.Item
          label="用户名"
          name="username"
          rules={[{ required: true, message: '请输入用户名' }]}
        >
          <Input
            size="large"
            autoFocus
            prefix={<UserOutlined />}
            placeholder="例如：zhangsan"
            autoComplete="username"
          />
        </Form.Item>
        <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password
            size="large"
            prefix={<LockOutlined />}
            placeholder="输入登录密码"
            autoComplete="current-password"
          />
        </Form.Item>
        <Button
          className="auth-submit"
          type="primary"
          size="large"
          htmlType="submit"
          block
          loading={loginMutation.isPending}
        >
          {loginMutation.isPending ? '正在登录…' : '登录'}
        </Button>
        <p className="auth-form-hint">登录状态会保留 7 天；退出登录后需重新验证密码。</p>
      </Form>
    </AuthShell>
  );
}
