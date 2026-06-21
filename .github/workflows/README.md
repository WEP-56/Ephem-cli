# GitHub Actions 工作流

> Ephem 用两个工作流覆盖全流程：日常 CI 校验 + 统一发版。

## 工作流概览

| 工作流 | 文件 | 触发条件 | 作用 |
|--------|------|----------|------|
| CI | [`ci.yml`](./ci.yml) | push 到 main / 开 PR | 类型检查 + 构建 + Flutter 分析 |
| Release | [`release.yml`](./release.yml) | push tag `v*` / 手动 | 构建 APK + 发布 npm + 创建 GitHub Release |

---

## 日常 CI（每次提交自动跑）

`.github/workflows/ci.yml` 会在每次 push 到 main 或开 PR 时跑：

1. **CLI 构建校验**：`tsc --noEmit` + `tsup` 构建 + 验证 `--help` 能跑
2. **后端类型检查**：`tsc --noEmit`
3. **Flutter 分析**（不阻塞主线）：`flutter analyze`

---

## 发版流程（tag 驱动）

Ephem 采用 **tag 驱动发版**：推一个 `v*` 格式的 tag，会触发 `release.yml` 的三个 Job。

### 流程图

```
git push origin v0.1.0
        │
        ▼
   ┌─ release.yml ──────────────────────────────────┐
   │                                                 │
   │  ┌─ build-android ──┐  ┌─ build-npm ─────────┐ │
   │  │ Flutter build    │  │ npm ci + build      │ │
   │  │ 3 × APK          │  │ npm publish         │ │
   │  │ upload artifact  │  │ npm pack → .tgz     │ │
   │  └──────┬───────────┘  │ cp dist → .js       │ │
   │         │              │ upload artifact     │ │
   │         │              └────────┬────────────┘ │
   │         │                       │              │
   │         └─────────┬─────────────┘              │
   │                   ▼                            │
   │          ┌─ release ──────────────────┐        │
   │          │ download all artifacts     │        │
   │          │ create GitHub Release      │        │
   │          │ attach: 3 APK + tgz + js   │        │
   │          └────────────────────────────┘        │
   └─────────────────────────────────────────────────┘
```

### 最终 Release 包含

| 产物 | 说明 |
|------|------|
| `ephem-{ver}-arm64-v8a.apk` | Android 64 位 ARM（绝大多数手机） |
| `ephem-{ver}-armeabi-v7a.apk` | Android 32 位 ARM（旧手机） |
| `ephem-{ver}-x86_64.apk` | Android x86_64（模拟器） |
| `ephem-cli-{ver}.tgz` | npm 包 tarball，可离线 `npm i -g` 安装 |
| `ephem-cli-{ver}.js` | 单文件二进制，`node` 直接跑 |

---

### 第一步：检查版本号

```bash
# CLI（npm）—— package.json 里的 version 字段
grep '"version"' packages/cli/package.json

# Flutter —— pubspec.yaml 里的 version 字段
grep '^version:' packages/flutter_app/pubspec.yaml
```

两个版本号应保持一致（如都是 `0.1.0`）。如果不一致，手动改齐。

### 第二步：提交版本号（如果改了）

```bash
git add packages/cli/package.json packages/cli/package-lock.json packages/flutter_app/pubspec.yaml
git commit -m "chore: bump version to 0.1.0"
git push origin main
```

### 第三步：打 tag 并推送

```bash
git tag v0.1.0
git push origin v0.1.0
```

推送后去 **Actions 页面** 看进度：
`https://github.com/WEP-56/Ephem-cli/actions`

三个 Job 全绿后，Release 自动出现在：
`https://github.com/WEP-56/Ephem-cli/releases`

### 第四步：验证

- **npm**：`npm view ephem-cli version` 应显示新版本
- **Release**：Releases 页面应有 5 个文件可下载
- **APK**：装到手机/模拟器，能连上后端
- **CLI**：`npx ephem-cli --version` 或下载 `.js` 文件 `node ephem-cli-0.1.0.js --help`

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

**没有这个 secret，`build-npm` Job 会失败（403），Release 不会创建。**

---

## 手动触发

如果只想跑构建而不发版（比如测试 CI 是否能通过）：

1. 进入 Actions 页面
2. 左侧选择 "Release"
3. 右上角点 "Run workflow"
4. 选择 main 分支 → Run

注意：手动触发时不在 tag 上，`release` Job 会跳过（`if: startsWith(github.ref, 'refs/tags/')`），
只有 `build-android` 和 `build-npm` 会跑（但 npm 发布步骤仍会执行，注意不要重复发同一版本）。

---

## 工作流状态徽章

README.md 顶部已加：

```markdown
![CI](https://github.com/WEP-56/Ephem-cli/actions/workflows/ci.yml/badge.svg)
![Release](https://github.com/WEP-56/Ephem-cli/actions/workflows/release.yml/badge.svg)
```

---

## 常见问题

**Q: npm 发布报 403 Forbidden？**
A: 检查 `NPM_TOKEN` 是否配置正确、是否过期、账号是否开了 2FA（开了 2FA 则 token 必须是 Automation 类型）。

**Q: `build-npm` 成功了但 `release` 没创建？**
A: 检查 `build-android` 是否也成功了——`release` Job 依赖两者都通过。如果只是 Android 失败，修了重推新 tag。

**Q: 推 tag 后 Action 没触发？**
A: 确认 tag 格式是 `v*`（如 `v0.1.0`，不是 `0.1.0`）。检查 workflow 文件在 main 分支上。

**Q: 想撤销已发布的版本？**
A:
- npm：72 小时内 `npm unpublish ephem-cli@<版本>`，超时只能发新版本覆盖
- GitHub Release：Releases 页面 → 对应版本 → Delete
- tag：`git tag -d v0.1.0 && git push origin :refs/tags/v0.1.0`

**Q: npm 已发布但 Release 创建失败，能重跑吗？**
A: 能。删除远端 tag 后重新推送即可：
```bash
git push origin :refs/tags/v0.1.0   # 删远端 tag
git tag -d v0.1.0                   # 删本地 tag
git tag v0.1.0                      # 重新打（指向同一 commit）
git push origin v0.1.0              # 重新触发
```
npm 那边会报 "already exists" 但不阻塞（`npm publish` 失败会让 `build-npm` 失败，
如果需要跳过 npm 只重建 Release，可在 Actions 页面单独 re-run `release` Job——
前提是 artifacts 还在 30 天有效期内）。
