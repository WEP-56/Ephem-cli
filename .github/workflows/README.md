# GitHub Actions 工作流

> Ephem 用三个工作流分别处理：日常 CI 校验、NPM 发布、Android APK 打包。

## 工作流概览

| 工作流 | 文件 | 触发条件 | 作用 |
|--------|------|----------|------|
| CI | [`ci.yml`](./ci.yml) | push 到 main / 开 PR | 类型检查 + 构建 + 集成测试 |
| Release NPM | [`release-npm.yml`](./release-npm.yml) | push tag `v*` / 手动 | 发布 ephem-cli 到 npm |
| Release Android | [`release-android.yml`](./release-android.yml) | push tag `v*` / 手动 | 构建 APK 并附到 GitHub Release |

---

## 日常 CI（每次提交自动跑）

`.github/workflows/ci.yml` 会在每次 push 到 main 或开 PR 时跑：

1. **CLI 构建校验**：`tsc --noEmit` + `tsup` 构建 + 验证 `--help` 能跑
2. **后端类型检查**：`tsc --noEmit`
3. **端到端集成测试**：起 wrangler dev → 跑 `integration-test.mjs`（17 项断言）
4. **Flutter 分析**（不阻塞主线）：`flutter analyze`

---

## 发版流程

Ephem 采用 **tag 驱动发版**：推一个 `v*` 格式的 tag，会同时触发 npm 发布和 Android 打包。

### 第一步：准备发版

```bash
# 确保代码已合并到 main
git checkout main
git pull

# 检查版本号
cat packages/cli/package.json | grep version
cat packages/flutter_app/pubspec.yaml | grep version
```

### 第二步：升级版本号

```bash
# CLI（npm）
cd packages/cli
npm version patch    # 0.1.0 → 0.1.1
# 或 minor: 0.1.0 → 0.2.0
# 或 major: 0.1.0 → 1.0.0
cd ../..

# Flutter：手动改 pubspec.yaml 的 version 字段
# 比如 version: 0.1.0 → version: 0.1.1
```

提交版本号改动：

```bash
git add packages/cli/package.json packages/cli/package-lock.json packages/flutter_app/pubspec.yaml
git commit -m "chore: bump version to 0.1.1"
git push
```

### 第三步：打 tag 并推送

```bash
# tag 名必须以 v 开头
git tag v0.1.1
git push origin v0.1.1
```

推送 tag 后，**两个 Release 工作流会并行触发**：

- `release-npm.yml`：构建 CLI → 发布到 npm（带 provenance 来源证明）
- `release-android.yml`：Flutter build APK（arm64/armeabi-v7a/x86_64）→ 上传到 GitHub Release

### 第四步：等待 + 验证

去 GitHub 仓库的 **Actions** 页面查看进度。

完成后：

- **npm**：访问 https://www.npmjs.com/package/ephem-cli 确认新版本已上架
- **Android**：去仓库的 **Releases** 页面，能看到自动生成的 Release，附带 3 个 APK：
  - `ephem-0.1.1-arm64-v8a.apk`（现代手机）
  - `ephem-0.1.1-armeabi-v7a.apk`（老手机）
  - `ephem-0.1.1-x86_64.apk`（模拟器）

---

## 必需的 Secrets 配置

去仓库 **Settings → Secrets and variables → Actions** 添加：

### `NPM_TOKEN`

npm 发布所需的访问令牌：

1. 登录 [npmjs.com](https://www.npmjs.com)
2. 头像 → Access Tokens → Generate New Token
3. 类型选 **Classic Token**，权限选 **Automation**（或 Publish）
4. 复制 token（形如 `npm_xxxxxxxxxxxx`）
5. 在 GitHub Secrets 里新增 `NPM_TOKEN`，粘贴 token 值

**没有这个 secret，npm 发布会失败（403）。**

---

## 手动触发

如果只想跑某一个工作流而不打 tag：

1. 进入 Actions 页面
2. 左侧选择对应的工作流（如 "Release NPM"）
3. 右上角点 "Run workflow"
4. 选择 main 分支 → Run

注意：手动触发 `release-android.yml` 不会附到 Release（因为不在 tag 上），只会作为 artifact 供下载（30 天有效）。

---

## 工作流状态徽章

可以加到 README.md 顶部：

```markdown
![CI](https://github.com/WEP-56/Ephem-cli/actions/workflows/ci.yml/badge.svg)
![NPM](https://github.com/WEP-56/Ephem-cli/actions/workflows/release-npm.yml/badge.svg)
![Android](https://github.com/WEP-56/Ephem-cli/actions/workflows/release-android.yml/badge.svg)
```

---

## 常见问题

**Q: npm 发布报 403 Forbidden？**
A: 检查 `NPM_TOKEN` 是否配置正确，token 是否过期，账号是否启用了 2FA（如果开了 2FA，token 类型必须是 Automation）。

**Q: Android 构建报 Java 版本错？**
A: 工作流已固定 Java 17 + Flutter 3.10。如果本地跑不了，确认本地 Java 版本 ≥ 17。

**Q: 推 tag 后只有一个工作流跑了？**
A: 检查另一个工作流的 Actions 页面日志，通常是 secret 缺失或语法错误。

**Q: 想撤销已发布的版本？**
A:
- npm：72 小时内可以 `npm unpublish ephem-cli@<版本>`，超时只能发新版本覆盖
- GitHub Release：去 Releases 页面直接 Delete
- Android APK：同上
