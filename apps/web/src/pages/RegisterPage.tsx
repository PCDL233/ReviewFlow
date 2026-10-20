import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LockOutlined, SafetyCertificateOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, Typography } from 'antd';
import type { RegisterInput } from '@ai-review/shared/api';
import { useAuth, useRegister } from '../hooks/use-auth';
import { getErrorMessage } from '../parse-response';
import { safeRedirectTarget } from '../lib/redirect';
import { AuthShell } from '../components/AuthShell';

export type RegisterPageProps = { redirect?: string };
type RegisterFormValues = RegisterInput & { confirmPassword: string };

const STRENGTH_LABELS = ['较弱', '一般', '良好', '很强'] as const;

function passwordStrength(password: string): number {
  if (password === '') return 0;
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-zA-Z]/.test(password) && /\d/.test(password)) score += 1;
  if (/[^a-zA-Z0-9]/.test(password)) score += 1;
  return Math.min(score, 3);
}

export function RegisterPage(props: RegisterPageProps): ReactElement {
  const { user } = useAuth();
  const navigate = useNavigate();
  const registerMutation = useRegister();
  const [form] = Form.useForm<RegisterFormValues>();
  const password = Form.useWatch('password', form) ?? '';
  const strength = passwordStrength(password);
  const [formError, setFormError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (user !== null) {
      void navigate({ to: safeRedirectTarget(props.redirect), replace: true });
    }
  }, [user, navigate, props.redirect]);

  const handleFinish = async (values: RegisterFormValues): Promise<void> => {
    setFormError(undefined);
    try {
      await registerMutation.mutateAsync({
        username: values.username,
        password: values.password,
      });
      await navigate({ to: safeRedirectTarget(props.redirect), replace: true });
    } catch (error) {
      setFormError(getErrorMessage(error));
    }
  };

  return (
    <AuthShell
      mode="register"
      title="创建工作区"
      subtitle="注册一个账号，开始你的第一轮代码审查。首个账号会自动成为管理员。"
      error={
        formError === undefined ? undefined : (
          <Alert
            type="error"
            showIcon
            closable
            title="注册失败"
            description={formError}
            onClose={() => setFormError(undefined)}
          />
        )
      }
      footer={
        <Typography.Paragraph className="auth-switch">
          已有账号？{' '}
          <Typography.Link
            onClick={() =>
              void navigate({
                to: '/login',
                search: props.redirect === undefined ? {} : { redirect: props.redirect },
              })
            }
          >
            返回登录
          </Typography.Link>
        </Typography.Paragraph>
      }
    >
      <Form<RegisterFormValues>
        form={form}
        className="auth-form"
        layout="vertical"
        requiredMark={false}
        onFinish={(values) => void handleFinish(values)}
      >
        <Form.Item
          label="用户名"
          name="username"
          rules={[
            { required: true, message: '请输入用户名' },
            { pattern: /^[a-zA-Z0-9_-]{3,32}$/, message: '3–32 位字母、数字、下划线或连字符' },
          ]}
        >
          <Input
            size="large"
            autoFocus
            prefix={<UserOutlined />}
            placeholder="3–32 位字母、数字或符号"
            autoComplete="username"
          />
        </Form.Item>
        <Form.Item
          label="密码"
          name="password"
          rules={[
            { required: true, message: '请输入密码' },
            { min: 8, message: '密码至少 8 位' },
            { max: 128, message: '密码不能超过 128 位' },
          ]}
        >
          <Input.Password
            size="large"
            prefix={<LockOutlined />}
            placeholder="至少 8 位"
            autoComplete="new-password"
          />
        </Form.Item>
        <div className="auth-strength" aria-live="polite">
          <div className="auth-strength-bars" aria-hidden="true">
            {[0, 1, 2, 3].map((index) => (
              <span
                key={index}
                className={`auth-strength-bar${index < strength ? ' is-active' : ''}`}
              />
            ))}
          </div>
          <span className="auth-strength-label">
            {password === ''
              ? '建议混合大小写、数字与符号'
              : `密码强度：${STRENGTH_LABELS[strength]}`}
          </span>
        </div>
        <Form.Item
          label="确认密码"
          name="confirmPassword"
          dependencies={['password']}
          rules={[
            { required: true, message: '请再次输入密码' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (value === undefined || value === getFieldValue('password')) {
                  return Promise.resolve();
                }
                return Promise.reject(new Error('两次输入的密码不一致'));
              },
            }),
          ]}
        >
          <Input.Password
            size="large"
            prefix={<SafetyCertificateOutlined />}
            placeholder="再次输入密码"
            autoComplete="new-password"
          />
        </Form.Item>
        <Button
          className="auth-submit"
          type="primary"
          size="large"
          htmlType="submit"
          block
          loading={registerMutation.isPending}
        >
          {registerMutation.isPending ? '正在创建…' : '创建账号'}
        </Button>
        <p className="auth-form-hint">注册即表示你同意以最小权限原则管理团队成员的访问范围。</p>
      </Form>
    </AuthShell>
  );
}
