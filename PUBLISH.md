# npm 发布指南

> 把 `ephem-cli` 发布到 npm，让全世界都能 `npm install -g ephem-cli` 一键安装。

## 前置条件

- 一个 [npm 账号](https://www.npmjs.com/signup)（免费）
- 本地已克隆本项目并完成构建
- 已登录 npm（见下方）

## 第一步：登录 npm

```bash
npm login
```

按提示输入：
1. **Username**：你的 npm 用户名
2. **Password**：密码
3. **Email**：邮箱（用于双因素认证）

成功后终端显示：

```
Logged in as <你的用户名> on https://registry.npmjs.org/.
```

> **首次发布新包需要验证邮箱！** 去 npm 注册邮箱里点确认链接，否则发布会报 403。

## 第二步：检查包信息

打开 `packages/cli/package.json`，确认关键字段正确：

```jsonc
{
  "name": "ephem-cli",           // ⚠ 全局唯一，不能和别人重复
  "version": "0.1.0",            // 首版建议 0.1.0
  "description": "临时、端到端加密的命令行聊天室",
  "bin": {
    "ephem": "./dist/index.js"   // 安装后的命令名
  },
  // ...
}
```

**重要检查项**：

| 字段 | 说明 |
|------|------|
| `name` | 必须全局唯一。先在 [npmjs.com](https://www.npmjs.com/search?q=ephem-cli) 搜一下确认没人用 |
| `version` | 遵循 [语义化版本](https://semver.org/lang/zh-CN/) |
| `bin` | 告诉 npm `ephem` 这个命令指向哪个文件 |
| `license` | 建议加 `"license": "MIT"` |

## 第三步：本地构建测试

```bash
cd packages/cli
npm install          # 确保依赖装好
npm run build        # tsup 打包 → 生成 dist/index.js

# 测试打包产物能否正常运行
node dist/index.js --help    # 应该看到 Usage 信息
```

确保 `dist/` 目录里有 `index.js`（单文件，带 shebang）。

## 第四步：试运行（dry run）

正式发布前先模拟一次，不会真正上传：

```bash
cd packages/cli
npm publish --dry-run
```

如果一切正常你会看到类似输出：

```
npm notice === Tarball Details ===
npm notice name:          ephem-cli
npm notice version:       0.1.0
npm notice package size:  XX kB
npm notice unpacked size: XX kB
npm notice files:         X
npm notice === Tarball Contents ===
...
```

如果报错，根据提示修复后再试。

## 第五步：正式发布！

```bash
cd packages/cli
npm publish --access public
```

`--access public` 表示这是一个公开包（任何人都能 install）。首次发布必须显式指定。

成功后你会看到：

```
+ ephem-cli@0.1.0
```

恭喜！你的包已经在 npm 上了 🎉

访问 https://www.npmjs.com/package/ephem-cli 就能看到。

## 第六步：验证安装

换一个目录或开一个新终端，测试从 npm 安装：

```bash
# 全局安装（推荐）
npm install -g ephem-cli

# 或者临时试用
npx ephem-cli

# 运行
ephem
# 应该看到 TUI 界面！
```

## 后续更新版本

改了代码后，发布新版本的流程：

### 1. 改版本号

三种方式任选其一：

```bash
# 方式一：手动改 package.json 的 version 字段
# 方式二：用 npm version 自动改（推荐）
cd packages/cli
npm version patch     # 0.1.0 → 0.1.1 （小修）
npm version minor     # 0.1.0 → 0.2.0 （新功能）
npm version major     # 0.1.0 → 1.0.0 （不兼容变更）

# 这会自动 git commit + tag
```

### 2. 重新构建 + 发布

```bash
cd packages/cli
npm run build
npm publish
```

就两步，非常简单。

## 版本管理最佳实践

```
0.1.0   → 首次公开版（MVP）
0.1.1   → 修复了 xxx bug
0.2.0   → 加了 xxx 功能（如房间码二维码）
1.0.0   → 正式版，API 稳定
```

规则：
- **patch** (第三位)：bug 修复，不影响功能
- **minor** (第二位)：新增功能，向后兼容
- **major** (第一位)：破坏性变更（如改了消息协议格式）

## 常见问题

**Q: 发布时提示 `403 Forbidden` 或 `402 Payment Required`？**
A: 这是 npm 的付费包策略导致的。确保用了 `--access public`。另外首次发布前必须**验证邮箱**（去注册邮箱里点链接）。

**Q: `package.json` 的 files 字段？**
A: 当前没有限制。如果你只想发布必要的文件（减小包体积），可以加：
```json
{
  "files": ["dist", "README.md", "LICENSE"]
}
```

**Q: 怎么撤回已发布的版本？**
A:
```bash
npm unpublish ephem-cli@<版本> --force
```
⚠ **72 小时内的版本才能撤回**，且 `--force` 只能用一次。尽量别依赖这个，发新版覆盖就好。

**Q: 包名被人占了？**
A: 在 package.json 里换个名字，比如 `@wep56/ephem-cli`（scoped package，免费且自动 public）。或者想个更独特的名字。

**Q: 怎么给包加 README？**
A: npm 会自动读取包根目录的 README.md。我们当前结构下 CLI 包没有独立 README——可以把项目根的 README 复制过去，或者在 `package.json` 里配置：
```json
"homepage": "https://github.com/WEP-56/Ephem-cli#readme",
"repository": { "type": "git", "url": "git+https://github.com/WEP-56/Ephem-cli.git" }
```
这样 npm 页面会跳转到 GitHub README。
