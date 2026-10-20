import { useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Card, Form, Input, Tag, Typography, Upload } from 'antd';
import type { UploadProps } from 'antd';
import { AUTH_QUERY_KEY, useAuth, useChangePassword, useUploadAvatar } from '../hooks/use-auth';
import { useNotify } from '../hooks/use-notify';
import { getErrorStatus } from '../parse-response';
import { CardHeading, PageHeader } from '../components/PageHeader';
import { UserAvatar } from '../components/UserAvatar';

/** 头像上传的常规限制（与服务端一致）：位图格式，≤2MB */
const AVATAR_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** 头像上传失败按状态码映射为面向用户的可读文案（避免直出后端技术原文） */
const AVATAR_ERRORS: Record<number, string> = {
  400: '图片格式或内容不受支持，仅支持 jpg / png / webp / gif',
  413: '图片大小不能超过 2MB',
  503: '头像服务暂不可用，请稍后再试',
};

type ChangePasswordFormValues = {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
};

/** 个人设置：身份信息（含头像上传）与修改密码。 */
export function ProfilePage(): ReactElement {
  const { message } = AntdApp.useApp();
  const { notifyError } = useNotify();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const changePasswordMutation = useChangePassword();
  const uploadAvatarMutation = useUploadAvatar();
  const [form] = Form.useForm<ChangePasswordFormValues>();
  const [avatarError, setAvatarError] = useState<string | undefined>(undefined);

  /** 本地预校验（类型/大小）后交给 uploadAvatar mutation，避免真实上传才报错 */
  const beforeUpload: UploadProps['beforeUpload'] = (file) => {
    const allowed = AVATAR_EXTENSIONS[file.type ?? ''];
    if (allowed === undefined) {
      setAvatarError('仅支持 jpg / png / webp / gif 图片');
      return Upload.LIST_IGNORE;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError('图片大小不能超过 2MB');
      return Upload.LIST_IGNORE;
    }
    setAvatarError(undefined);
    // antd 的 RcFile 继承自 File，可直接作为上传体（保留原文件名便于服务端识别类型）
    void uploadAvatarMutation.mutateAsync(file).catch((e: unknown) => {
      const status = getErrorStatus(e);
      const reason =
        status !== undefined && AVATAR_ERRORS[status] !== undefined
          ? AVATAR_ERRORS[status]
          : '头像上传失败，请稍后再试';
      setAvatarError(reason);
      notifyError(reason, { title: '头像上传失败' });
    });
    return Upload.LIST_IGNORE;
  };

  const handleFinish = async (values: ChangePasswordFormValues): Promise<void> => {
    try {
      await changePasswordMutation.mutateAsync({
        oldPassword: values.oldPassword,
        newPassword: values.newPassword,
      });
      queryClient.setQueryData(AUTH_QUERY_KEY, null);
      void message.success('密码已修改，请使用新密码重新登录');
      void navigate({ to: '/login', replace: true });
    } catch (e) {
      notifyError(e, { title: '密码修改失败' });
    }
  };

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Workspace settings"
        title="个人设置"
        description="管理你的头像、工作区身份信息与登录凭据。"
      />
      <div className="profile-grid">
        <Card className="surface-card" title={<CardHeading title="身份信息" />}>
          <div className="profile-identity">
            <Upload accept={AVATAR_ACCEPT} showUploadList={false} beforeUpload={beforeUpload}>
              <span className="avatar-upload-wrap">
                <UserAvatar
                  user={user}
                  className="app-user-avatar"
                  style={{ width: 64, height: 64, borderRadius: 20, fontSize: 22 }}
                />
                <span className="avatar-upload-hint">
                  {uploadAvatarMutation.isPending ? '上传中…' : '更换'}
                </span>
                {uploadAvatarMutation.isPending ? (
                  <span className="avatar-upload-loading" aria-live="polite">
                    …
                  </span>
                ) : null}
              </span>
            </Upload>
            <div className="profile-identity-name">
              <Typography.Title level={4} className="profile-name">
                {user?.username ?? '当前用户'}
              </Typography.Title>
              <Tag color={user?.role === 'admin' ? 'gold' : 'blue'}>
                {user?.role === 'admin' ? '管理员' : '普通用户'}
              </Tag>
            </div>
          </div>
          {avatarError === undefined ? null : (
            <Alert
              className="profile-alert"
              type="warning"
              showIcon
              title={avatarError}
              closable
              onClose={() => setAvatarError(undefined)}
            />
          )}
          <dl className="profile-meta">
            <div>
              <dt>注册时间</dt>
              <dd>
                {user?.createdAt === undefined
                  ? '—'
                  : new Date(user.createdAt).toLocaleString('zh-CN')}
              </dd>
            </div>
            <div>
              <dt>最近登录</dt>
              <dd>
                {user?.lastLoginAt === undefined || user.lastLoginAt === null
                  ? '本次为首次登录'
                  : new Date(user.lastLoginAt).toLocaleString('zh-CN')}
              </dd>
            </div>
            <div>
              <dt>可访问页面</dt>
              <dd>
                {(user?.permissions ?? []).some((permission) => permission === '*')
                  ? '全部页面'
                  : `${user?.permissions.length ?? 0} 个`}
              </dd>
            </div>
            <div>
              <dt>账号 ID</dt>
              <dd className="numeric-cell">{user?.id ?? '—'}</dd>
            </div>
          </dl>
          <Typography.Paragraph type="secondary" className="config-help">
            头像支持 jpg / png / webp / gif，大小不超过 2MB；上传后会立即同步到全站导航。
          </Typography.Paragraph>
        </Card>
        <Card className="surface-card" title={<CardHeading title="修改密码" />}>
          <Alert
            className="profile-alert"
            type="info"
            showIcon
            title="修改密码会吊销所有已登录会话"
            description="保存后需要立即使用新密码重新登录。"
          />
          <Form<ChangePasswordFormValues>
            form={form}
            layout="vertical"
            onFinish={(values) => void handleFinish(values)}
          >
            <Form.Item
              label="当前密码"
              name="oldPassword"
              rules={[{ required: true, message: '请输入当前密码' }]}
            >
              <Input.Password
                size="large"
                placeholder="输入当前密码"
                autoComplete="current-password"
              />
            </Form.Item>
            <Form.Item
              label="新密码"
              name="newPassword"
              extra="至少 8 位，建议混合大小写字母、数字与符号。"
              rules={[
                { required: true, message: '请输入新密码' },
                { min: 8, message: '密码至少 8 位' },
              ]}
            >
              <Input.Password size="large" placeholder="至少 8 位" autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              label="确认新密码"
              name="confirmPassword"
              dependencies={['newPassword']}
              rules={[
                { required: true, message: '请再次输入新密码' },
                ({ getFieldValue }) => ({
                  validator(_, value: string | undefined) {
                    if (value === undefined || value === getFieldValue('newPassword')) {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error('两次输入的密码不一致'));
                  },
                }),
              ]}
            >
              <Input.Password
                size="large"
                placeholder="再次输入新密码"
                autoComplete="new-password"
              />
            </Form.Item>
            <Button
              className="profile-submit"
              type="primary"
              size="large"
              htmlType="submit"
              loading={changePasswordMutation.isPending}
            >
              保存新密码
            </Button>
          </Form>
        </Card>
      </div>
    </div>
  );
}
