# 真实站点测试用例（自己跑）

在 WebPilot 工作台（http://127.0.0.1:3000）里，把「目标 URL」和「任务」原样复制进去，点「运行 Agent」即可。
白名单需含 `todomvc.com,saucedemo.com,the-internet.herokuapp.com,parabank.parasoft.com`（`.env.local` 已配好）。

以下是 2026-10-24 实测过的全部用例，含实测成绩，可复跑对照。

## SauceDemo（电商，1 条）

### 1. 登录 → 加购 → 断言购物车

- **URL**：`https://www.saucedemo.com`
- **任务**：`用账号 standard_user 密码 secret_sauce 登录。登录后把商品 Sauce Labs Backpack 和 Sauce Labs Bike Light 加入购物车，打开购物车断言里面有 2 件商品。`
- **实测**：✅ 11 步 11.9s，断言 2/2。无任何选择器提示，第 2 步 `getSnapshot` 自己观察到 `#user-name` / `#login-button`。

## the-internet.herokuapp.com（9 条）

### 2. 表单登录

- **URL**：`https://the-internet.herokuapp.com/login`
- **任务**：`用账号 tomsmith 密码 SuperSecretPassword! 登录。登录成功后断言页面出现文本 Secure Area。`
- **实测**：✅ 6 步 8.8s，断言 1/1。

### 3. 动态加载（延迟 5 秒出结果——曾暴露断言不等待的缺陷，修复后通过）

- **URL**：`https://the-internet.herokuapp.com/dynamic_loading/2`
- **任务**：`点击 Start 按钮，等待加载完成后，断言页面上出现文本 Hello World!`
- **实测**：修复前 ❌ 11 步撞步数上限；修复后 ✅ 4 步 12.2s（assertText 静默等待约 5s）。

### 4. 添加 / 删除元素

- **URL**：`https://the-internet.herokuapp.com/add_remove_elements/`
- **任务**：`点击 Add Element 按钮 3 次，然后断言页面上有 3 个 Delete 按钮，最后把 3 个 Delete 按钮全部删掉并断言数量为 0。`
- **实测**：✅ 10 步 12.2s，断言 2/2；第二次跑开头打出「命中 1 条历史经验（相似度 1.00）」——RAG 记忆收益肉眼可见。
- **注意**：任务本身约需 15 步，`MAX_STEPS` 需 ≥20（`.env.local` 已是 20）。

### 5. 复选框互换

- **URL**：`https://the-internet.herokuapp.com/checkboxes`
- **任务**：`页面上有两个复选框。把未勾选的那个勾选上，把已勾选的那个取消勾选，最后断言两个复选框的勾选状态被互换了。`
- **实测**：✅ 7 步 6.7s，断言 3/3。模型自己把模糊要求翻译成 `#checkboxes input:nth-of-type(1):checked` 这样的 CSS 伪类断言。

### 6. 下拉框

- **URL**：`https://the-internet.herokuapp.com/dropdown`
- **任务**：`把页面上的下拉框选中 Option 2，然后断言当前选中项确实是 Option 2。`
- **实测**：✅ 4 步 6.1s，断言 1/1。

### 7. 键盘按键

- **URL**：`https://the-internet.herokuapp.com/key_presses`
- **任务**：`在输入框里按下 ESC 键，断言页面显示 You entered: ESC。`
- **实测**：✅ 5 步 7.0s，断言 1/1（页面实际显示 "You entered: ESCAPE"，`includes` 判定通过）。

### 8. 动态控件（启用/禁用，各带几秒服务端延迟）

- **URL**：`https://the-internet.herokuapp.com/dynamic_controls`
- **任务**：`点击 Remove 按钮移除复选框，断言出现提示 It's gone!；然后点击 Enable 按钮启用文本输入框，断言出现提示 It's enabled!。`
- **实测**：✅ 6 步 12.7s，断言 2/2，断言轮询扛住了两处延迟。

### 9. 空表单负向用例（注意：故意给的入口其实是 404）

- **URL**：`https://the-internet.herokuapp.com/login_form`（404 死链，Agent 会自己改航 `/login`）
- **任务**：`什么都不填，直接点击 Login 按钮提交，断言页面出现表单校验的错误提示。`
- **实测**：✅ 7 步 10.7s，断言 1/1。看点：读到 "Not Found" 后自行导航到正确页面继续完成任务——抗错恢复。

### 10. 悬停（工具层没有 hover，看它怎么解决）

- **URL**：`https://the-internet.herokuapp.com/hovers`
- **任务**：`把鼠标悬停在第二个头像图片上，断言页面上显示出 name: user2 的信息。`
- **实测**：✅ 5 步 7.5s，断言 1/1。Playwright 的 click 移动鼠标即触发 CSS :hover，figcaption 出现——「缺 hover 工具但被 click 隐式覆盖」。

## Parabank（银行 demo 站，1 条——结果特殊）

### 11. 银行转账

- **URL**：`https://parabank.parasoft.com/parabank/index.htm`
- **任务**：`用账号 john 密码 demo 登录。登录后转账：从默认账户转 50 元到账户 12345，转账完成后断言页面出现转账成功提示和金额 50。`
- **实测**：⚠️ 17 步 79.6s，转账页断言 2/2（`Transfer Complete! $50.00`），但最终 success=false——john 名下下拉框只有账户 13344，任务要求的 12345 不存在，Agent 改转 13344 后**如实报告「任务未按要求完成」**。这是「流程走通 ≠ 谎报成功」的正例，复跑结果应一致。

## 预期管理

- 外站偶发网络抖动导致单次失败，重跑一次即可。
- 首次跑某站点没有记忆、较慢；同任务第二跑会命中经验、明显变快（用例 4 专门验证这一点）。
- 本地对照用例（不依赖外网）见 `npm run verify` 的 8 条固定用例。
